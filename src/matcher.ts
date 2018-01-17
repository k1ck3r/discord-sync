import { roles } from '@mcph/beam-common';
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
    getBeamChannel(discordID: string): Promise<number | null>;

    /**
     * GetBeamUser returns a Beam user associated with the Discord user. The
     * function is called with the Discord user's ID and the Beam channel ID
     * that they're chatting in.
     */
    getBeamUser(discordUserID: string, channelID: number): Promise<IUser | null>;

    /**
     * Removes a Discord chat link from a channel.
     */
    unlink(channelID: number): void;
}

interface IPruneable {
    prune(): void;
}

export class SQLMatcher implements IMatcher {
    private discordToBeamCache: cache.Cache<string, number | null>;
    private beamToDiscordCache: cache.Cache<string, string | null>;
    private userCache: cache.Cache<string, IUser | null>;
    private interval: NodeJS.Timer;

    /**
     * Creates a new SQL-based matcher using the provided SQL client and the
     * given TTL for caching uses and channels.
     */
    constructor(cacheTTL: number = 60000) {
        this.discordToBeamCache = cache({ maxAge: cacheTTL });
        this.beamToDiscordCache = cache({ maxAge: cacheTTL });
        this.userCache = cache({ maxAge: cacheTTL });

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
        const id = this.beamToDiscordCache.get(String(channelID));
        if (id !== undefined) {
            return id;
        }

        const data = await sql.queryAsync<{ id: string }[]>(
            `select liveChatChannel as id from discord_bot
            where channelId = ? and liveChatChannel is not null limit 1`,
            [channelID],
        );

        const discordID = data.length === 0 ? null : data[0].id;
        this.beamToDiscordCache.set(String(channelID), discordID);
        return discordID;
    }

    public async getBeamChannel(discordID: string): Promise<number | null> {
        const id = this.discordToBeamCache.get(discordID);
        if (id !== undefined) {
            return id;
        }

        const data = await sql.queryAsync<{ id: number }[]>(
            `select channelId as id from discord_bot where liveChatChannel = ? limit 1`,
            [discordID],
        );

        const channelID = data.length === 0 ? null : data[0].id;
        this.discordToBeamCache.set(discordID, channelID);
        return channelID;
    }

    public async getBeamUser(discordUserID: string, channelID: number): Promise<IUser | null> {
        const id = this.userCache.get(discordUserID);
        if (id !== undefined) {
            return id;
        }

        const data = await sql.queryAsync<
            { userID: number; channelID: number; username: string }[]
        >(
            `select channel.userId as userID, channel.id as channelID, channel.token as username
            from external_oauth_grant, channel
            where serviceId = ? and service = "discord" and
                channel.userId = external_oauth_grant.userId
            limit 1`,
            [discordUserID],
        );

        if (data.length === 0) {
            this.userCache.set(discordUserID, null);
            return null;
        }

        const resolvedRoles = await this.resolveRoles(data[0].userID, data[0].channelID, channelID);
        const user: IUser = {
            roles: resolvedRoles,
            id: data[0].userID,
            username: data[0].username,
        };

        this.userCache.set(discordUserID, user);
        return user;
    }

    public unlink(channelID: number): void {
        this.beamToDiscordCache.set(String(channelID), null);
        sql.query(`update discord_bot set liveChatChannel = NULL where channelId = ?`, [channelID]);
    }

    /**
     * Cleans out expired items from the SQL caches.
     */
    private prune(): void {
        [this.discordToBeamCache, this.beamToDiscordCache, this.userCache].forEach((item: Object) =>
            (<IPruneable>item).prune(),
        );
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
        if (ownChannelID === channelID) {
            return ['Owner'];
        }

        const data = await sql.queryAsync<{ name: string }[]>(
            `select group.name from \`group\`, (
                select group_users as id from group_users__user_groups where user_groups = ?
                union
                select \`group\` as id from permission_grant where
                    resourceType = "channel" and resourceId = ? and user = ?
            ) as t where t.id = group.id;`,
            [userID, channelID, userID],
        );

        return roles.sort(data.map(d => d.name)).map((r: { name: string }) => r.name);
    }
}
