/**
 * StateSig.S — in-memory state with TTL-based auto-expiry:
 * session store + token/lookup indexes + cooldowns.
 */

import type { Message_location, Peer_id, Peer_unknown, Peer_user, session } from '../Domain.gen.js'

import { peerKey } from './peer.js'
import { TTLMap } from './ttlMap.js'

// Safety net only: sessions are normally removed by claim (answer or 60s
// timeout); the TTL exists so that a lost timer can't leak entries forever.
const SESSION_TTL_MS = 5 * 60_000 // 5 minutes

// Session store: sessionId → session
const sessionById = new TTLMap<string, session>()
// Token reverse index: token → sessionId (all option tokens, not just correct)
const tokenIndex = new TTLMap<string, string>()
// Pending lookup: "chatId:userId" → sessionId
const lookupIndex = new TTLMap<string, string>()
// Cooldown: "chatId:userId" → true
const cooldownMap = new TTLMap<string, true>()

/**
 * Deferred observation for timeouts: wait, then peek the session store.
 * If the session was already claimed by the answer callback in the interim,
 * this resolves to `undefined` and the timeout path must no-op.
 * The final arbiter is still `session_claim` — the peek only avoids running
 * the timeout chain in the common (already-handled) case.
 * (Part of InteractionSig, but lives here next to the store it reads.)
 */
export async function interaction_waitAndPeekSession(sessionId: string, delaySec: number): Promise<session | undefined> {
    await new Promise(resolve => setTimeout(resolve, delaySec * 1000))

    const session = sessionById.get(sessionId)

    if (session) {
        console.log(`[Observer] Session ${sessionId} is still active after ${delaySec}s. Triggering timeout logic.`)
    } else {
        console.log(`[Observer] Session ${sessionId} was already handled/cleaned up. Skipping.`)
    }

    return session
}

// ── Cooldown ────────────────────────────────────────────────

export async function cooldown_check(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<boolean> {
    const key = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    return cooldownMap.has(key)
}

export async function cooldown_apply(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, durationSec: number): Promise<void> {
    const key = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    cooldownMap.set(key, true, durationSec * 1000)
}

// ── Session ─────────────────────────────────────────────────

export async function session_save(s: session): Promise<void> {
    sessionById.set(s.id, s, SESSION_TTL_MS)

    // Index ALL option tokens → sessionId (not just the correct one).
    // This allows findByToken to work for any clicked button.
    for (const opt of s.optionsWithTokens) {
        tokenIndex.set(opt.token, s.id, SESSION_TTL_MS)
    }

    const lk = peerKey(s.chatId, s.userId)
    lookupIndex.set(lk, s.id, SESSION_TTL_MS)
}

export async function session_findByToken(token: string): Promise<session | undefined> {
    const sessionId = tokenIndex.get(token)
    if (sessionId === undefined) return undefined
    return sessionById.get(sessionId)
}

export async function session_findPending(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<session | undefined> {
    const lk = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    const sessionId = lookupIndex.get(lk)
    if (sessionId === undefined) return undefined
    return sessionById.get(sessionId)
}

/**
 * Atomically claim (remove and return) a session, including all token mappings
 * and the lookup index entry. This is the single removal primitive: competing
 * terminal paths (answer callback vs. timeout) both claim first, and only the
 * winner — the one that gets the session back — may act on it.
 *
 * Atomicity invariant: there must be NO `await` before the store mutations, so
 * the lookup + deletes run as one uninterrupted step on the event loop.
 */
export async function session_claim(id: string): Promise<session | undefined> {
    const claimed = sessionById.get(id)
    if (claimed === undefined) return undefined
    for (const opt of claimed.optionsWithTokens) {
        tokenIndex.delete(opt.token)
    }
    lookupIndex.delete(peerKey(claimed.chatId, claimed.userId))
    sessionById.delete(claimed.id)
    return claimed
}

/**
 * Update a session's verificationLocation field (set after the quiz message is sent).
 */
export async function session_updateLocation(s: session, loc: Message_location<Peer_unknown>): Promise<void> {
    const updated: session = { ...s, verificationLocation: loc }
    sessionById.set(s.id, updated, SESSION_TTL_MS)
}
