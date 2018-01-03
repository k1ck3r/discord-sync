import * as config from 'config';
import * as Redis from 'ioredis';

export const redis = () => new Redis(config.get('redis'));
