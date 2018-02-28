import { expect } from 'chai';
import { Message } from 'discord.js';
import { stub } from 'sinon';

import { History } from '../src/history';
import { IChatMessage } from '../src/packets';

describe('history', () => {
    const mixerMessage = {
        channel: 1,
        id: '1',
        user_name: null,
        user_roles: [],
        user_id: 1,
        user_avatar: null,
        message: {
            message: [],
            meta: { discord: true },
        },
    };

    const discordMessage = <any>{};

    it('adds and trims messages', () => {
        const history = new History(2);
        expect(history.history).to.have.length(0);
        history.add(mixerMessage, discordMessage);
        expect(history.history).to.have.length(1);
        expect(history.history[0]).to.have.keys('discordMessage', 'mixerMessage');

        history.add({ ...mixerMessage, id: 'c' }, discordMessage);
        history.add({ ...mixerMessage, id: 'e' }, discordMessage);
        history.add({ ...mixerMessage, id: 'g' }, discordMessage);
        expect(history.history).to.have.length(2);
        expect(history.history).to.containSubset([
            { mixerMessage: { id: 'e' } },
            { mixerMessage: { id: 'g' } },
        ]);
    });

    it('should purge messages', () => {
        const history = new History();
        history.add({ ...mixerMessage, channel: 1, user_id: 1, id: 'a' }, discordMessage);
        history.add({ ...mixerMessage, channel: 2, user_id: 1, id: 'b' }, discordMessage);
        history.add({ ...mixerMessage, channel: 1, user_id: 2, id: 'c' }, discordMessage);
        history.add({ ...mixerMessage, channel: 1, user_id: 1, id: 'd' }, discordMessage);
        expect(history.purge(1, { user_id: 1 }).map(m => m.mixerMessage.id)).to.deep.equal([
            'a',
            'd',
        ]);
        expect(history.history.map(m => m.mixerMessage.id)).to.deep.equal(['b', 'c']);
    });
});
