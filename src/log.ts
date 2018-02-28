import { RavenStream } from '@mcph/bunyan-raven';
import * as Logger from 'bunyan';
import * as config from 'config';
import { Client } from 'raven';

// tslint:disable-next-line
const PrettyStream = require('bunyan-prettystream');

function getStreams(): Logger.Stream[] {
    const streams: Logger.Stream[] = [];

    const prettyStream = new PrettyStream();
    prettyStream.pipe(process.stdout);
    streams.push({ stream: prettyStream });

    const dsn = config.get<string>('sentry.dsn');
    if (dsn) {
        streams.push({
            type: 'raw',
            stream: new RavenStream(new Client(dsn)),
            level: 'warn',
        });
    }

    return streams;
}

export const log = Logger.createLogger({
    name: 'discord-sync',
    streams: getStreams(),
    level: 'debug',
});

process.on('uncaughtException', err => log.error(err));
process.on('unhandledRejection', err => log.error(err));
