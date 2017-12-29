import * as config from 'config';
import * as redisPkg from 'redis';

export const redis = () => redisPkg.createClient(config.get('redis'));
