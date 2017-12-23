import * as Bluebird from 'bluebird';
import * as config from 'config';
import { Redis } from 'ioredis';
import * as request from 'request';
import { v1 as uuid } from 'uuid';
import * as Winston from 'winston';

import { History } from './history';
import { log } from './log';
import { IMatcher, SQLMatcher } from './matcher';
import { IChatMessage, IDiscordMessage } from './packets';
import { redis } from './redis';
import { replace } from './replaceWords';

// tslint:disable-next-line
const Discordie = require('discordie');
const requestPromise = Bluebird.promisify(request);

class Sync {

    private history: History;
    private pubsub: Redis;
    private redis: Redis;

    constructor(
        private matcher: IMatcher,
        private bot: any,
    ) {
        this.history = new History();
        this.pubsub = redis();
        this.redis = redis();
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
        );

        this.pubsub.on('pmessage', (pattern: string, channel: string, message: string) => {
            const parts = channel.split(':');
            const id = parseInt(parts[1], 10);
            const data = JSON.parse(message);

            switch (parts[2]) {
                case 'ChatMessage': this.sendMessageToDiscord(data).catch(err => log.error(err)); break;
                case 'PurgeMessage': this.purgeMessage(id, data); break;
                case 'deleteMessage': this.purgeMessage(id, { id: data.id }); break;
                case 'DeleteMessage': this.purgeMessage(id, { id: data.id }); break;
                case 'UserTimeout': this.purgeMessage(id, { user_id: data.user }); break;
            }
        });

        this.bot.connect({ token: config.get('token') });

        this.bot.Dispatcher.on(Discordie.Events.GATEWAY_READY, () => {
            log.debug('Connected to Discord\'s gateway...');
        });

        this.bot.Dispatcher.on(Discordie.Events.MESSAGE_CREATE, (e: any) => {
            this.mirrorMessageFromDiscord(
                e.message.id,
                e.message.author.id,
                e.message.channel_id,
                e.message.content,
            ).catch(err => log.error(err));
        });

        this.bot.Dispatcher.on(Discordie.Events.DISCONNECTED, ({ error }: any) => {
            log.error({ error, code: error.exception }, 'Disconnected from Discord.');
        });
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

        switch (res.statusCode) {
            case 403: this.matcher.unlink(message.channel); break;
            case 200: this.history.add(message, id, res.body.id); break;
            default: log.error({ statusCode: res.statusCode }, 'Unexpected response from Discord when sending message');
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
        const channelID = await this.matcher.getBeamChannel(discordChannelID);
        if (channelID === null) {
            return;
        }

        const user = await this.matcher.getBeamUser(discordUserID, channelID);
        if (user === null) {
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

        this.history.add(ev, discordChannelID, discordUserID);
        this.redis.publish(`chat:${channelID}:ChatMessage`, JSON.stringify(ev));
    }

    /**
     * Deletes a message matching a pattern from Discord channels.
     */
    private purgeMessage(channel: number, pattern: {}): void {
        log.debug({ channel, pattern }, 'Purging messages...');
        this.history.purge(channel, pattern).forEach(r => {
            this.request({
                url: `/channels/${r.channel}/messages/${r.id}`,
                method: 'DELETE',
            });
        });
    }
}

function start(): void {
    const bot = new Discordie({
        autoReconnect: true,
    });

    new Sync(new SQLMatcher(), bot).start();
}

if (require.main === module) {
    start();
}
