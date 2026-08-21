import type { ErrorEvent } from '@sentry/node'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeValue, sanitizeEvent } from './sentry.js'

test('sanitizeEvent scrubs Telegram IDs only in logger_message extra', () => {
    const event: ErrorEvent = {
        type: undefined,
        extra: {
            logger_message: 'failed for user -1001234567890',
            request_id: '-1001234567890',
            attempts: 2,
        },
    }
    const originalLoggerMessage = 'failed for user -1001234567890'

    const sanitized = sanitizeEvent(event)

    assert.notEqual(sanitized.extra?.logger_message, originalLoggerMessage)
    assert.doesNotMatch(String(sanitized.extra?.logger_message), /-1001234567890/)
    assert.equal(sanitized.extra?.request_id, '-1001234567890')
    assert.equal(sanitized.extra?.attempts, 2)
})

test('describeValue returns an empty string for nullish values', () => {
    assert.equal(describeValue(undefined), '')
    assert.equal(describeValue(null), '')
})
