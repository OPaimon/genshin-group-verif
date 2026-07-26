/**
 * SQLite StateStore — node:sqlite (built-in, no native addon).
 *
 * Deliberately NOT better-sqlite3: that addon has no prebuilt binary for
 * current Node and needs a full MSVC toolchain to compile, while node:sqlite
 * (unflagged since Node 22.13 / 23.4) offers the same synchronous API.
 * Synchronous means a BEGIN…COMMIT block runs as one uninterrupted event-loop
 * step: `claim` is atomic both against SQLite and against concurrent JS
 * callers.
 *
 * TTL is an expires_at column: reads filter on it, and a periodic sweep
 * (plus lazy checks) deletes expired rows.
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { decodeSession, encodeSession, sessionLookupKey } from './store.js'

const SWEEP_INTERVAL_MS = 60_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    lookup_key TEXT NOT NULL,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(lookup_key);
CREATE TABLE IF NOT EXISTS session_tokens (
    token      TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_session ON session_tokens(session_id);
CREATE TABLE IF NOT EXISTS cooldowns (
    key        TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
`

export function createSqliteStore(path: string): StateStore {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true })
    }
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SCHEMA)

    const insertSession = db.prepare(
        'INSERT OR REPLACE INTO sessions (id, lookup_key, data, expires_at) VALUES (?, ?, ?, ?)',
    )
    const insertToken = db.prepare(
        'INSERT OR REPLACE INTO session_tokens (token, session_id, expires_at) VALUES (?, ?, ?)',
    )
    const selectById = db.prepare(
        'SELECT data FROM sessions WHERE id = ? AND expires_at > ?',
    )
    const selectByToken = db.prepare(`
        SELECT s.data AS data FROM session_tokens t
        JOIN sessions s ON s.id = t.session_id
        WHERE t.token = ? AND t.expires_at > ? AND s.expires_at > ?
    `)
    // Newest wins when two live sessions share a lookup key (rowid is monotonic)
    const selectPending = db.prepare(
        'SELECT data FROM sessions WHERE lookup_key = ? AND expires_at > ? ORDER BY rowid DESC LIMIT 1',
    )
    const selectAll = db.prepare(
        'SELECT data FROM sessions WHERE expires_at > ?',
    )
    const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
    const deleteTokens = db.prepare('DELETE FROM session_tokens WHERE session_id = ?')
    const updateSession = db.prepare(
        'UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?',
    )
    const insertCooldown = db.prepare(
        'INSERT OR REPLACE INTO cooldowns (key, expires_at) VALUES (?, ?)',
    )
    const selectCooldown = db.prepare(
        'SELECT 1 FROM cooldowns WHERE key = ? AND expires_at > ?',
    )
    const sweepTokens = db.prepare('DELETE FROM session_tokens WHERE expires_at <= ?')
    const sweepSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
    const sweepCooldowns = db.prepare('DELETE FROM cooldowns WHERE expires_at <= ?')

    // node:sqlite has no transaction() helper — BEGIN/COMMIT manually. The
    // whole block is synchronous, so no other JS can interleave with it.
    const tx = <T>(fn: () => T): T => {
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (err) {
            db.exec('ROLLBACK')
            throw err
        }
    }

    const rowData = (row: unknown): string | undefined =>
        row === undefined ? undefined : (row as { data: string }).data

    const sweepTimer = setInterval(() => {
        const now = Date.now()
        sweepTokens.run(now)
        sweepSessions.run(now)
        sweepCooldowns.run(now)
    }, SWEEP_INTERVAL_MS)
    sweepTimer.unref()

    return {
        cooldown: {
            async check(key) {
                return selectCooldown.get(key, Date.now()) !== undefined
            },
            async apply(key, ttlMs) {
                insertCooldown.run(key, Date.now() + ttlMs)
            },
        },
        session: {
            async save(s, ttlMs) {
                tx(() => {
                    const expiresAt = Date.now() + ttlMs
                    insertSession.run(s.id, sessionLookupKey(s), encodeSession(s), expiresAt)
                    for (const opt of s.optionsWithTokens) {
                        insertToken.run(opt.token, s.id, expiresAt)
                    }
                })
            },
            async getById(id) {
                const data = rowData(selectById.get(id, Date.now()))
                return data === undefined ? undefined : decodeSession(data)
            },
            async findByToken(token) {
                const now = Date.now()
                const data = rowData(selectByToken.get(token, now, now))
                return data === undefined ? undefined : decodeSession(data)
            },
            async findPending(lookupKey) {
                const data = rowData(selectPending.get(lookupKey, Date.now()))
                return data === undefined ? undefined : decodeSession(data)
            },
            async claim(id) {
                return tx(() => {
                    const data = rowData(selectById.get(id, Date.now()))
                    if (data === undefined) return undefined
                    deleteTokens.run(id)
                    deleteSession.run(id)
                    return decodeSession(data)
                })
            },
            async updateLocation(id, loc: Message_location<Peer_unknown>, ttlMs) {
                tx(() => {
                    const data = rowData(selectById.get(id, Date.now()))
                    if (data === undefined) return
                    const updated: session = { ...decodeSession(data), verificationLocation: loc }
                    updateSession.run(encodeSession(updated), Date.now() + ttlMs, id)
                })
            },
            async listAll() {
                const rows = selectAll.all(Date.now()) as Array<{ data: string }>
                return rows.map(r => decodeSession(r.data))
            },
        },
        async close() {
            clearInterval(sweepTimer)
            db.close()
        },
    }
}
