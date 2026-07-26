import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TTLMap } from './ttlMap.js'

test('set/get — value survives until its TTL, then expires', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
    const m = new TTLMap<string, number>()

    m.set('a', 1, 1000)
    assert.equal(m.get('a'), 1)

    t.mock.timers.tick(999)
    assert.equal(m.get('a'), 1)

    t.mock.timers.tick(2)
    assert.equal(m.get('a'), undefined)
})

test('has — reflects expiry', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
    const m = new TTLMap<string, true>()

    m.set('k', true, 500)
    assert.equal(m.has('k'), true)

    t.mock.timers.tick(501)
    assert.equal(m.has('k'), false)
    assert.equal(m.has('never-set'), false)
})

test('delete — removes immediately', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
    const m = new TTLMap<string, number>()

    m.set('a', 1, 10_000)
    m.delete('a')
    assert.equal(m.get('a'), undefined)
})

test('set — overwriting refreshes both value and TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
    const m = new TTLMap<string, number>()

    m.set('a', 1, 1000)
    t.mock.timers.tick(500)
    m.set('a', 2, 1000)

    // 700ms later the original TTL (t=1000) has passed but the refreshed one hasn't
    t.mock.timers.tick(700)
    assert.equal(m.get('a'), 2)

    t.mock.timers.tick(400)
    assert.equal(m.get('a'), undefined)
})

test('background sweep — expired entries are removed without a get', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'] })
    const m = new TTLMap<string, number>(1000)

    m.set('a', 1, 100)
    t.mock.timers.tick(1001) // one sweep past the entry's TTL
    assert.equal(m.get('a'), undefined)
})
