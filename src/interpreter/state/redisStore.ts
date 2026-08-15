/**
 * Redis StateStore — ioredis.
 *
 * Key layout (all under a configurable prefix, TTL via native PX expiry):
 *   sess:{sessionId}      → session envelope JSON
 *   rel:{sessionId}       → space-separated related keys ("tok:… pending:…")
 *   tok:{token}           → sessionId
 *   pending:{chat}:{user} → sessionId
 *   cd:{chat}:{user}      → "1"
 *
 * `claim` is a Lua script — Redis executes scripts atomically, which is what
 * makes claim arbitration hold across multiple bot processes. The rel key
 * exists so the script can find every index entry WITHOUT parsing the session
 * JSON in Lua: no cjson dependency (fengari-based test mocks lack it) and no
 * Lua number formatting anywhere near the numeric peer ids. The script
 * returns the ORIGINAL stored JSON string, so ids can't be corrupted by a
 * re-encode.
 *
 * Caveat: the script touches multiple keys, so on Redis Cluster the prefix
 * would need a {hash-tag}. Single-instance Redis (the expected deployment)
 * is unaffected.
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import { Redis } from 'ioredis'

import { logger } from '../../logger.js'
import { decodeSession, encodeSession, sessionLookupKey } from './store.js'

const CLAIM_LUA = `
local data = redis.call('GET', KEYS[1])
if not data then return false end
local rel = redis.call('GET', KEYS[2])
if rel then
    for key in string.gmatch(rel, '%S+') do
        redis.call('DEL', ARGV[1] .. key)
    end
end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[1])
return data
`

interface RedisWithClaim extends Redis {
    claimSession: (sessKey: string, relKey: string, prefix: string) => Promise<unknown>
}

export function createRedisStore(url: string, keyPrefix?: string): StateStore {
    return createRedisStoreWithClient(new Redis(url, { maxRetriesPerRequest: 3 }), keyPrefix)
}

/** Test seam: same store, caller-supplied client (e.g. ioredis-mock). */
export function createRedisStoreWithClient(client: Redis, keyPrefix: string = 'ggv:'): StateStore {
    const redis = client as RedisWithClaim
    redis.defineCommand('claimSession', { numberOfKeys: 2, lua: CLAIM_LUA })

    const sessKey = (id: string): string => `${keyPrefix}sess:${id}`
    const relKey = (id: string): string => `${keyPrefix}rel:${id}`
    const tokKey = (token: string): string => `${keyPrefix}tok:${token}`
    const pendingKey = (lk: string): string => `${keyPrefix}pending:${lk}`
    const cdKey = (key: string): string => `${keyPrefix}cd:${key}`

    const getById = async (id: string): Promise<session | undefined> => {
        const data = await redis.get(sessKey(id))
        return data === null ? undefined : decodeSession(data)
    }

    return {
        cooldown: {
            async check(key) {
                return (await redis.exists(cdKey(key))) === 1
            },
            async apply(key, ttlMs) {
                await redis.set(cdKey(key), '1', 'PX', ttlMs)
            },
        },
        session: {
            async save(s, ttlMs) {
                const lk = sessionLookupKey(s)
                // Prefix-relative related keys, space-joined (tokens are
                // UUIDs, lk is "num:num" — neither contains whitespace).
                const related = [
                    ...s.optionsWithTokens.map(opt => `tok:${opt.token}`),
                    `pending:${lk}`,
                ].join(' ')

                const pipeline = redis.pipeline()
                pipeline.set(sessKey(s.id), encodeSession(s), 'PX', ttlMs)
                pipeline.set(relKey(s.id), related, 'PX', ttlMs)
                for (const opt of s.optionsWithTokens) {
                    pipeline.set(tokKey(opt.token), s.id, 'PX', ttlMs)
                }
                pipeline.set(pendingKey(lk), s.id, 'PX', ttlMs)
                await pipeline.exec()
            },
            getById,
            async findByToken(token) {
                const sessionId = await redis.get(tokKey(token))
                if (sessionId === null) return undefined
                return getById(sessionId)
            },
            async findPending(lookupKey) {
                const sessionId = await redis.get(pendingKey(lookupKey))
                if (sessionId === null) return undefined
                return getById(sessionId)
            },
            async claim(id) {
                const data = await redis.claimSession(sessKey(id), relKey(id), keyPrefix)
                // Lua false arrives as null from real Redis, false from mocks.
                return typeof data === 'string' ? decodeSession(data) : undefined
            },
            async updateLocation(id, loc: Message_location<Peer_unknown>, ttlMs) {
                const data = await redis.get(sessKey(id))
                if (data === null) return
                const updated: session = { ...decodeSession(data), verificationLocation: loc }
                // XX: only touch an existing key. Session ids are UUIDs and
                // never reused, so the sole competing writer between the GET
                // and this SET is claim's delete — which XX correctly loses to.
                await redis.set(sessKey(id), encodeSession(updated), 'PX', ttlMs, 'XX')
            },
            async listAll() {
                const keys: string[] = []
                let cursor = '0'
                do {
                    const [next, batch] = await redis.scan(
                        cursor,
                        'MATCH',
                        `${keyPrefix}sess:*`,
                        'COUNT',
                        100,
                    )
                    cursor = next
                    keys.push(...batch)
                } while (cursor !== '0')
                if (keys.length === 0) return []
                const values = await redis.mget(keys)
                // A key can expire between SCAN and MGET — skip nulls.
                return values.filter((v): v is string => v !== null).map(decodeSession)
            },
        },
        async close() {
            try {
                await redis.quit()
            } catch (err) {
                logger.warn('[redisStore] quit failed; forcing disconnect.', err)
                redis.disconnect()
            }
        },
    }
}
