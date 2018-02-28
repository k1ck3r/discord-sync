/**
 * User contains user information to put into a chat message.
 */
export interface IUser {
    id: number;
    username: string;
    roles: string[];
}

/**
 * A ChatMessage is sent to and from the websocket.
 */
export interface IChatMessage {
    channel: number;
    id: string;
    user_name: string;
    user_roles: string[];
    user_id: number;
    user_avatar: string | null;
    message: {
        message: IMessageComponent[];
        meta: { discord: boolean };
    };
}

export interface IMessageComponent {
    type: string;
    data: string;
    text: string;
}

export interface IDiscordMessage {
    id: string;
    channel_id: string;
    content: string;
}
