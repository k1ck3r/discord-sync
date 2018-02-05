import * as config from 'config';
import { Etcd3, EtcdLockFailedError, Lease, Lock, Namespace, Watcher } from 'etcd3';

export class ConnectionLock {
    private nsp: Namespace;
    private watcher: Promise<Watcher>;
    private delay = 6;

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
    public async lock(): Promise<void> {
        try {
            const lock = await this.acquireLock();
            setTimeout(() => lock.release(), this.delay * 1000);
        } catch (err) {
            if (!(err instanceof EtcdLockFailedError)) {
                throw err;
            }

            await this.backoff();
            await this.lock();
        }
    }

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
