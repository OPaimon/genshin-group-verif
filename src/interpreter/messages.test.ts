import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityLogMessage, challengeMessage, formatDuration, formatLogKind } from './messages.js'

test('formatDuration — round minutes as 分钟, otherwise 秒', () => {
    assert.equal(formatDuration(60), '1 分钟')
    assert.equal(formatDuration(120), '2 分钟')
    assert.equal(formatDuration(90), '90 秒')
    assert.equal(formatDuration(1), '1 秒')
})

test('formatLogKind — maps every log_kind to its tag', () => {
    assert.equal(formatLogKind('Request_start'), 'REQUEST_START')
    assert.equal(formatLogKind('Success'), 'SUCCESS')
    assert.equal(formatLogKind('Fail_timeout'), 'FAIL_TIMEOUT')
    assert.equal(formatLogKind('Fail_error'), 'FAIL_ERROR')
})

test('challengeMessage — includes name, question, and rendered timeout', () => {
    const msg = challengeMessage({
        userId: 42,
        userFirstName: 'Lumine',
        question: '提瓦特大陆有几个国家？',
        timeoutSec: 60,
        adListUrl: '',
    })
    assert.ok(msg.text.includes('Lumine'))
    assert.ok(msg.text.includes('提瓦特大陆有几个国家？'))
    assert.ok(msg.text.includes('1 分钟'))
})

test('challengeMessage — empty adListUrl disables the ad block', () => {
    const msg = challengeMessage({
        userId: 42,
        userFirstName: 'Lumine',
        question: 'Q',
        timeoutSec: 60,
        adListUrl: '',
    })
    assert.ok(!msg.text.includes('广告时间'))
})

test('challengeMessage — adListUrl set appends the ad block with the link', () => {
    const msg = challengeMessage({
        userId: 42,
        userFirstName: 'Lumine',
        question: 'Q',
        timeoutSec: 60,
        adListUrl: 'https://t.me/addlist/example',
    })
    assert.ok(msg.text.includes('广告时间'))
    assert.ok((msg.entities ?? []).some(e => e._ === 'messageEntityTextUrl' && e.url === 'https://t.me/addlist/example'))
})

test('activityLogMessage — tags, negated #GID, and #UID', () => {
    const msg = activityLogMessage({
        tag: 'SUCCESS',
        chatTitle: '测试群',
        chatId: -1001234,
        userId: 42,
        userFirstName: 'Lumine',
        ts: '2026-07-26T00:00:00.000Z',
    })
    assert.ok(msg.text.includes('#SUCCESS'))
    assert.ok(msg.text.includes('测试群'))
    assert.ok(msg.text.includes('#GID1001234'))
    assert.ok(msg.text.includes('#UID42'))
})
