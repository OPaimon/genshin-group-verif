import assert from 'node:assert/strict'
import { test } from 'node:test'

import { recoverError } from './task.js'

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
