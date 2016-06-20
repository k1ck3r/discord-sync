import * as redis from "redis";
import * as config from "config";

export default () => redis.createClient(config.get("redis"));