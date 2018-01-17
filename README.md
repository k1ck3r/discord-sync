discord-sync
============

The Discord integration on Mixer is made up of the following components.

* `discord-sync` (this service) is responsible for synchronizing chat between Mixer channels and Discord
* the backend's `sync-discord` command runs on a cron to sync roles
* the backend synchronizes partner emotes when the emotes are uploaded or the setting is turned on
* `stream-stats` is responsible for sending a message to Discord if the stream goes live

`discord-sync` listens to Redis for chat events (sent by the chat server), and then uses Discord settings loaded from MySQL to forward those actions to the appropriate Discord channels. Additionally, if `discord-sync` receives a message, this message will be relayed to Mixer if the sender has a Discord account linked.

Setup
-----
* create a Discord OAuth app from [this page](https://discordapp.com/developers/applications/me)
* generate a bot token for your Discord app
* copy `config/default.yaml` and update the config accordingly
* run `npm install`, `npm run build`, `npm run start`

Sharding
--------
When discord-sync connects to etcd3, it will discover other instances of discord-sync and shard guilds across multiple Discord chat gateways. Therefore, if multiple instances of discord-sync run, each server will handle messages for a fraction of the guilds. This impacts the bot's online status (visible in Discord's user list), and the bot's Discord to Mixer relay. Whichever server claims shard zero will be responsible for relaying Mixer chat to Discord.
