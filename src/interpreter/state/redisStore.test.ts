/**
 * Redis conformance.
 *
 * By default the contract runs against ioredis-mock (in-process, executes the
 * claim Lua script through fengari) — it validates the store logic but not a
 * real server. Set REDIS_URL (e.g. redis://localhost:6379) to run against
 * live Redis instead; each store gets a unique key prefix and test TTLs are
 * short, so stray keys self-expire.
 */

import { randomUUID } from 'node:crypto'
import RedisMock from 'ioredis-mock'

import { createRedisStore, createRedisStoreWithClient } from './redisStore.js'
import { runStoreContract } from './storeContract.js'

const url = process.env.REDIS_URL

if (url !== undefined && url !== '') {
    runStoreContract('redis (live)', () => createRedisStore(url, `ggv-test-${randomUUID()}:`))
} else {
    runStoreContract('redis (ioredis-mock)', () => createRedisStoreWithClient(new RedisMock(), `ggv-test-${randomUUID()}:`))
}
