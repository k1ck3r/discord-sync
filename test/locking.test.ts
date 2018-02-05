import { expect } from 'chai';
import * as config from 'config';
import { Etcd3, EtcdLockFailedError, Lock, Namespace, Watcher } from 'etcd3';
import { restore, SinonFakeTimers, spy, stub, useFakeTimers } from 'sinon';

import { ConnectionLock } from '../src/connectionLock';

// tslint:disable no-unused-expression

describe('locking', () => {
    let etcd: Etcd3;
    let nsp: Namespace;
    let lock: ConnectionLock;
    let clock: SinonFakeTimers;
    let watcher: Watcher;

    before(async () => {
        etcd = new Etcd3({ hosts: config.get<string[]>('etcd3.hosts') });
        nsp = etcd.namespace(`${config.get<string>('etcd3.namespace')}/locks/`);
        watcher = await nsp
            .watch()
            .key('connection')
            .create();
    });

    beforeEach(() => {
        lock = new ConnectionLock(etcd);
        lock.start();
        clock = useFakeTimers();
    });

    afterEach(async () => {
        clock.restore();
        await nsp
            .delete()
            .key('connection')
            .exec();
    });

    it('acquires the lock', async () => {
        await lock.lock();
        expect(await nsp.get('connection').string()).to.not.be.null;
    });

    it('releases the lock', async () => {
        await lock.lock();
        clock.tick(6000);
        await new Promise(resolve => {
            watcher.once('delete', () => resolve());
        });
    });

    it('retries if unable to lock', async () => {
        const acquire = stub(Lock.prototype, 'acquire')
            .onFirstCall()
            .rejects(new EtcdLockFailedError());
        const backoff = stub(lock, 'backoff').resolves();
        await lock.lock();
        backoff.restore();
    });
});
