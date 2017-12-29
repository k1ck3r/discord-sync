import * as Promise from 'bluebird';
import * as config from 'config';
import { createPool, Pool, QueryOptions } from 'mysql';

export interface IAsyncQueryPool {
    queryAsync<T extends {}>(sql: string | QueryOptions, values?: any | any[]): Promise<T>;
}

export const sql = <Pool & IAsyncQueryPool>createPool(config.get('mysql'));
Promise.promisifyAll(sql);
