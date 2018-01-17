import { expect } from 'chai';

import { History } from '../src/history';
import { IChatMessage } from '../src/packets';

describe('history', () => {
    const message: IChatMessage = {
        channel: 1,
        id: '1',
        user_name: null,
        user_roles: [],
        user_id: 1,
        message: {
            message: [],
            meta: { discord: true },
        },
    };

    it('adds and trims messages', () => {
        const history = new History(2);
        expect(history.history).to.have.length(0);
        history.add(message, 'a', 'b');
        expect(history.history).to.have.length(1);
        expect(history.history).to.containSubset([{ channel: 'a', id: 'b' }]);
        history.add(message, 'c', 'd');
        history.add(message, 'e', 'f');
        history.add(message, 'g', 'h');
        expect(history.history).to.have.length(2);
        expect(history.history).to.containSubset([
            { channel: 'e', id: 'f' },
            { channel: 'g', id: 'h' },
        ]);
    });

    it('should purge messages', () => {
        const history = new History();
        history.add({ ...message, channel: 1, user_id: 1 }, 'a', 'a');
        history.add({ ...message, channel: 2, user_id: 1 }, 'a', 'b');
        history.add({ ...message, channel: 1, user_id: 2 }, 'a', 'c');
        history.add({ ...message, channel: 1, user_id: 1 }, 'a', 'd');
        expect(history.purge(1, { user_id: 1 }).map(m => m.id)).to.deep.equal(['a', 'd']);
        expect(history.history.map(m => m.id)).to.deep.equal(['b', 'c']);
    });
});
