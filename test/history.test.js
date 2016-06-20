'use strict';

const History = require('../lib/history').History;

describe('history', () => {

    it('adds and trims messages', () => {
        const history = new History(2);
        expect(history.history).to.have.length(0);
        history.add({}, 'a', 'b');
        expect(history.history).to.have.length(1);
        expect(history.history).to.containSubset([{ channel: 'a', id: 'b' }]);
        history.add({}, 'c', 'd');
        history.add({}, 'e', 'f');
        history.add({}, 'g', 'h');
        expect(history.history).to.have.length(2);
        expect(history.history).to.containSubset([
            { channel: 'e', id: 'f' },
            { channel: 'g', id: 'h' },
        ]);
    });

    it('should purge messages', () => {
        const history = new History();
        history.add({ channel: 1, foo: 'bar' }, 'a', 'a');
        history.add({ channel: 2, foo: 'bar' }, 'a', 'b');
        history.add({ channel: 1, foo: 'bin' }, 'a', 'c');
        history.add({ channel: 1, foo: 'bar' }, 'a', 'd');
        expect(history.purge(1, { foo: 'bar' }).map(m => m.id)).to.deep.equal(['a', 'd']);
        expect(history.history.map(m => m.id)).to.deep.equal(['b', 'c']);
    });
});