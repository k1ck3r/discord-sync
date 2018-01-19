import { resolveChannelGroups, roles } from '@mcph/beam-common';
import * as cache from 'lru-cache';
import { Pool } from 'mysql';

import { IUser } from './packets';
import { sql } from './sql';

/**
 * A Matcher correlates a channel ID to a Discord channel ID (and vise versa),
 * and user IDs to Discord user IDs.
 */
export interface IMatcher {
    /**
     * Looks up the Discord channel associated with the Beam channel ID.
     */
    getDiscordChannel(channelID: number): Promise<string | null>;

    /**
     * Returns the Beam channel associated with the Discord channel ID.
     */
    getMixerChannel(discordID: string): Promise<number | null>;

    /**
     * getMixerUser returns a Mixer user associated with the Discord user. The
     * function is called with the Discord user's ID and the Beam channel ID
     * that they're chatting in.
     */
    getMixerUser(discordUserID: string, channelID: number): Promise<IUser | null>;

    /**
     * Purges the given Mixer user's roles cache, so that roles can be instantly
     * updated without naturally waiting for the next cache purge. If the channel
     * ID is not specified, roles will be purged from all channels.
     */
    purgeMixerUserRoles(userID: number, channelID?: number): void;

    /**
     * Removes a Discord chat link from a channel.
     */
    unlink(channelID: number): void;
}

interface ICachedUser {
    channelID: number;
    username: string;
    roles: { [channel: string]: string[] };
}

export class SQLMatcher implements IMatcher {
    // Cache to map Discord channel IDs to Mixer channel IDs.
    private discordToMixerChannelCache: cache.Cache<string, PromiseLike<number | null>>;

    // Cache to map Mixer channel IDs to Discord channel IDs.
    private mixerToDiscordChannelCache: cache.Cache<string, PromiseLike<string | null>>;

    // Cache to map Discord user IDs to Mixer user IDs.
    private discordToMixerUserCache: cache.Cache<string, PromiseLike<number | null>>;

    // Cache to temporarily hold Mixer user information such as username and roles.
    private mixerUserCache: cache.Cache<number, ICachedUser>;

    private interval: NodeJS.Timer;

    /**
     * Creates a new SQL-based matcher using the provided SQL client and the
     * given TTL for caching uses and channels.
     */
    constructor(cacheTTL: number = 60000) {
        this.discordToMixerChannelCache = cache({ maxAge: cacheTTL });
        this.mixerToDiscordChannelCache = cache({ maxAge: cacheTTL });
        this.discordToMixerUserCache = cache({ maxAge: cacheTTL });
        this.mixerUserCache = cache({ maxAge: cacheTTL });

        this.interval = setInterval(() => this.prune(), cacheTTL * 3 / 2);
    }

    /**
     * Close frees resources associated with the SQL matcher. It does not
     * close the underlying SQL pool.
     */
    public close(): void {
        clearInterval(this.interval);
    }

    public async getDiscordChannel(channelID: number): Promise<string | null> {
        const id = this.mixerToDiscordChannelCache.get(String(channelID));
        if (id !== undefined) {
            return id;
        }

        const promise = sql
            .queryAsync<{ id: string }[]>(
                `select liveChatChannel as id from discord_bot
                where channelId = ? and liveChatChannel is not null limit 1`,
                [channelID],
            )
            .then(data => data.length === 0 ? null : data[0].id);

        this.mixerToDiscordChannelCache.set(String(channelID), promise);
        return promise;
    }

    public async getMixerChannel(discordID: string): Promise<number | null> {
        const id = this.discordToMixerChannelCache.get(discordID);
        if (id !== undefined) {
            return id;
        }

        const promise = sql
            .queryAsync<{ id: number }[]>(
                `select channelId as id from discord_bot where liveChatChannel = ? limit 1`,
                [discordID],
            )
            .then(data => data.length === 0 ? null : data[0].id);

        this.discordToMixerChannelCache.set(discordID, promise);
        return promise;
    }

    public async getMixerUser(discordUserID: string, channelID: number): Promise<IUser | null> {
        const id = await this.getMixerUserID(discordUserID, channelID);
        if (!id) {
            return null;
        }

        const user = this.mixerUserCache.get(id);
        if (!user) {
            return null;
        }

        if (!user.roles.hasOwnProperty(channelID)) {
            user.roles[channelID] = await this.resolveRoles(id, user.channelID, channelID);
        }

        return {
            id,
            username: user.username,
            roles: user.roles[channelID],
        };
    }

    public purgeMixerUserRoles(userID: number, channelID?: number): void {
        const user = this.mixerUserCache.get(userID);
        if (!user) {
            return;
        }

        if (channelID) {
            delete user.roles[channelID];
        }

        user.roles = {};
    }

    public unlink(channelID: number): void {
        this.mixerToDiscordChannelCache.set(String(channelID), Promise.resolve(null));
        sql.query(`update discord_bot set liveChatChannel = NULL where channelId = ?`, [channelID]);
    }

    /**
     * Used to retrieve a Mixer user ID by a given Discord ID. If the user has not
     * been cached yet, basic user information will be fetched and cached.
     */
    private async getMixerUserID(discordUserID: string, channelID: number): Promise<number | null> {
        const id = this.discordToMixerUserCache.get(discordUserID);
        if (id !== undefined) {
            return id;
        }

        const promise = sql
            .queryAsync<{ userID: number; channelID: number; username: string }[]>(
                `select channel.userId as userID, channel.id as channelID, channel.token as username
                from external_oauth_grant, channel
                where serviceId = ? and service = "discord" and
                    channel.userId = external_oauth_grant.userId
                limit 1`,
                [discordUserID],
            )
            .then(data => {
                if (data.length === 0) {
                    return null;
                }

                const userID = data[0].userID;
                this.mixerUserCache.set(userID, {
                    channelID: data[0].channelID,
                    username: data[0].username,
                    roles: {},
                });

                return userID;
            });

        this.discordToMixerUserCache.set(discordUserID, promise);
        return promise;
    }

    /**
     * Cleans out expired items from the SQL caches.
     */
    private prune(): void {
        [
            this.discordToMixerChannelCache,
            this.mixerToDiscordChannelCache,
            this.discordToMixerUserCache,
            this.mixerUserCache,
        ].forEach(item => item.prune());
    }

    /**
     * Returns a list of roles that the user has when chatting in the
     * provided channel.
     */
    private async resolveRoles(
        userID: number,
        ownChannelID: number,
        channelID: number,
    ): Promise<string[]> {
        const { query, params } = resolveChannelGroups(userID, [channelID]);
        const result = (await sql.queryAsync<{ name: string }[]>(query, params)).map(r => r.name);

        if (ownChannelID === channelID) {
            result.unshift('Owner');
        }

        return roles.sort(result).map(r => r.name);
    }
}
