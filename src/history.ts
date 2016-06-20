import { ChatMessage } from "./packets";

export interface Record {
    message: ChatMessage;
    channel: string;
    id: string;
}

function matcher(predicate: any): (obj: any) => boolean {
    const keys = Object.keys(predicate);
    return function (match: any): boolean {
        for (let i = 0; i < keys.length; i++) {
            if (!match.hasOwnProperty(keys[i]) || match[keys[i]] !== predicate[keys[i]]) {
                return false;
            }
        }

        return true;
    };
}

/**
 * History stores a record of Beam messages sent and the corresponding
 * Discord messages so that deletes and purges can be mirrored.
 */
export class History {

    private history: Array<Record>;

    constructor(private cap: number = 1000) {
        this.history = [];
    }

    /**
     * Add inserts a new message into the history list.
     */
    add(message: ChatMessage, channel: string, id: string) {
        this.history.push({ message, channel, id });
        if (this.history.length > this.cap * 3 / 2) {
            this.history = this.history.slice(-this.cap);
        }
    }

    /**
     * purge deletes messages matching the object and returns the list of
     * messages in channels that were removed.
     */
    purge(channelID: number, match: any): Array<Record> {
        match.channel = channelID;

        const predicate = matcher(match);
        const removed = new Array<Record>();
        for (let i = 0; i < this.history.length; i++) {
            if (predicate(this.history[i].message)) {
                removed.push(this.history[i]);
                this.history.splice(i, 1);
                i--;
            }
        }

        return removed;
    }
}