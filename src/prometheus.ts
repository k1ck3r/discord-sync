import * as config from 'config';
import { createServer } from 'http';
import { Counter, register } from 'prom-client';

export function start() {
    createServer((req, res) => {
        if (req.url !== '/metrics') {
            res.writeHead(404);
            res.end('Not found.');
            return;
        }
        res.end(register.metrics());
    }).listen(config.get('prometheus.port'));
}

export const connectionAttempts = new Counter({
    name: 'discord_connection_attempts',
    help: 'Discord gateway connection attempts',
});

export const authenticationFailures = new Counter({
    name: 'discord_authentication_failures',
    help: 'Discord gateway authentication failures',
});

export const disconnections = new Counter({
    name: 'discord_disconnections',
    help: 'Discord gateway disconnections',
});

export const messagesFromDiscord = new Counter({
    name: 'discord_messages_from_discord',
    help: 'Discord messages relayed from Discord to Mixer',
    labelNames: ['channelID'],
});

export const messagesFromMixer = new Counter({
    name: 'discord_messages_from_mixer',
    help: 'Discord messages relayed from Mixer to Discord',
    labelNames: ['channelID'],
});
