import { Message } from 'discord.js';

import { IChatMessage } from './packets';

export interface IRecord {
    mixerMessage: IChatMessage;
    discordMessage: Message;
}

/**
 * History stores a record of Beam messages sent and the corresponding
 * Discord messages so that deletes and purges can be mirrored.
 */
export class History {
    public history: IRecord[];

    constructor(private cap: number = 1000) {
        this.history = [];
    }

    /**
     * Add inserts a new message into the history list.
     */
    public add(mixerMessage: IChatMessage, discordMessage: Message): void {
        this.history.push({ mixerMessage, discordMessage });
        if (this.history.length > this.cap * 3 / 2) {
            this.history = this.history.slice(-this.cap);
        }
    }

    /**
     * purge deletes messages matching the object and returns the list of
     * messages in channels that were removed.
     */
    public purge(channelID: number, match: Partial<IChatMessage>): IRecord[] {
        match.channel = channelID;

        const predicate = this.match(match);
        const removed: IRecord[] = [];
        for (let i = 0; i < this.history.length; i++) {
            if (predicate(this.history[i].mixerMessage)) {
                removed.push(this.history[i]);
                this.history.splice(i, 1);
                i--;
            }
        }

        return removed;
    }

    private match(predicate: Partial<IChatMessage>): (obj: IChatMessage) => boolean {
        const keys = Object.keys(predicate);
        return (match: IChatMessage) =>
            !keys.some(
                (key: keyof IChatMessage) =>
                    !match.hasOwnProperty(key) || match[key] !== predicate[key],
            );
    }
}
