/**
 * Conformance suite for StateStore backends. Every backend must pass the
 * exact same contract — import runStoreContract from a *.test.ts file and
 * hand it a store factory.
 *
 * TTL tests use real (short) timers, not mocks: persistent backends expire
 * against the wall clock, so mocked time would test nothing.
 */

import type { session } from '../../Domain.gen.js'
import type { StateStore } from './store.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { Message_at } from '../../Domain.gen.js'
import { toUnknownPeerId, toUserPeerId } from '../peer.js'
import { sessionLookupKey } from './store.js'

const TTL = 10_000 // long enough to never expire mid-test
const SHORT_TTL = 100 // for expiry tests
const EXPIRY_WAIT = 300 // comfortably past SHORT_TTL even on slow CI

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function makeSession(overrides: Partial<session> = {}): session {
    const id = overrides.id ?? randomUUID()
    return {
        id,
        chatId: toUnknownPeerId(-1001234567890),
        userId: toUserPeerId(4242),
        correctToken: `tok-a-${id}`,
        context: 'In_group',
        optionsWithTokens: [
            { optionText: 'A', token: `tok-a-${id}` },
            { optionText: 'B', token: `tok-b-${id}` },
            { optionText: 'C', token: `tok-c-${id}` },
        ],
        verificationLocation: undefined,
        ...overrides,
    }
}

/**
 * Compare sessions modulo the None ↔ missing-key distinction: ReScript's
 * option maps None to undefined, which a JSON round-trip drops entirely, so
 * both shapes mean the same domain value.
 */
function assertSameSession(got: session | undefined, want: session): void {
    assert.ok(got !== undefined, 'expected a session, got undefined')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(want)))
}

export function runStoreContract(name: string, makeStore: () => Promise<StateStore> | StateStore): void {
    const contractTest = (title: string, fn: (store: StateStore) => Promise<void>): void => {
        test(`${name}: ${title}`, async () => {
            const store = await makeStore()
            try {
                await fn(store)
            } finally {
                await store.close()
            }
        })
    }

    contractTest('save → findByToken finds the session via every option token', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)
        for (const opt of s.optionsWithTokens) {
            assertSameSession(await store.session.findByToken(opt.token), s)
        }
        assert.equal(await store.session.findByToken('no-such-token'), undefined)
    })

    contractTest('save → findPending finds the session by lookup key', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)
        assertSameSession(await store.session.findPending(sessionLookupKey(s)), s)
        assert.equal(await store.session.findPending('999:999'), undefined)
    })

    contractTest('getById round-trips; unknown id → undefined', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)
        assertSameSession(await store.session.getById(s.id), s)
        assert.equal(await store.session.getById('no-such-id'), undefined)
    })

    contractTest('claim returns the session once and removes all its entries', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)

        assertSameSession(await store.session.claim(s.id), s)

        assert.equal(await store.session.claim(s.id), undefined, 'second claim must lose')
        assert.equal(await store.session.getById(s.id), undefined)
        assert.equal(await store.session.findPending(sessionLookupKey(s)), undefined)
        for (const opt of s.optionsWithTokens) {
            assert.equal(await store.session.findByToken(opt.token), undefined)
        }
    })

    contractTest('concurrent claims — exactly one winner', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)

        const results = await Promise.all(
            Array.from({ length: 5 }, () => store.session.claim(s.id)),
        )
        const winners = results.filter(r => r !== undefined)
        assert.equal(winners.length, 1)
        assertSameSession(winners[0], s)
    })

    contractTest('updateLocation sets verificationLocation on a live session', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)

        const loc = Message_at(s.chatId, 777)
        await store.session.updateLocation(s.id, loc, TTL)

        assertSameSession(await store.session.getById(s.id), { ...s, verificationLocation: loc })
        assertSameSession(
            await store.session.findByToken(s.correctToken),
            { ...s, verificationLocation: loc },
        )
    })

    contractTest('updateLocation after claim does NOT resurrect the session', async (store) => {
        const s = makeSession()
        await store.session.save(s, TTL)
        await store.session.claim(s.id)

        const loc = Message_at(s.chatId, 777)
        await store.session.updateLocation(s.id, loc, TTL)

        assert.equal(await store.session.getById(s.id), undefined)
        assert.deepStrictEqual(await store.session.listAll(), [])
    })

    contractTest('sessions expire after their TTL', async (store) => {
        const s = makeSession()
        await store.session.save(s, SHORT_TTL)
        await sleep(EXPIRY_WAIT)

        assert.equal(await store.session.getById(s.id), undefined)
        assert.equal(await store.session.findByToken(s.correctToken), undefined)
        assert.equal(await store.session.findPending(sessionLookupKey(s)), undefined)
        assert.equal(await store.session.claim(s.id), undefined, 'claim must not win an expired session')
    })

    contractTest('newer session wins the pending lookup for the same user', async (store) => {
        const s1 = makeSession()
        const s2 = makeSession({ chatId: s1.chatId, userId: s1.userId })
        await store.session.save(s1, TTL)
        await store.session.save(s2, TTL)

        assertSameSession(await store.session.findPending(sessionLookupKey(s1)), s2)
    })

    contractTest('listAll returns live sessions and omits claimed ones', async (store) => {
        const a = makeSession({ userId: toUserPeerId(1) })
        const b = makeSession({ userId: toUserPeerId(2) })
        await store.session.save(a, TTL)
        await store.session.save(b, TTL)
        await store.session.claim(a.id)

        const all = await store.session.listAll()
        assert.equal(all.length, 1)
        assertSameSession(all[0], b)
    })

    contractTest('cooldown: apply → check true, expires after TTL', async (store) => {
        assert.equal(await store.cooldown.check('1:2'), false)

        await store.cooldown.apply('1:2', SHORT_TTL)
        assert.equal(await store.cooldown.check('1:2'), true)
        assert.equal(await store.cooldown.check('1:3'), false, 'other keys unaffected')

        await sleep(EXPIRY_WAIT)
        assert.equal(await store.cooldown.check('1:2'), false)
    })
}
