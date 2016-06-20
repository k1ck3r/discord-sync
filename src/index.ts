import { ChatMessage } from "./packets";
import { Matcher, SQLMatcher } from "./matcher";
import { DiscordMessage } from "./packets";
import { History } from "./history";
import redis from "./redis";

import * as Winston from "winston";
import * as redisPkg from "redis";
import * as config from "config";
import * as request from "request";
import * as mysql from "mysql";
import * as uuid from "node-uuid";

const Discordie = require("discordie");

class Sync {

    private history: History;
    private pubsub: redisPkg.RedisClient;
    private redis: redisPkg.RedisClient;

    constructor(private matcher: Matcher,
        private bot: any,
        private log: Winston.LoggerInstance) {

        this.history = new History();
        this.pubsub = redis();
        this.redis = redis();
    }

    /**
     * Sends a request to the Discord API, authenticating as the bot user.
     */
    private request(options: request.OptionsWithUrl, callback: request.RequestCallback) {
        options.headers = { authorization: "Bot " + config.get("token") };
        options.url = "https://discordapp.com/api" + options.url;
        request(options, callback);
    }

    /**
     * Handles an incoming chat message, posting it to Discord if possible.
     */
    private sendMessageToDiscord(message: ChatMessage) {
        if (message.message.meta.discord) {
            return;
        }

        this.matcher.getDiscordChannel(message.channel, (err, ID) => {
            if (err) return this.log.error("Error getting Discord channel", err);
            if (ID === null) return;

            const body = message.message.message.map(m => m.text || m.data).join("");

            this.request({
                method: "POST",
                url: "/channels/" + ID + "/messages",
                json: true,
                body: { content: `**<${message.user_name}>:** ${body}` },
            }, (err, res, body) => {
                switch (res.statusCode) {
                case 403: this.matcher.unlink(message.channel); break;
                case 200: this.history.add(message, ID, body.id); break;
                default: this.log.warn("Unexpected response from Discord", err, res);
                }
            });
        });
    }

    /**
     * Dispatches a message from Discord into a Beam chat channel.
     */
    private mirrorMessageFromDiscord(messageID: string, discordUserID: string,
            discordChannelID: string, message: string) {

        this.matcher.getBeamChannel(discordChannelID, (err, channelID) => {
            if (err) return this.log.error("Error getting Beam channel", err);
            if (channelID === null) return;

            this.matcher.getBeamUser(discordUserID, channelID, (err, user) => {
                if (err) return this.log.error("Error getting Beam user", err);
                if (user === null) return;

                const ev: ChatMessage = {
                    id: uuid.v1(),
                    channel: channelID,
                    user_name: user.username,
                    user_id: user.id,
                    user_roles: user.roles,
                    message: {
                        meta: { discord: true },
                        message: [{ type: "text", data: message, text: message }],
                    },
                };

                this.history.add(ev, discordChannelID, discordUserID);
                this.redis.publish("chat:" + channelID + ":ChatMessage", JSON.stringify(ev));
            });
        });
    }

    /**
     * Deletes a message matching a pattern from Discord channels.
     */
    private purgeMessage(channel: number, pattern: any) {
        console.log(channel, pattern);
        this.history.purge(channel, pattern).forEach(r => {
            this.request({
                url: "/channels/" + r.channel + "/messages/" + r.id,
                method: "DELETE",
            }, () => {});
        });
    }

    /**
     * Start sets up listeners watching Redis and Discord itself.
     */
    start() {
        this.pubsub.psubscribe(
            "chat:*:ChatMessage",
            "chat:*:DeleteMessage",
            "chat:*:UserTimeout",
            "chatcompat:*:deleteMessage",
            "chat:*:PurgeMessage"
        );

        this.pubsub.on("pmessage", (pattern: string, channel: string, message: string) => {
            const parts = channel.split(":");
            const id = parseInt(parts[1], 10);
            const data = JSON.parse(message);

            switch (parts[2]) {
            case "ChatMessage": this.sendMessageToDiscord(data); break;
            case "PurgeMessage": this.purgeMessage(id, data); break;
            case "deleteMessage": this.purgeMessage(id, { id: data.id }); break;
            case "DeleteMessage": this.purgeMessage(id, { id: data.id }); break;
            case "UserTimeout": this.purgeMessage(id, { user_id: data.user }); break;
            }
        });

        this.bot.connect({
            autoReconnect: true,
            token: config.get("token"),
        });

        this.bot.Dispatcher.on(Discordie.Events.GATEWAY_READY, () => {
            this.log.debug("Connected to Discord's gateway...");
        });

        this.bot.Dispatcher.on(Discordie.Events.MESSAGE_CREATE, (e: any) => {
            this.mirrorMessageFromDiscord(
                e.message.id,
                e.message.author.id,
                e.message.channel_id,
                e.message.content
            );
        });
    }
}

function start() {
    const bot = new Discordie();
    const log = new Winston.Logger({
        transports: [new Winston.transports.Console()],
    });
    const sql = mysql.createPool(config.get("mysql"));

    new Sync(new SQLMatcher(sql), bot, log).start();
}

if (require.main === module) {
    start();
}