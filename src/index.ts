import * as Bluebird from 'bluebird';
import * as config from 'config';
import { Etcd3 } from 'etcd3';
import { Redis } from 'ioredis';
import * as request from 'request';
import { v1 as uuid } from 'uuid';
import * as Winston from 'winston';

import { ConnectionLock } from './connectionLock';
import { DiscordGatewayError, DiscordResponseError } from './errors';
import { History } from './history';
import { log } from './log';
import { IMatcher, SQLMatcher } from './matcher';
import { IChatMessage, IDiscordMessage } from './packets';
import { redis } from './redis';
import { replace } from './replaceWords';
import { Sharding } from './sharding';

// tslint:disable-next-line
const Discordie = require('discordie');
const requestPromise = Bluebird.promisify(request);

const etcd3 = new Etcd3({ hosts: config.get<string[]>('etcd3.hosts') });

class Sync {
    private history: History;
    private pubsub: Redis;
    private redis: Redis;
    private sharding: Sharding;
    private lock: ConnectionLock;
    private bot: any;
    private locking = false;

    constructor(private matcher: IMatcher) {
        this.history = new History();
        this.lock = new ConnectionLock(etcd3);
        this.pubsub = redis();
        this.redis = redis();
        this.lock.start();
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
                case 'deleteMessage':
                    this.purgeMessage(id, { id: data.id });
                    break;
                case 'DeleteMessage':
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
            if (!this.bot || this.bot.state === Discordie.States.CONNECTED) {
                this.createConnection();
            }
        });
        this.sharding.start();
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

        const lock = await this.lock.lock();
        const { shardId, shardCount } = this.sharding;
        this.connect(shardId, shardCount);

        this.locking = false;
    }

    /**
     * Connect bot to Discord and authenticate
     */
    public connect(shardId: number | null, shardCount: number | null): void {
        if (shardId === null) {
            return;
        }

        let options: { autoReconnect: boolean; shardId?: number; shardCount?: number } = {
            autoReconnect: true,
        };

        if (shardCount && shardCount > 1) {
            options = { ...options, shardId, shardCount };
        }

        log.info({ shardId, shardCount }, 'Connecting to Discord...');

        this.bot = new Discordie(options);
        this.bot.connect({ token: config.get('token') });

        this.bot.Dispatcher.on(Discordie.Events.GATEWAY_READY, () => this.onReady());

        this.bot.Dispatcher.on(Discordie.Events.MESSAGE_CREATE, (e: any) => {
            this.mirrorMessageFromDiscord(
                e.message.id,
                e.message.author.id,
                e.message.channel_id,
                e.message.content,
            ).catch(err => log.error(err));
        });

        this.bot.Dispatcher.on(Discordie.Events.DISCONNECTED, ({ error }: any) =>
            this.onDisconnected(error),
        );
    }

    /**
     * Executed when the bot has successfully authenticated with Discord's gateway.
     */
    private onReady(): void {
        log.debug('Connected to chat gateway.');

        // If the sharding info changed during connection, reconnect now, due to a Discordie issue.
        const { shardId, shardCount } = this.sharding;
        const options = this.bot.options;
        if ((options.shardId || 0) !== shardId || (options.shardCount || 1) !== shardCount) {
            this.createConnection();
        }
    }

    /**
     * Executed when the bot has disconnected from Discord's gateway.
     */
    private onDisconnected(error: Error & { exception: number }): void {
        // Discord refused our connection because the total shard count is too small.
        if (error.exception === DiscordGatewayError.InvalidSharding) {
            log.error(
                { shardCount: this.sharding.shardCount },
                'Each shard owns too many guilds. Refusing to reconnect until more shards are available.',
            );
            this.bot.autoReconnect.disable();
            return;
        }

        log.error({ error, code: error.exception }, 'Disconnected from Discord.');
    }

    /**
     * Disconnect the bot from the Discord gateway, if connected.
     */
    private disconnect(): void {
        log.info('Disconnected from Discord.');
        this.bot.disconnect();
        this.bot = null;
    }

    /**
     * Sends a request to the Discord API, authenticating as the bot user.
     */
    private request(options: request.OptionsWithUrl): Bluebird<request.RequestResponse> {
        options.headers = { authorization: `Bot ${config.get('token')}` };
        options.url = `https://discordapp.com/api/v6${options.url}`;
        return requestPromise(options);
    }

    /**
     * Handles an incoming chat message, posting it to Discord if possible.
     */
    private async sendMessageToDiscord(message: IChatMessage): Promise<void> {
        if (message.message.meta.discord) {
            return;
        }

        const id = await this.matcher.getDiscordChannel(message.channel);
        if (id === null) {
            return;
        }

        const body = replace(message.message.message.map(m => m.text || m.data).join(''));
        const res = await this.request({
            method: 'POST',
            url: `/channels/${id}/messages`,
            json: true,
            body: { content: `**<${message.user_name}>:** ${body}` },
        });

        if (res.statusCode === 404 && res.body.code === DiscordResponseError.UnknownChannel) {
            return this.matcher.unlink(message.channel);
        }

        switch (res.statusCode) {
            case 403:
                this.matcher.unlink(message.channel);
                break;
            case 200:
                this.history.add(message, id, res.body.id);
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
    private async mirrorMessageFromDiscord(
        messageID: string,
        discordUserID: string,
        discordChannelID: string,
        message: string,
    ): Promise<void> {
        const channelID = await this.matcher.getMixerChannel(discordChannelID);
        if (channelID === null) {
            return;
        }

        const user = await this.matcher.getMixerUser(discordUserID, channelID);
        if (user === null || user.roles.includes('Banned')) {
            return;
        }

        const ev: IChatMessage = {
            id: uuid(),
            channel: channelID,
            user_name: user.username,
            user_id: user.id,
            user_roles: user.roles,
            message: {
                meta: { discord: true },
                message: [{ type: 'text', data: message, text: message }],
            },
        };

        this.history.add(ev, discordChannelID, messageID);
        this.redis.publish(`chat:${channelID}:ChatMessage`, JSON.stringify(ev));
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

        let res: request.RequestResponse;
        if (messages.length === 1) {
            res = await this.request({
                url: `/channels/${messages[0].channel}/messages/${messages[0].id}`,
                method: 'DELETE',
                json: true,
            });
        } else {
            const channelId = messages[messages.length - 1].channel;
            res = await this.request({
                url: `/channels/${channelId}/messages/bulk-delete`,
                method: 'POST',
                json: {
                    messages: messages.slice(-100).map(({ id }) => id),
                },
            });
        }

        if (res.statusCode !== 204) {
            log.error(
                { statusCode: res.statusCode, body: res.body, messages: messages.length },
                'Unexpected response from Discord when purging messages.',
            );
        }
    }
}

function start(): void {
    new Sync(new SQLMatcher()).start();
}

if (require.main === module) {
    start();
}
