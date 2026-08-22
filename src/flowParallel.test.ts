import type { Message_location, Peer_unknown, session, start_input } from './Domain.gen.js'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Make } from './Flow.res.mjs'
import { peerKey } from './interpreter/peer.js'
import { createMemoryStore } from './interpreter/state/memoryStore.js'
import { bind, pure, recoverError } from './interpreter/task.js'

const input: start_input = {
    userId: 42,
    chatId: -100,
    userChatId: 42,
    userFirstName: 'Lumine',
    context: 'Join_request',
}

test('parallel starts leave one live pending session and clean the replaced challenge', async () => {
    const store = createMemoryStore()
    const presented: Message_location<Peer_unknown>[] = []
    const cleaned: Message_location<Peer_unknown>[] = []
    const decisions: string[] = []
    const saved: session[] = []

    let pendingReads = 0

    const pendingReadsGate = Promise.withResolvers<void>()
    const pendingReadsReady = pendingReadsGate.promise
    const releasePendingReads = pendingReadsGate.resolve

    const firstLocationGate = Promise.withResolvers<void>()
    const firstLocationPersisted = firstLocationGate.promise
    const releaseSecondSave = firstLocationGate.resolve

    const observerChecks: Array<() => void> = []

    const State = {
        Cooldown: {
            check: async () => false,
            apply: async () => {},
        },
        Session: {
            getById: (id: string) => store.session.getById(id),
            savePending: async (value: session) => {
                saved.push(value)
                if (saved.length === 2) await firstLocationPersisted
                return store.session.savePending(value, 10_000)
            },
            findByToken: (token: string) => store.session.findByToken(token),
            findPending: async (chatId: number, userId: number) => {
                const found = await store.session.findPending(peerKey(chatId, userId))
                if (pendingReads < 2) {
                    pendingReads += 1
                    if (pendingReads === 2) releasePendingReads()
                    await pendingReadsReady
                }
                return found
            },
            claim: (id: string) => store.session.claim(id),
            updateLocation: async (value: session, loc: Message_location<Peer_unknown>) => {
                const live = await store.session.updateLocation(value.id, loc, 10_000)
                if (saved[0]?.id === value.id) releaseSecondSave()
                return live
            },
        },
    }

    let nextId = 0
    const Runtime = {
        pure,
        bind,
        recoverError,
        nowMs: async () => Date.now(),
        randomUUID: () => `id-${nextId++}`,
        randomInt: () => 0,
        sleep: (_delayMs: number) => {
            const gate = Promise.withResolvers<void>()
            observerChecks.push(gate.resolve)
            return gate.promise
        },
        detach: (task: () => Promise<void>) => { void task() },
    }

    const Interaction = {
        presentChallenge: async () => {
            const loc: Message_location<Peer_unknown> = [-100, 1000 + presented.length]
            presented.push(loc)
            return loc
        },
        updateStatus: async () => {},
        acknowledgeClick: async () => {},
        enforceDecision: async (_chatId: number, _userId: number, decision: string) => {
            decisions.push(decision)
            return { TAG: 'Ok' as const, _0: undefined }
        },
        logActivity: async () => {},
        sendTempMessage: async () => {},
        scheduleMessageCleanup: async (loc: Message_location<Peer_unknown>) => {
            cleaned.push(loc)
        },
        restrictUser: async () => {},
    }

    const QuizSource = {
        getRandom: async () => ({
            id: 1,
            question: 'Question',
            options: ['A', 'B'],
            correctOptionIndex: 0,
        }),
        reload: async () => ({ TAG: 'Ok' as const, _0: undefined }),
    }

    const Flow = Make(Runtime)(Interaction)(State)(QuizSource)

    try {
        await Promise.all([
            Flow.startVerification(input),
            Flow.startVerification(input),
        ])

        assert.equal(presented.length, 2)
        assert.equal(saved.length, 2)
        assert.deepStrictEqual(cleaned, [presented[0]])
        assert.deepStrictEqual(decisions, [], 'slot eviction must not settle either session')

        const pending = await store.session.findPending(peerKey(input.chatId, input.userId))
        assert.equal(pending?.id, saved[1].id)
        assert.deepStrictEqual(pending?.verificationLocation, presented[1])
        assert.deepStrictEqual((await store.session.listAll()).map(value => value.id), [saved[1].id])

        for (const option of saved[0].optionsWithTokens) {
            assert.equal(await store.session.findByToken(option.token), undefined)
        }
        assert.equal((await store.session.findByToken(saved[1].correctToken))?.id, saved[1].id)

        observerChecks[0]?.()
        const settled = Promise.withResolvers<void>()
        setImmediate(settled.resolve)
        await settled.promise
        assert.deepStrictEqual(decisions, [], 'the replaced observer must become a no-op')
    } finally {
        if (saved[1]) await store.session.claim(saved[1].id)
        observerChecks[1]?.()
        await store.close()
    }
})
