import assert from 'node:assert/strict'
import { test } from 'node:test'

import { logger } from '../logger.js'
import { detach, recoverError } from './task.js'

test('recoverError catches a synchronous throw while creating the effect', async () => {
    const result = await recoverError(
        () => { throw new Error('sync failure') },
        async error => error instanceof Error ? error.message : String(error),
    )

    assert.equal(result, 'sync failure')
})

test('recoverError catches a rejected effect', async () => {
    const result = await recoverError(
        async () => { throw new Error('async failure') },
        async error => error instanceof Error ? error.message : String(error),
    )

    assert.equal(result, 'async failure')
})

test('detach contains a rejected observer task', async () => {
    let leaked: unknown
    const onUnhandled = (reason: unknown) => { leaked = reason }
    process.once('unhandledRejection', onUnhandled)
    const originalError = logger.error
    logger.error = () => {}

    try {
        detach(async () => { throw new Error('observer failure') })
        const { promise, resolve } = Promise.withResolvers<void>()
        setImmediate(resolve)
        await promise
        assert.equal(leaked, undefined)
    } finally {
        logger.error = originalError
        process.removeListener('unhandledRejection', onUnhandled)
    }
})
