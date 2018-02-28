export enum DiscordGatewayOp {
    InvalidSession = 9,
}

export enum DiscordResponseError {
    UnknownChannel = 10003,
}

export enum DiscordGatewayStatus {
    Ready = 0,
    Connecting = 1,
    Reconnecting = 2,
    Idle = 3,
    Nearly = 4,
    Disconnected = 5,
}
