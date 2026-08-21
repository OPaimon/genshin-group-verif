/**
 * In-memory StateStore — TTLMap-backed, process-local, volatile.
 *
 * Atomicity of `claim` relies on JS event-loop synchronicity: there is no
 * `await` between the lookup and the deletes, so the whole claim runs as one
 * uninterrupted step and concurrent claimers can never both win.
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import { TTLMap } from '../ttlMap.js'
import { sessionLookupKey } from './store.js'

export function createMemoryStore(): StateStore {
    // Session store: sessionId → session
    const sessionById = new TTLMap<string, session>()
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
            async save(s, ttlMs) {
                sessionById.set(s.id, s, ttlMs)
                // Index ALL option tokens → sessionId (not just the correct one),
                // so findByToken works for any clicked button.
                for (const opt of s.optionsWithTokens) {
                    tokenIndex.set(opt.token, s.id, ttlMs)
                }
                lookupIndex.set(sessionLookupKey(s), s.id, ttlMs)
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
                const claimed = sessionById.get(id)
                if (claimed === undefined) return undefined
                for (const opt of claimed.optionsWithTokens) {
                    tokenIndex.delete(opt.token)
                }
                lookupIndex.delete(sessionLookupKey(claimed))
                sessionById.delete(claimed.id)
                return claimed
            },
            async updateLocation(id, loc: Message_location<Peer_unknown>, ttlMs) {
                const existing = sessionById.get(id)
                // Update-if-present only: the session may have been claimed
                // between save and the quiz message send completing.
                if (existing === undefined) return false
                sessionById.set(id, { ...existing, verificationLocation: loc }, ttlMs)
                return true
            },
            async listAll() {
                return sessionById.values()
            },
        },
        async close() {
            sessionById.dispose()
            tokenIndex.dispose()
            lookupIndex.dispose()
            cooldownMap.dispose()
        },
    }
}
