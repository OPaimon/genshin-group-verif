/**
 * StateStore — the pluggable persistence boundary behind StateSig.S.
 *
 * The interface deliberately exposes composite, semantically rich operations
 * (save-with-indexes, claim-everything) instead of raw KV primitives: `claim`
 * arbitrates between competing terminal paths (answer callback vs. timeout)
 * and its all-or-nothing removal must live INSIDE the backend, where each
 * store has a native atomicity primitive — event-loop synchronicity (memory),
 * a transaction (SQLite), a Lua script (Redis).
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'

import { peerKey } from '../peer.js'

export interface CooldownStore {
    /** True if `key` is currently cooling down. */
    check: (key: string) => Promise<boolean>
    apply: (key: string, ttlMs: number) => Promise<void>
}

export interface SessionStore {
    /**
     * Write the session plus all its index entries (every option token →
     * session id, lookup key → session id), each expiring after ttlMs.
     * Saving a second session for the same lookup key makes the newer one
     * the pending session.
     */
    save: (s: session, ttlMs: number) => Promise<void>
    getById: (id: string) => Promise<session | undefined>
    findByToken: (token: string) => Promise<session | undefined>
    findPending: (lookupKey: string) => Promise<session | undefined>
    /**
     * Atomically remove the session together with ALL its index entries and
     * return it. Exactly one of any number of concurrent claimers receives
     * the session; the rest get undefined. Only the winner may act on it.
     */
    claim: (id: string) => Promise<session | undefined>
    /**
     * Set verificationLocation and refresh the TTL — but ONLY if the session
     * still exists. Never an upsert: re-inserting a claimed session would
     * resurrect it and let the timeout observer punish an already-verified
     * user.
     */
    updateLocation: (id: string, loc: Message_location<Peer_unknown>, ttlMs: number) => Promise<void>
    /** All live (unexpired) sessions — used for restart recovery. */
    listAll: () => Promise<session[]>
}

export interface StateStore {
    cooldown: CooldownStore
    session: SessionStore
    /** Release timers/handles/connections. The store is unusable afterwards. */
    close: () => Promise<void>
}

export type StateBackendConfig
    = | { backend: 'memory' }
        | { backend: 'sqlite', path: string }
        | { backend: 'redis', url: string, keyPrefix?: string }

// ── Serialization (shared by persistent backends) ───────────
//
// Sessions are JSON-safe as-is: branded Peer/Message ids are plain numbers at
// runtime, and ReScript's `option` maps None ↔ undefined — JSON.stringify
// drops the absent verificationLocation key and a missing key reads back as
// undefined, i.e. None. The envelope carries the precomputed lookup key so
// backends (in particular the Redis Lua claim script) never re-derive it from
// numeric ids, whose string formatting differs between JS and Lua.

export interface SessionEnvelope {
    /** Lookup key ("chatId:userId") — precomputed via peerKey. */
    lk: string
    s: session
}

export function encodeSession(s: session): string {
    const envelope: SessionEnvelope = { lk: peerKey(s.chatId, s.userId), s }
    return JSON.stringify(envelope)
}

export function decodeSession(json: string): session {
    const envelope = JSON.parse(json) as SessionEnvelope
    return envelope.s
}

export function sessionLookupKey(s: session): string {
    return peerKey(s.chatId, s.userId)
}
