import * as config from 'config';
import { Etcd3, EtcdLockFailedError, Lease, Lock, Namespace, Watcher } from 'etcd3';

export class ConnectionLock {
    private nsp: Namespace;
    private watcher: Promise<Watcher>;
    private delay = 6;
    private lock: Lock | null = null;
    private timeout: NodeJS.Timer;

    constructor(private client: Etcd3) {
        this.nsp = client.namespace(`${config.get<string>('etcd3.namespace')}/locks/`);
    }

    /**
     * Starts watcher lock.
     */
    public start(): void {
        this.watcher = this.nsp
            .watch()
            .key('connection')
            .create();
    }

    /**
     * Waits until the lock can be acquired. Once it can, calls the callback provided
     * and holds the lock until Discord's rate limit clears.
     */
    public async create(): Promise<void> {
        try {
            this.lock = await this.acquireLock();
            this.renew();
        } catch (err) {
            if (!(err instanceof EtcdLockFailedError)) {
                throw err;
            }

            await this.backoff();
            await this.create();
        }
    }

    /**
     * If a lock has been acquired already, updates the TTL to a new value.
     */
    public renew(): void {
        clearTimeout(this.timeout);
        this.timeout = setTimeout(() => {
            if (this.lock) {
                this.lock.release();
            }
            this.lock = null;
        }, this.delay * 1000);
    }

    /**
     * If the lock could not be acquired, promise resolves when we can retry.
     */
    public async backoff(): Promise<void> {
        const watcher = await this.watcher;
        await Promise.race([
            new Promise(resolve => {
                setTimeout(() => resolve(), this.delay * 1000 * 2);
            }),
            new Promise(resolve => {
                watcher.once('delete', () => resolve());
            }),
        ]);
    }

    private async acquireLock(): Promise<Lock> {
        return this.nsp
            .lock('connection')
            .ttl(this.delay)
            .acquire();
    }
}
