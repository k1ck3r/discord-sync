import * as Bluebird from 'bluebird';
import * as config from 'config';
import { Client, ClientOptions, Message, RichEmbed, TextChannel } from 'discord.js';
import { Etcd3 } from 'etcd3';
import { Redis } from 'ioredis';
import * as request from 'request';
import { v1 as uuid } from 'uuid';

import { ConnectionLock } from './connectionLock';
import { DiscordGatewayOp, DiscordGatewayStatus, DiscordResponseError } from './errors';
import { History } from './history';
import { log } from './log';
import { IMatcher, SQLMatcher } from './matcher';
import { IChatMessage } from './packets';
import * as prometheus from './prometheus';
import { redis } from './redis';
import { RetryHandler } from './retryHandler';
import { Sharding } from './sharding';

const requestPromise = Bluebird.promisify(request);

const etcd3 = new Etcd3({ hosts: config.get<string[]>('etcd3.hosts') });

class Sync {
    private pubsub = redis();
    private redis = redis();
    private history = new History();
    private lock = new ConnectionLock(etcd3);
    private retries = new RetryHandler();

    private sharding: Sharding;
    private bot: Client | null;
    private locking = false;

    constructor(private matcher: IMatcher) {
        this.lock.start();
        prometheus.start();
    }

    /**
     * Start sets up listeners watching Redis and Discord itself.
     */
    public start(): void {
        this.pubsub.psubscribe(
            'chat:*:ChatMessage',
            'chat:*:DeleteMessage',
            'chat:*:UserTimeout',
            'chatcompat:*:deleteMessage',
            'chat:*:PurgeMessage',
            'chat:*:UserRoleChange',
        );

        this.pubsub.on('pmessage', (pattern: string, channel: string, message: string) => {
            const parts = channel.split(':');
            const id = parseInt(parts[1], 10);
            const data = JSON.parse(message);

            switch (parts[2]) {
                case 'ChatMessage':
                    if (this.sharding.shardId === 0) {
                        this.sendMessageToDiscord(data).catch(err => log.error(err));
                    }
                    break;
                case 'PurgeMessage':
                    this.purgeMessage(id, { user_id: data.user_id });
                    break;
                case 'DeleteMessage':
                case 'deleteMessage':
                    this.purgeMessage(id, { id: data.id });
                    break;
                case 'UserTimeout':
                    this.purgeMessage(id, { user_id: data.user });
                    break;
                case 'UserRoleChange':
                    this.matcher.purgeMixerUserRoles(
                        data.userId,
                        parts[1] === '*' ? undefined : id,
                    );
                    break;
            }
        });

        this.sharding = new Sharding(etcd3, () => {
            if (!this.bot || this.bot.status === DiscordGatewayStatus.Ready) {
                this.createConnection();
            }

            const { shardCount } = this.sharding;
            if (shardCount) {
                prometheus.shardCount.set(shardCount);
            }
        });

        this.sharding.start();
        process.once('SIGTERM', async () => {
            await this.sharding.stop();
            process.exit();
        });
    }

    /**
     * Closes any existing bot connection, and connects to Discord once a connection
     * lock is acquired.
     */
    public async createConnection(): Promise<void> {
        if (this.bot) {
            this.disconnect();
        }

        if (this.locking) {
            return;
        }

        log.debug('Waiting for lock...');
        this.locking = true;
        this.retries.reset();

        await this.lock.create();
        const { shardId, shardCount } = this.sharding;
        this.connect(shardId, shardCount);
        this.locking = false;
    }

    /**
     * Connect bot to Discord and authenticate
     */
    private connect(shardId: number | null, shardCount: number | null): void {
        if (shardId === null || shardCount === null) {
            return;
        }

        log.info({ shardId, shardCount }, 'Connecting to Discord...');
        prometheus.connectionAttempts.inc();

        this.bot = new Client({ shardId, shardCount, disableEveryone: true });
        this.bot.login(config.get('token'));

        this.bot.on('ready', () => this.onReady());
        this.bot.on('reconnecting', () => this.onDisconnected());
        this.bot.on('message', message => this.mirrorMessageFromDiscord(message));
        this.bot.on('error', err => log.error(err));
    }

    /**
     * Executed when the bot has successfully authenticated with Discord's gateway.
     */
    private onReady(): void {
        log.debug('Connected to chat gateway.');
        prometheus.activeConnections.set(1);
        this.lock.renew();

        // If the sharding info changed during connection, reconnect now, due to a Discordie issue.
        const { shardId, shardCount } = this.sharding;
        const options = this.bot!.options;
        if ((options.shardId || 0) !== shardId || (options.shardCount || 1) !== shardCount) {
            this.createConnection();
        }

        // Listen for invalid session errors for debugging purposes.
        (<any>this.bot).ws.connection.ws.on('message', (message: string | Buffer) => {
            if (typeof message === 'string') {
                const { op, d }: { op: number; d: boolean } = JSON.parse(message);
                if (op === DiscordGatewayOp.InvalidSession) {
                    log.warn({ canResume: !!d }, 'Discord gateway rejected the session.');
                    prometheus.authenticationFailures.inc();
                }
            }
        });
    }

    /**
     * Executed when the bot has disconnected from Discord's gateway.
     */
    private onDisconnected(error?: Error & { exception: number }): void {
        if (this.bot) {
            this.bot.destroy();
        }

        log.error({ error }, 'Disconnected from Discord.');
        prometheus.disconnections.inc();
        prometheus.activeConnections.set(0);
        this.retries.retry(() => this.createConnection());
    }

    /**
     * Disconnect the bot from the Discord gateway, if connected.
     */
    private disconnect(): void {
        log.info('Disconnecting from Discord...');
        prometheus.activeConnections.set(0);

        if (this.bot) {
            this.bot.destroy();
        }

        this.bot = null;
        this.retries.reset();
    }

    /**
     * Handles an incoming chat message, posting it to Discord if possible.
     */
    private async sendMessageToDiscord(mixerMessage: IChatMessage): Promise<void> {
        if (
            !this.bot ||
            mixerMessage.recipientFilter ||
            mixerMessage.message.filterId ||
            mixerMessage.message.meta.discord
        ) {
            return;
        }

        prometheus.messagesFromMixer.inc();

        if (!config.get('chatRelay.mixerToDiscord')) {
            return;
        }

        const id = await this.matcher.getDiscordChannel(mixerMessage.channel);
        if (id === null) {
            return;
        }

        // todo(ethan): we're evaluating how Discord's rate limits impact this feature;
        // forming a manual HTTP query rather than using discord.js for now, to ensure
        // we are not retrying 429s.
        const body = mixerMessage.message.message.map(m => m.text || m.data).join('');
        const res = await requestPromise({
            url: `https://discordapp.com/api/v6/channels/${id}/messages`,
            method: 'post',
            json: true,
            headers: { authorization: `Bot ${config.get('token')}` },
            body: { content: `**<${mixerMessage.user_name}>:** ${body}` },
        });

        if (res.statusCode === 404 && res.body.code === DiscordResponseError.UnknownChannel) {
            return this.matcher.unlink(mixerMessage.channel);
        }

        switch (res.statusCode) {
            case 403:
                this.matcher.unlink(mixerMessage.channel);
                break;
            case 200:
                const channel = this.bot.channels.get(id);
                if (channel) {
                    this.history.add(
                        mixerMessage,
                        new Message(<TextChannel>channel, res.body, this.bot),
                    );
                }
                break;
            default:
                log.error(
                    { statusCode: res.statusCode, body: res.body },
                    'Unexpected response from Discord when sending message',
                );
        }
    }

    /**
     * Dispatches a message from Discord into a Beam chat channel.
     */
    private async mirrorMessageFromDiscord(discordMessage: Message): Promise<void> {
        const channelID = await this.matcher.getMixerChannel(discordMessage.channel.id);
        if (channelID === null) {
            return;
        }

        prometheus.messagesFromDiscord.inc();

        if (!config.get('chatRelay.discordToMixer')) {
            return;
        }

        const user = await this.matcher.getMixerUser(discordMessage.author.id, channelID);
        if (user === null || user.roles.includes('Banned')) {
            return;
        }

        const mixerMessage: IChatMessage = {
            id: uuid(),
            channel: channelID,
            user_name: user.username,
            user_id: user.id,
            user_roles: user.roles,
            user_avatar: null,
            message: {
                meta: { discord: true },
                message: [
                    { type: 'text', data: discordMessage.content, text: discordMessage.content },
                ],
            },
        };

        this.history.add(mixerMessage, discordMessage);
        this.redis.publish(`chat:${channelID}:ChatMessage`, JSON.stringify(mixerMessage));
    }

    /**
     * Deletes a message matching a pattern from Discord channels.
     */
    private async purgeMessage(channel: number, pattern: {}): Promise<void> {
        log.debug({ channel, pattern }, 'Purging messages...');
        const messages = this.history.purge(channel, pattern);

        if (!messages.length) {
            return;
        }

        const textChannel = messages[messages.length - 1].discordMessage.channel;
        textChannel.bulkDelete(messages.map(message => message.discordMessage));
    }
}

function start(): void {
    new Sync(new SQLMatcher()).start();
}

if (require.main === module) {
    start();
}
