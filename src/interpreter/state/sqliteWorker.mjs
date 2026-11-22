/**
 * SQLite worker — zero-dependency plain ESM, no bundler/loader requirements.
 *
 * The SQLite state backend runs node:sqlite on a dedicated worker thread so
 * the synchronous driver (and its busy_timeout blocking) never stalls the
 * main event loop. The worker is a plain .mjs importing only node builtins:
 * a Worker thread does not reliably inherit tsx loader registration, so a
 * .ts worker would need special execArgv in every entry point. Plain ESM
 * needs none — dev loads this file directly, and the production build copies
 * it verbatim into dist/ next to main.mjs (see build.mjs).
 *
 * Protocol: request { op, rid, args } → reply { ok, result, rid } or
 * { ok: false, error, rid }. One message at a time per worker keeps every
 * multi-statement operation (BEGIN IMMEDIATE ... COMMIT) atomic.
 *
 * Session JSON is stored in the same envelope format as the TypeScript
 * `store.ts` (lk = precomputed lookup key, s = session) — the shared
 * store-contract suite pins the wire format for both implementations.
 */

import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

const port = parentPort
if (port === null) {
    throw new Error('sqliteWorker.mjs must be started as a Worker thread')
}

// ── Serialization (mirror of src/interpreter/state/store.ts) ──

function sessionLookupKey(s) {
    return `${s.chatId}:${s.userId}`
}

function encodeSession(s) {
    return JSON.stringify({ lk: sessionLookupKey(s), s })
}

function decodeSession(json) {
    return JSON.parse(json).s
}

// ── Database ─────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    lookup_key TEXT NOT NULL,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_lookup ON sessions(lookup_key);
CREATE TABLE IF NOT EXISTS evicted_sessions (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
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

const SWEEP_INTERVAL_MS = 60_000

const db = new DatabaseSync(workerData.path)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA journal_mode = WAL')
db.exec(SCHEMA)

const selectPendingForReplacement = db.prepare(
    'SELECT id, data FROM sessions WHERE lookup_key = ? AND expires_at > ? ORDER BY rowid DESC',
)
const insertEvicted = db.prepare(
    'INSERT OR REPLACE INTO evicted_sessions (id, data, expires_at) VALUES (?, ?, ?)',
)
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
const selectEvictedById = db.prepare(
    'SELECT data FROM evicted_sessions WHERE id = ? AND expires_at > ?',
)
const deleteEvicted = db.prepare('DELETE FROM evicted_sessions WHERE id = ?')
const deleteTokens = db.prepare('DELETE FROM session_tokens WHERE session_id = ?')
const updateSession = db.prepare(
    'UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?',
)
const updateTokens = db.prepare(
    'UPDATE session_tokens SET expires_at = ? WHERE session_id = ?',
)
const insertCooldown = db.prepare(
    'INSERT OR REPLACE INTO cooldowns (key, expires_at) VALUES (?, ?)',
)
const selectCooldown = db.prepare(
    'SELECT 1 FROM cooldowns WHERE key = ? AND expires_at > ?',
)
const sweepTokens = db.prepare('DELETE FROM session_tokens WHERE expires_at <= ?')
const sweepSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
const sweepEvicted = db.prepare('DELETE FROM evicted_sessions WHERE expires_at <= ?')
const sweepCooldowns = db.prepare('DELETE FROM cooldowns WHERE expires_at <= ?')

// node:sqlite has no transaction() helper — BEGIN/COMMIT manually. The whole
// block is synchronous, so no other message handler can interleave with it.
function tx(fn) {
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

function rowData(row) {
    return row === undefined ? undefined : row.data
}

const sweepTimer = setInterval(() => {
    const now = Date.now()
    sweepTokens.run(now)
    sweepEvicted.run(now)
    sweepSessions.run(now)
    sweepCooldowns.run(now)
}, SWEEP_INTERVAL_MS)
sweepTimer.unref()

const ops = {
    'cooldown.check': key => selectCooldown.get(key, Date.now()) !== undefined,
    'cooldown.apply': (key, ttlMs) => {
        insertCooldown.run(key, Date.now() + ttlMs)
    },
    'session.savePending': (s, ttlMs) => {
        return tx(() => {
            const now = Date.now()
            const expiresAt = now + ttlMs
            const replacedRows = selectPendingForReplacement.all(sessionLookupKey(s), now)
            const replaced = replacedRows[0] === undefined ? undefined : decodeSession(replacedRows[0].data)

            for (const replacedRow of replacedRows) {
                deleteTokens.run(replacedRow.id)
                deleteSession.run(replacedRow.id)
                if (replacedRow.id !== s.id) insertEvicted.run(replacedRow.id, replacedRow.data, expiresAt)
            }

            insertSession.run(s.id, sessionLookupKey(s), encodeSession(s), expiresAt)
            for (const opt of s.optionsWithTokens) {
                insertToken.run(opt.token, s.id, expiresAt)
            }
            return replaced
        })
    },
    'session.getById': (id) => {
        const data = rowData(selectById.get(id, Date.now()))
        return data === undefined ? undefined : decodeSession(data)
    },
    'session.findByToken': (token) => {
        const now = Date.now()
        const data = rowData(selectByToken.get(token, now, now))
        return data === undefined ? undefined : decodeSession(data)
    },
    'session.findPending': (lookupKey) => {
        const data = rowData(selectPending.get(lookupKey, Date.now()))
        return data === undefined ? undefined : decodeSession(data)
    },
    'session.claim': (id) => {
        return tx(() => {
            const now = Date.now()
            const liveData = rowData(selectById.get(id, now))
            const data = liveData ?? rowData(selectEvictedById.get(id, now))
            if (data === undefined) return undefined
            deleteTokens.run(id)
            deleteSession.run(id)
            deleteEvicted.run(id)
            return decodeSession(data)
        })
    },
    'session.updateLocation': (id, loc, ttlMs) => {
        return tx(() => {
            const data = rowData(selectById.get(id, Date.now()))
            if (data === undefined) return false
            const updated = { ...decodeSession(data), verificationLocation: loc }
            const expiresAt = Date.now() + ttlMs
            updateSession.run(encodeSession(updated), expiresAt, id)
            updateTokens.run(expiresAt, id)
            return true
        })
    },
    'session.listAll': () => {
        const rows = selectAll.all(Date.now())
        return rows.map(r => decodeSession(r.data))
    },
}

port.on('message', (req) => {
    let reply
    try {
        const fn = ops[req.op]
        if (fn === undefined) {
            throw new Error(`Unknown sqlite worker op: ${req.op}`)
        }
        reply = { ok: true, result: fn(...(req.args ?? [])), rid: req.rid }
    } catch (err) {
        reply = { ok: false, error: err instanceof Error ? err.message : String(err), rid: req.rid }
    }
    port.postMessage(reply)
})

// Schema setup and statement preparation above are synchronous, so once the
// worker's event loop starts, the database is fully usable. Announce it so
// the main thread never races a close() against schema creation.
port.postMessage({ ready: true })
