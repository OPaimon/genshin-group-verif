/**
 * StateSig.S — facade over the pluggable StateStore backend
 * (memory | sqlite, selected via STATE_BACKEND; Redis is archived).
 *
 * Export names are the AppBridge.res binding surface — keep them stable.
 */

import type { Message_location, Peer_id, Peer_unknown, Peer_user, session } from '../Domain.gen.js'
import type { StateStore } from './state/store.js'

import { env } from '../env.js'
import { logger } from '../logger.js'
import { peerKey } from './peer.js'
import { createStore } from './state/factory.js'

// Safety net only: sessions are normally removed by claim (answer or 60s
// timeout); the TTL exists so that a lost timer can't leak entries forever.
const SESSION_TTL_MS = 5 * 60_000 // 5 minutes

const store: StateStore = createStore(
    env.STATE_BACKEND === 'sqlite'
        ? { backend: 'sqlite', path: env.STATE_SQLITE_PATH }
        : { backend: 'memory' },
)

/** The live store — used by main.ts for restart recovery (session.listAll). */
export function stateStore(): StateStore {
    return store
}

/**
 * Deferred observation for timeouts: wait, then peek the session store.
 * If the session was already claimed by the answer callback in the interim,
 * this resolves to `undefined` and the timeout path must no-op.
 * The final arbiter is still `session_claim` — the peek only avoids running
 * the timeout chain in the common (already-handled) case.
 */
export async function session_waitAndPeek(sessionId: string, delaySec: number): Promise<session | undefined> {
    await new Promise(resolve => setTimeout(resolve, delaySec * 1000))

    const session = await store.session.getById(sessionId)

    if (session) {
        logger.debug(`[Observer] Session ${sessionId} is still active after ${delaySec}s. Triggering timeout logic.`)
    } else {
        logger.debug(`[Observer] Session ${sessionId} was already handled/cleaned up. Skipping.`)
    }

    return session
}

// ── Cooldown ────────────────────────────────────────────────

export async function cooldown_check(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<boolean> {
    return store.cooldown.check(peerKey(chatId as Peer_id<Peer_unknown>, userId))
}

export async function cooldown_apply(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, durationSec: number): Promise<void> {
    return store.cooldown.apply(peerKey(chatId as Peer_id<Peer_unknown>, userId), durationSec * 1000)
}

// ── Session ─────────────────────────────────────────────────

export async function session_save(s: session): Promise<void> {
    try {
        await store.session.save(s, SESSION_TTL_MS)
    } catch (err: unknown) {
        logger.error('[Session.save] Failed:', err)
        throw err
    }
}

export async function session_findByToken(token: string): Promise<session | undefined> {
    return store.session.findByToken(token)
}

export async function session_findPending(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<session | undefined> {
    return store.session.findPending(peerKey(chatId as Peer_id<Peer_unknown>, userId))
}

/**
 * Atomically claim (remove and return) a session, including all token mappings
 * and the lookup index entry. This is the single removal primitive: competing
 * terminal paths (answer callback vs. timeout) both claim first, and only the
 * winner — the one that gets the session back — may act on it.
 */
export async function session_claim(id: string): Promise<session | undefined> {
    return store.session.claim(id)
}

/**
 * Update a session's verificationLocation field (set after the quiz message is
 * sent) — only if the session still exists; a claimed session stays gone.
 */
export async function session_updateLocation(s: session, loc: Message_location<Peer_unknown>): Promise<void> {
    return store.session.updateLocation(s.id, loc, SESSION_TTL_MS)
}
