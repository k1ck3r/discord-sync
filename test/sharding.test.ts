import { expect } from 'chai';
import * as config from 'config';
import { Etcd3, Lease, Namespace } from 'etcd3';
import { SinonSpy, spy } from 'sinon';

import { Sharding } from '../src/sharding';

describe('sharding', () => {
    let sharding: Sharding;
    let etcd: Etcd3;
    let nsp: Namespace;
    let lease: Lease;
    let grant: string;
    let doConnect: SinonSpy;

    before(() => {
        etcd = new Etcd3({ hosts: config.get<string[]>('etcd3.hosts') });
        nsp = etcd.namespace(config.get<string>('etcd3.namespace'));
    });

    beforeEach(async() => {
        doConnect = spy();
        lease = etcd.lease(5);
        grant = await lease.grant();
        sharding = new Sharding(etcd, doConnect);
    });

    afterEach(async() => {
        etcd.unmock();
        sharding.stop();
        await lease.revoke();
    });

    it('assigns shard id', async() => {
        await sharding.start();
        expect(doConnect).to.have.been.calledWith(0, 1);
        expect(doConnect.withArgs(0, 1).calledOnce).to.equal(true);
    });

    it('updates total when new server available', async() => {
        await sharding.start();
        await nsp.put('1').lease(grant).exec();
        await sharding.syncShards();
        expect(doConnect).to.have.been.calledTwice.and.calledWith(0, 2);
    });

    it('does not reconnect with no changes', async() => {
        await sharding.start();
        await sharding.syncShards();
        expect(doConnect).to.have.been.calledOnce.and.calledWith(0, 1);
    });

    it('retries if unsuccessfully claimed shard', async() => {
        await nsp.put('0').lease(grant).exec();
        etcd.mock({
            exec(service, method, value) {
                etcd.unmock();
                return Promise.resolve({ kvs: [] });
            },
        });
        await sharding.createLease();
        expect(doConnect).to.have.been.calledOnce.and.calledWith(1, 2);
        nsp.delete().key('1');
    });

    it('releases old shard when switching', async() => {
        await nsp.put('0').lease(grant).exec();
        await sharding.start();
        await nsp.delete().key('0').exec();
        await sharding.syncShards();
        expect(doConnect).to.have.been.calledWith(0, 1);
        expect(await nsp.get('1')).to.equal(null);
    });
});
