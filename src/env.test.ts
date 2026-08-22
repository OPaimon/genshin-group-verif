import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeEnv } from './env.js'

const requiredEnv = {
    API_ID: '12345',
    API_HASH: 'hash',
    BOT_TOKEN: 'token',
    LOG_PEER: '-100123',
}

test('decodeEnv validates and converts required configuration', () => {
    const result = decodeEnv(requiredEnv)

    assert.equal(result.API_ID, 12345)
    assert.equal(result.API_HASH, 'hash')
    assert.equal(result.BOT_TOKEN, 'token')
    assert.equal(result.LOG_PEER, -100123)
    assert.equal(result.STATE_BACKEND, 'memory')
    assert.deepEqual(result.ADMIN_IDS, [])
    assert.equal(result.SENTRY_LOG_LEVEL, 'info')
    assert.equal(result.SENTRY_SCRUB_PII, false)
})

test('decodeEnv converts optional configuration', () => {
    const result = decodeEnv({
        ...requiredEnv,
        ADMIN_IDS: ' 1, 2,3 ',
        STATE_BACKEND: 'sqlite',
        STATE_SQLITE_PATH: 'data/state.sqlite',
        SENTRY_LOG_LEVEL: 'warn',
        SENTRY_SCRUB_PII: 'YES',
        NODE_ENV: 'production',
    })

    assert.deepEqual(result.ADMIN_IDS, [1, 2, 3])
    assert.equal(result.STATE_BACKEND, 'sqlite')
    assert.equal(result.STATE_SQLITE_PATH, 'data/state.sqlite')
    assert.equal(result.SENTRY_LOG_LEVEL, 'warn')
    assert.equal(result.SENTRY_SCRUB_PII, true)
    assert.equal(result.SENTRY_ENVIRONMENT, 'production')
})

test('decodeEnv reports invalid required and enumerated values', () => {
    assert.throws(() => decodeEnv({ ...requiredEnv, API_ID: 'not-a-number' }), /API_ID.*number/i)
    assert.throws(() => decodeEnv({ ...requiredEnv, STATE_BACKEND: 'redis' }), /STATE_BACKEND.*memory.*sqlite/i)
    assert.throws(() => decodeEnv({ ...requiredEnv, SENTRY_LOG_LEVEL: 'trace' }), /SENTRY_LOG_LEVEL.*debug.*info.*warn.*error/i)
})

test('decodeEnv rejects invalid ADMIN_IDS', () => {
    assert.throws(() => decodeEnv({ ...requiredEnv, ADMIN_IDS: '1,nope,3' }), /ADMIN_IDS.*numeric/i)
})
