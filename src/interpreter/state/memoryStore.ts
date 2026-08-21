/**
 * In-memory StateStore — TTLMap-backed, process-local, volatile.
 *
 * Atomicity relies on JS event-loop synchronicity: pending replacement and
 * claims contain no `await` before their mutations, so concurrent callers
 * cannot interleave inside either operation.
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import { TTLMap } from '../ttlMap.js'
import { sessionLookupKey } from './store.js'

export function createMemoryStore(): StateStore {
    // Session store: sessionId → session
    const sessionById = new TTLMap<string, session>()
    // Replaced sessions are no longer reachable, but remain claimable once.
    const evictedById = new TTLMap<string, session>()
    // Token reverse index: token → sessionId (all option tokens, not just correct)
    const tokenIndex = new TTLMap<string, string>()
    // Pending lookup: "chatId:userId" → sessionId
    const lookupIndex = new TTLMap<string, string>()
    // Cooldown: "chatId:userId" → true
    const cooldownMap = new TTLMap<string, true>()

    return {
        cooldown: {
            async check(key) {
                return cooldownMap.has(key)
            },
            async apply(key, ttlMs) {
                cooldownMap.set(key, true, ttlMs)
            },
        },
        session: {
            async savePending(s, ttlMs) {
                const lookupKey = sessionLookupKey(s)
                const replacedId = lookupIndex.get(lookupKey)
                const replaced = replacedId === undefined ? undefined : sessionById.get(replacedId)

                if (replaced !== undefined) {
                    sessionById.delete(replaced.id)
                    if (replaced.id !== s.id) evictedById.set(replaced.id, replaced, ttlMs)
                    for (const opt of replaced.optionsWithTokens) {
                        if (tokenIndex.get(opt.token) === replaced.id) tokenIndex.delete(opt.token)
                    }
                }

                sessionById.set(s.id, s, ttlMs)
                for (const opt of s.optionsWithTokens) {
                    tokenIndex.set(opt.token, s.id, ttlMs)
                }
                lookupIndex.set(lookupKey, s.id, ttlMs)
                return replaced
            },
            async getById(id) {
                return sessionById.get(id)
            },
            async findByToken(token) {
                const sessionId = tokenIndex.get(token)
                if (sessionId === undefined) return undefined
                return sessionById.get(sessionId)
            },
            async findPending(lookupKey) {
                const sessionId = lookupIndex.get(lookupKey)
                if (sessionId === undefined) return undefined
                return sessionById.get(sessionId)
            },
            // Atomicity invariant: NO `await` before the store mutations — the
            // lookup + deletes must run as one uninterrupted event-loop step.
            async claim(id) {
                const live = sessionById.get(id)
                const claimed = live ?? evictedById.get(id)
                if (claimed === undefined) return undefined

                for (const opt of claimed.optionsWithTokens) {
                    if (tokenIndex.get(opt.token) === claimed.id) tokenIndex.delete(opt.token)
                }
                const lookupKey = sessionLookupKey(claimed)
                if (lookupIndex.get(lookupKey) === claimed.id) lookupIndex.delete(lookupKey)
                sessionById.delete(claimed.id)
                evictedById.delete(claimed.id)
                return claimed
            },
            async updateLocation(id, loc: Message_location<Peer_unknown>, ttlMs) {
                const existing = sessionById.get(id)
                // Update-if-present only: the session may have been claimed or
                // replaced between save and the quiz message send completing.
                if (existing === undefined) return false
                const updated = { ...existing, verificationLocation: loc }
                sessionById.set(id, updated, ttlMs)
                for (const opt of existing.optionsWithTokens) {
                    if (tokenIndex.get(opt.token) === id) tokenIndex.set(opt.token, id, ttlMs)
                }
                const lookupKey = sessionLookupKey(existing)
                if (lookupIndex.get(lookupKey) === id) lookupIndex.set(lookupKey, id, ttlMs)
                return true
            },
            async listAll() {
                return sessionById.values()
            },
        },
        async close() {
            sessionById.dispose()
            evictedById.dispose()
            tokenIndex.dispose()
            lookupIndex.dispose()
            cooldownMap.dispose()
        },
    }
}
