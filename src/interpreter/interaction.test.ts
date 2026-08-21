import type { TelegramClient } from '@mtcute/node'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { interaction_enforceDecision, interaction_restrictUser } from './interaction.js'
import { setRuntime } from './runtime.js'

test('restrictUser applies an indefinite quarantine and propagates Telegram failure', async () => {
    const failure = new Error('restrict failed')
    let params: Record<string, unknown> | undefined

    setRuntime({
        async restrictChatMember(input: Record<string, unknown>) {
            params = input
            throw failure
        },
    } as unknown as TelegramClient)

    await assert.rejects(
        interaction_restrictUser(-100 as never, 42 as never),
        error => error === failure,
    )
    assert.equal(params?.until, undefined)
    assert.equal((params?.restrictions as Record<string, unknown>).sendMessages, true)
})

test('enforceDecision returns Error and never rejects on Telegram failure', async () => {
    const failure = new Error('ban failed')

    setRuntime({
        async banChatMember() {
            throw failure
        },
    } as unknown as TelegramClient)

    assert.deepStrictEqual(
        await interaction_enforceDecision(-100 as never, 42 as never, 'Punish_soft', 'In_group'),
        { TAG: 'Error', _0: failure.message },
    )
})

test('enforceDecision returns Ok after a successful Telegram mutation', async () => {
    setRuntime({
        async banChatMember() {},
    } as unknown as TelegramClient)

    assert.deepStrictEqual(
        await interaction_enforceDecision(-100 as never, 42 as never, 'Punish_soft', 'In_group'),
        { TAG: 'Ok', _0: undefined },
    )
})
