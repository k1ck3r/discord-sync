import { User } from "./packets";
import { IPool } from "mysql";
import * as cache from "lru-cache";

const common = require('@mcph/beam-common');

/**
 * A Matcher correlates a channel ID to a Discord channel ID (and vise versa),
 * and user IDs to Discord user IDs.
 */
export interface Matcher {

    /**
     * Looks up the Discord channel associated with the Beam channel ID.
     */
    getDiscordChannel(channelID: number, callback: (err: Error, discordID?: string) => void): void;

    /**
     * Returns the Beam channel associated with the Discord channel ID.
     */
    getBeamChannel(discordID: string, callback: (err: Error, channelID?: number) => void): void;

    /**
     * GetBeamUser returns a Beam user associated with the Discord user. The
     * function is called with the Discord user's ID and the Beam channel ID
     * that they're chatting in.
     */
    getBeamUser(discordUserID: string, channelID: number, callback: (err: Error, user?: User) => void): void;

    /**
     * Removes a Discord chat link from a channel.
     */
    unlink(channelID: number): void;
}

interface Pruneable { prune(): void; }

export class SQLMatcher implements Matcher {

    private discordToBeamCache: cache.Cache<number>;
    private beamToDiscordCache: cache.Cache<string>;
    private userCache: cache.Cache<User>;
    private interval: NodeJS.Timer;

    /**
     * Creates a new SQL-based matcher using the provided SQL client and the
     * given TTL for caching uses and channels.
     */
    constructor(private sql: IPool, cacheTTL: number = 60000) {
        this.discordToBeamCache = cache<number>({ maxAge: cacheTTL });
        this.beamToDiscordCache = cache<string>({ maxAge: cacheTTL });
        this.userCache = cache<User>({ maxAge: cacheTTL });

        this.interval = setInterval(() => this.prune(), cacheTTL * 3 / 2);
    }

    /**
     * Cleans out expired items from the SQL caches.
     */
    private prune() {
        [
            this.discordToBeamCache,
            this.beamToDiscordCache,
            this.userCache,
        ].forEach((cache: Object) => (<Pruneable>cache).prune());
    }

    /**
     * Close frees resources associated with the SQL matcher. It does not
     * close the underlying SQL pool.
     */
    close() {
        clearInterval(this.interval);
    }

    getDiscordChannel(channelID: number, callback: (err: Error, discordID?: string) => void): void {
        const id = this.beamToDiscordCache.get(String(channelID));
        if (id !== undefined) {
            return callback(undefined, id);
        }

        this.sql.query(
            `select liveChatChannel as id from discord_bot
            where channelId = ? and liveChatChannel is not null limit 1`,
            [channelID],
            (err: Error, data: Array<{id: string}>) => {
                if (err) {
                    return callback(err);
                }

                const discordID = data.length === 0 ? null : data[0].id;
                this.beamToDiscordCache.set(String(channelID), discordID);
                return callback(undefined, discordID);
            }
        );
    }

    getBeamChannel(discordID: string, callback: (err: Error, channelID?: number) => void): void {
        const id = this.discordToBeamCache.get(discordID);
        if (id !== undefined) {
            return callback(undefined, id);
        }

        this.sql.query(
            `select channelId as id from discord_bot where liveChatChannel = ? limit 1`,
            [discordID],
            (err: Error, data: Array<{id: number}>) => {
                if (err) {
                    return callback(err);
                }

                const channelID = data.length === 0 ? null : data[0].id;
                this.discordToBeamCache.set(discordID, channelID);
                return callback(undefined, channelID);
            }
        );
    }

    /**
     * Returns a list of roles that the user has when chatting in the
     * provided channel.
     */
    private resolveRoles(userID: number, ownChannelID: number, channelID: number,
            callback: (err: Error, roles?: Array<String>) => void): void {
        if (ownChannelID === channelID) {
            return callback(undefined, ['Owner']);
        }

        this.sql.query(`
            select group.name from \`group\`, (
                select group_users as id from group_users__user_groups where user_groups = ?
                union
                select \`group\` as id from permission_grant where resourceType = "channel" and resourceId = ?
            ) as t where t.id = group.id;`,
            [userID, channelID],
            (err: Error, data: Array<{name: string}>) => {
                if (err) return callback(err);

                const roles = common.roles.sort(data.map(d => d.name));
                callback(undefined, roles.map((r: {name: string}) => r.name));
            }
        );
    }

    getBeamUser(discordUserID: string, channelID: number, callback: (err: Error, user?: User) => void): void {
        const id = this.userCache.get(discordUserID);
        if (id !== undefined) {
            return callback(undefined, id);
        }

        this.sql.query(
            `select channel.userId as userID, channel.id as channelID, channel.token as username
            from external_oauth_grant, channel
            where serviceId = ? and service = "discord" and
                channel.userId = external_oauth_grant.userId
            limit 1`,
            [discordUserID],
            (err: Error, data: Array<{userID: number, channelID: number, username: string}>) => {
                if (err) return callback(err);

                if (data.length === 0) {
                    this.userCache.set(discordUserID, null);
                    return callback(undefined, null);
                }

                this.resolveRoles(data[0].userID, data[0].channelID, channelID, (err: Error, roles: Array<string>) => {
                    if (err) return callback(err);

                    const user: User = {
                        roles,
                        id: data[0].userID,
                        username: data[0].username,
                    };

                    this.userCache.set(discordUserID, user);
                    callback(undefined, user);
                });
            }
        );
    }

    unlink(channelID: number) {
        this.beamToDiscordCache.set(String(channelID), null);
        this.sql.query(`update discord_bot set liveChatChannel = NULL where channelId = ?`, [channelID]);
    }
}