/**
 * User contains user information to put into a chat message.
 */
export interface User {
    id: number;
    username: string;
    roles: Array<string>;
}

/**
 * A ChatMessage is sent to and from the websocket.
 */
export interface ChatMessage {
    channel: number;
    id: string;
    user_name: string;
    user_roles: Array<String>;
    user_id: number;
    message: {
        message: Array<MessageComponent>,
        meta: { discord: boolean },
    };
}

export interface MessageComponent {
    type: string;
    data: string;
    text: string;
}

export interface DiscordMessage {
    id: string;
    channel_id: string;
    content: string;
}