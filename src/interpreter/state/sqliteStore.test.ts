import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'

import { createSqliteStore } from './sqliteStore.js'
import { encodeSession, sessionLookupKey } from './store.js'
import { makeSession, runStoreContract } from './storeContract.js'

runStoreContract('sqlite', () => createSqliteStore(':memory:'))

test('sqlite: savePending removes every legacy live duplicate for one lookup key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genshin-state-'))
    const path = join(dir, 'state.db')
    const first = makeSession()
    const second = makeSession({ chatId: first.chatId, userId: first.userId })
    const winner = makeSession({ chatId: first.chatId, userId: first.userId })
    const expiresAt = Date.now() + 10_000

    const bootstrap = createSqliteStore(path)
    await bootstrap.close()

    const db = new DatabaseSync(path)
    const insertSession = db.prepare(
        'INSERT INTO sessions (id, lookup_key, data, expires_at) VALUES (?, ?, ?, ?)',
    )
    const insertToken = db.prepare(
        'INSERT INTO session_tokens (token, session_id, expires_at) VALUES (?, ?, ?)',
    )
    for (const value of [first, second]) {
        insertSession.run(value.id, sessionLookupKey(value), encodeSession(value), expiresAt)
        for (const option of value.optionsWithTokens) insertToken.run(option.token, value.id, expiresAt)
    }
    db.close()

    const store = createSqliteStore(path)
    try {
        assert.equal((await store.session.savePending(winner, 10_000))?.id, second.id)
        assert.deepStrictEqual((await store.session.listAll()).map(value => value.id), [winner.id])
        assert.equal((await store.session.findPending(sessionLookupKey(winner)))?.id, winner.id)
        for (const replaced of [first, second]) {
            for (const option of replaced.optionsWithTokens) {
                assert.equal(await store.session.findByToken(option.token), undefined)
            }
        }
    } finally {
        await store.close()
        await rm(dir, { recursive: true, force: true })
    }
})

test('sqlite: a second writer waits for the first connection to release its lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genshin-state-busy-'))
    const path = join(dir, 'state.db')
    const store = createSqliteStore(path)
    // This integration test needs a real cross-thread SQLite lock; fake timers
    // cannot advance the native busy handler or release another connection.
    const holdMs = 150
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads')
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(workerData.path)
        db.exec('BEGIN IMMEDIATE')
        parentPort.postMessage('locked')
        setTimeout(() => {
            db.exec('COMMIT')
            db.close()
            parentPort.postMessage('released')
        }, workerData.holdMs)
    `, { eval: true, workerData: { path, holdMs } })

    try {
        await new Promise<void>((resolve, reject) => {
            worker.once('error', reject)
            worker.once('message', message => message === 'locked' && resolve())
        })

        const startedAt = performance.now()
        await store.cooldown.apply('locked-writer', 10_000)
        const elapsedMs = performance.now() - startedAt

        assert.ok(elapsedMs >= holdMs / 2, `writer returned too early after ${elapsedMs}ms`)
        assert.ok(elapsedMs < 3_000, `writer waited unexpectedly long: ${elapsedMs}ms`)
        assert.equal(await store.cooldown.check('locked-writer'), true)
    } finally {
        await worker.terminate()
        await store.close()
        await rm(dir, { recursive: true, force: true })
    }
})
