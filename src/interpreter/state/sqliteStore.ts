/**
 * SQLite StateStore — node:sqlite (built-in, no native addon), driven from a
 * dedicated Worker thread.
 *
 * node:sqlite exposes only a synchronous API, and a synchronous transaction
 * must run as one uninterrupted event-loop step for the pending-slot
 * replacement and claim invariants to hold against concurrent JS callers.
 * Running that driver on the main thread also means a contended database
 * (busy_timeout = 5000 ms) can block every pending Telegram interaction for
 * up to 5 s. The worker keeps the synchronous driver — with its atomicity —
 * but moves it off the main thread: every store method here only awaits a
 * Promise reply, so a contended SQLite lock delays this backend's callers
 * instead of freezing the whole process.
 *
 * The worker processes its message queue one handler at a time and every
 * multi-statement operation is a single message containing one synchronous
 * transaction, so each operation stays atomic inside the worker — exactly as
 * the previous in-process implementation guaranteed.
 *
 * TTL is an expires_at column: reads filter on it, and a periodic sweep
 * (plus lazy checks) deletes expired rows.
 */

import type { Message_location, Peer_unknown, session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

/**
 * The worker is a zero-dependency plain .mjs (node builtins only): a worker
 * thread does not reliably inherit tsx loader registration, so a .ts worker
 * would need special execArgv in every entry point. Plain ESM needs none —
 * dev loads this file directly, and the production build copies it verbatim
 * into dist/ next to main.mjs (see build.mjs).
 */
const WORKER_FILE = join(dirname(fileURLToPath(import.meta.url)), 'sqliteWorker.mjs')

interface WorkerRequest {
    op: string
    rid: number
    args?: unknown[]
}

interface WorkerReply {
    ok: boolean
    result?: unknown
    error?: string
    rid: number
}

export function createSqliteStore(path: string): StateStore {
    if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true })
    }

    const worker = new Worker(WORKER_FILE, { workerData: { path } })

    let nextRid = 0
    const pending = new Map<number, { resolve: (value: unknown) => void, reject: (err: Error) => void }>()

    /**
     * Resolves once the worker announces its schema is ready. The worker's
     * setup (DatabaseSync open + schema + statement preparation) is
     * synchronous, so this only bridges the thread-start latency — without
     * it, an immediate close() could terminate the worker before the schema
     * exists (observed as `no such table: sessions` in tests).
     */
    const ready = new Promise<void>((resolve, reject) => {
        worker.once('message', (msg: { ready?: boolean }) => {
            if (msg?.ready === true) resolve()
        })
        worker.once('error', reject)
        worker.once('exit', code => reject(new Error(`sqlite worker exited before ready (code ${code})`)))
    })
    ready.catch(() => {}) // no unhandled rejection when the worker dies early

    worker.on('message', (reply: WorkerReply) => {
        const entry = pending.get(reply.rid)
        if (entry === undefined) return
        pending.delete(reply.rid)
        if (reply.ok) {
            entry.resolve(reply.result)
        } else {
            entry.reject(new Error(reply.error ?? 'sqlite worker op failed'))
        }
    })

    worker.on('error', (err) => {
        // Worker-level failure (e.g. the database cannot be opened) rejects
        // every in-flight request instead of hanging them forever.
        for (const entry of pending.values()) {
            entry.reject(err)
        }
        pending.clear()
    })

    // The worker keeps the event loop alive on purpose: the store must stay
    // usable while there are callers, and close() terminates it. (An unref'd
    // worker would let the loop resolve while replies are still pending.)

    function call<T>(op: string, ...args: unknown[]): Promise<T> {
        return ready.then(() => new Promise<T>((resolve, reject) => {
            const rid = nextRid++
            pending.set(rid, { resolve: resolve as (value: unknown) => void, reject })
            const req: WorkerRequest = { op, rid, args }
            worker.postMessage(req)
        }))
    }

    return {
        cooldown: {
            check: (key: string) => call<boolean>('cooldown.check', key),
            apply: (key: string, ttlMs: number) => call<void>('cooldown.apply', key, ttlMs),
        },
        session: {
            savePending: (s: session, ttlMs: number) => call<session | undefined>('session.savePending', s, ttlMs),
            getById: (id: string) => call<session | undefined>('session.getById', id),
            findByToken: (token: string) => call<session | undefined>('session.findByToken', token),
            findPending: (lookupKey: string) => call<session | undefined>('session.findPending', lookupKey),
            claim: (id: string) => call<session | undefined>('session.claim', id),
            updateLocation: (id: string, loc: Message_location<Peer_unknown>, ttlMs: number) =>
                call<boolean>('session.updateLocation', id, loc, ttlMs),
            listAll: () => call<session[]>('session.listAll'),
        },
        async close() {
            // Wait for schema setup so a create→close round trip (tests,
            // bootstrap) cannot race the worker's startup.
            await ready.catch(() => {})
            await worker.terminate()
        },
    }
}
