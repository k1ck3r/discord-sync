import * as config from 'config';
import { Etcd3, Lease, Namespace } from 'etcd3';
import { log } from './log';

/**
 * When connecting to Discord, the chat gateway accepts sharding information to split
 * guilds between servers, including:
 * - the shard ID of the current server
 * - the total number of shards that exist
 *
 * Sharding uses etcd3 to dynamically determine these two values by discovering other
 * servers. If a shard is brought up or taken down, all remaining shards will reconnect
 * to Discord with the new sharding information.
 *
 * This only affects the handling of incoming Discord messages, and the Discord bot's
 * online status. Outgoing messages are always sent by shard zero.
 */
export class Sharding {
    public shardId: number | null = null;
    public shardCount: number | null = null;

    private nsp: Namespace;
    private lease: Lease;
    private delayedSync: NodeJS.Timer;

    constructor(
        private client: Etcd3,
        private doConnect: (shardId: number | null, shardCount: number | null) => void,
    ) {
        this.nsp = client.namespace(`${config.get<string>('etcd3.namespace')}/shards/`);
    }

    /**
     * Starts synchronizing shard information with etcd.
     */
    public async start(): Promise<void> {
        this.nsp
            .watch()
            .prefix('')
            .create()
            .then(watcher => {
                watcher.on('put', () => this.syncShards());
                watcher.on('delete', () => this.syncShardsAfter(15000));
            });

        return this.createLease();
    }

    /**
     * Creates etcd lease, and attempts to re-establish the lease if it is lost.
     * Once a lease is successfully granted, the shards are synchronized, and if
     * the lease is lost, Discord will disconnect.
     */
    public async createLease(): Promise<void> {
        this.lease = this.client.lease(5);
        this.lease.once('lost', () => {
            log.warn('Lease lost! Attempting to re-establish...');
            this.update(null, null);
            this.createLease();
        });

        await this.lease.grant();
        log.debug('Lease granted. Synchronizing shards...');
        return this.syncShards();
    }

    /**
     * Fetches shards from etcd3, and attempts to claim a new shard ID if either it
     * does not yet have one or its shard ID now exceeds the number of shards.
     */
    public async syncShards(): Promise<void> {
        log.debug('Synchronizing shards...');
        clearTimeout(this.delayedSync);

        const shards = await this.getAllShards();
        let total = shards.length;
        if (this.shardId === null) {
            total++;
        }

        if (this.shardId === null || this.shardId >= total) {
            for (let i = 0; i < total; i++) {
                if (!shards.includes(i)) {
                    await this.setShard(i, total);
                    return;
                }
            }
        }

        this.update(this.shardId, total);
    }

    /**
     * Sync shards after a given delay.
     */
    public async syncShardsAfter(delay: number): Promise<void> {
        clearTimeout(this.delayedSync);
        this.delayedSync = setTimeout(() => this.syncShards(), delay);
    }

    /**
     * Revokes the lease.
     */
    public stop(): void {
        this.lease.revoke();
    }

    /**
     * Claims a shard ID and removes the old shard ID's key, if there is one.
     */
    private async setShard(shardId: number, shardCount: number): Promise<void> {
        const key = String(shardId);
        const lease = await this.lease.grant();
        const { succeeded } = await this.nsp
            .if(key, 'Create', '==', 0)
            .then(
                this.nsp
                    .put(key)
                    .value('')
                    .lease(lease),
            )
            .commit();

        if (!succeeded) {
            return this.syncShards();
        }

        if (this.shardId !== null) {
            const prevKey = String(this.shardId);
            this.nsp
                .if(prevKey, 'Lease', '==', lease)
                .then(this.nsp.delete().key(prevKey))
                .commit();
        }

        this.update(shardId, shardCount);
    }

    /**
     * Gets an array of active existing shard IDs.
     */
    private async getAllShards(): Promise<number[]> {
        const keys = await this.nsp.getAll().keys();
        return keys.map(Number);
    }

    /**
     * If the sharding info has changed, reconnects Discord.
     */
    private update(shardId: number | null, shardCount: number | null): void {
        if (this.shardId === shardId && this.shardCount === shardCount) {
            return;
        }

        log.debug({ shardId, shardCount }, 'Sharding info has changed.');
        this.shardId = shardId;
        this.shardCount = shardCount;
        this.doConnect(shardId, shardCount);
    }
}
