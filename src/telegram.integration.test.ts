/**
 * Real-Telegram-API integration tests (NOT part of the default `pnpm test`).
 *
 * The unit suite mocks the TelegramClient seam (setRuntime); these tests run
 * the real interaction.ts boundary against real Telegram servers through a
 * real bot login, covering the failure classes mock interactions cannot:
 * permission failures, message-send failures, and a chat the bot no longer
 * has access to (removed / never joined).
 *
 * Required env (all namespaced TG_INTEGRATION_* so the production BOT_TOKEN
 * can never leak into a test run):
 *   TG_INTEGRATION_API_ID       — Telegram API id
 *   TG_INTEGRATION_API_HASH     — Telegram API hash
 *   TG_INTEGRATION_BOT_TOKEN    — the bot token under test
 *   TG_INTEGRATION_GROUP_ID     — numeric id of a group where the bot is a member.
 *                                 The bot must be able to send messages there; admin
 *                                 rights are NOT required (permission-failure probes
 *                                 target a member the bot may not act on).
 * Optional env:
 *   TG_INTEGRATION_TEST_USER_ID     — a human user id in that group (member-visibility probe)
 *   TG_INTEGRATION_STRANGER_CHAT_ID — a chat the bot cannot access (removed from it, or
 *                                     never joined). Enables the removed-bot failure-class suite.
 *
 * Without the required env the whole file reports nothing and exits 0, so
 * `node --test` stays green for contributors without credentials. CI runs
 * this file in a dedicated opt-in job when the maintainer configures the
 * secrets (see .github/workflows/ci.yml).
 *
 * Safety rules for the probes:
 *   - Destructive enforcement probes never target a real member while the bot
 *     holds admin rights: the target falls back to the chat id itself, which
 *     Telegram always rejects as an invalid participant.
 *   - Message-send failure probes use a syntactically valid but unreachable
 *     peer id, so no third party ever receives a test message.
 *
 * Run locally:
 *   pnpm test:integration
 */

process.env.API_ID ??= '1'
process.env.API_HASH ??= 'integration-test'
process.env.BOT_TOKEN ??= 'integration-test'
process.env.LOG_PEER ??= '1'

const apiId = process.env.TG_INTEGRATION_API_ID
const apiHash = process.env.TG_INTEGRATION_API_HASH
const botToken = process.env.TG_INTEGRATION_BOT_TOKEN
const groupId = process.env.TG_INTEGRATION_GROUP_ID
const testUserId = process.env.TG_INTEGRATION_TEST_USER_ID
const strangerChatId = process.env.TG_INTEGRATION_STRANGER_CHAT_ID

const hasCreds = Boolean(apiId && apiHash && botToken && groupId)

if (!hasCreds) {
    console.log('[telegram.integration] TG_INTEGRATION_* env not configured — skipping real-API tests.')
} else {
    const { TelegramClient } = await import('@mtcute/node')
    const assert = (await import('node:assert/strict')).default
    const { after, test } = await import('node:test')
    const { rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const {
        interaction_enforceDecision,
        interaction_presentChallenge,
        interaction_restrictUser,
        interaction_scheduleMessageCleanup,
        interaction_updateStatus,
    } = await import('./interpreter/interaction.js')
    const { setRuntime } = await import('./interpreter/runtime.js')

    const chatId = Number.parseInt(groupId!, 10)
    assert.ok(Number.isFinite(chatId), 'TG_INTEGRATION_GROUP_ID must be a numeric chat id')

    const sessionDir = join(tmpdir(), `ggv-integration-${Date.now()}`)
    const client = new TelegramClient({
        apiId: Number(apiId),
        apiHash: apiHash!,
        storage: join(sessionDir, 'session'),
        disableUpdates: true,
    })

    setRuntime(client)

    const me = await client.start({ botToken: botToken! })
    console.log(`[telegram.integration] logged in as @${me.username}; target chat ${chatId}`)

    /**
     * Target for restriction/enforcement probes. When the bot holds admin
     * rights, a real member would genuinely be restricted/kicked — so the
     * probe falls back to the chat id, which Telegram always rejects as an
     * invalid member target. Without admin rights any target fails anyway,
     * which is exactly the permission-failure class being exercised.
     */
    const enforcementProbeTarget = async (): Promise<number> => {
        const self = await client.getChatMember(chatId, 'self')
        const botIsAdmin = self !== null && (self.status === 'admin' || self.status === 'creator')
        return botIsAdmin ? chatId : (testUserId ? Number.parseInt(testUserId, 10) : chatId)
    }

    after(async () => {
        try {
            await client.close()
        } finally {
            await rm(sessionDir, { recursive: true, force: true })
        }
    })

    test('setup: the bot is a member of the target group', async () => {
        const self = await client.getChatMember(chatId, 'self')
        assert.ok(self !== null, 'bot is not a member of TG_INTEGRATION_GROUP_ID')
        console.log(`[telegram.integration] bot member status in group: ${self.status}`)
    })

    test('setup: test user is visible in the target group', { skip: !testUserId }, async () => {
        const member = await client.getChatMember(chatId, Number(testUserId))
        assert.ok(member !== null, `user ${testUserId} is not a member of the target group`)
    })

    test('permission failure: restrictUser rethrows the Telegram error (#25 contract)', async () => {
        const target = await enforcementProbeTarget()
        await assert.rejects(
            interaction_restrictUser(chatId as never, target as never),
            error => error instanceof Error,
        )
    })

    test('permission failure: enforceDecision returns Error and never rejects (Punish_soft, In_group)', async () => {
        const target = await enforcementProbeTarget()
        const result = await interaction_enforceDecision(chatId as never, target as never, 'Punish_soft', 'In_group')
        assert.equal(result.TAG, 'Error')
        assert.equal(typeof result._0, 'string')
        assert.ok((result._0 as string).length > 0)
    })

    test('message send failure: presentChallenge to an unreachable peer returns undefined', async () => {
        // Peer id 1 is syntactically valid but unreachable for a bot; the send
        // fails and the interaction boundary must report that as `undefined`
        // so the flow can decline/kick immediately.
        const loc = await interaction_presentChallenge(chatId as never, 1 as never, 'Integration Test', '问题？', [
            ['A', 'tok-a'],
            ['B', 'tok-b'],
        ], 60)
        assert.equal(loc, undefined)
    })

    test('happy path: challenge send → status edit → scheduled cleanup against the real group', async () => {
        const sent = await interaction_presentChallenge(
            chatId as never,
            (testUserId ? Number.parseInt(testUserId, 10) : chatId) as never,
            'Integration Test',
            '1 + 1 = ?',
            [
                ['2', 'tok-correct'],
                ['3', 'tok-wrong'],
            ],
            60,
        )
        assert.ok(sent !== undefined, 'challenge send failed — can the bot send messages into the target group?')

        await interaction_updateStatus(sent as never, '集成测试：状态更新成功')
        // Real (short) cleanup delay — the delete is fire-and-forget inside the
        // interaction; give it time to land. Delete failures are logged, never
        // thrown, by design.
        await interaction_scheduleMessageCleanup(sent as never, 1)
        await new Promise(resolve => setTimeout(resolve, 2500))
    })

    test('removed-bot failure class: every call degrades gracefully in an inaccessible chat', { skip: !strangerChatId }, async (t) => {
        const strangerId = Number.parseInt(strangerChatId!, 10)
        assert.ok(Number.isFinite(strangerId), 'TG_INTEGRATION_STRANGER_CHAT_ID must be a numeric chat id')

        // The bot has no access to this chat (removed from it, or never a
        // member). Everything below must fail softly — never crash, never
        // reject — because these paths run detached inside the flow.

        await t.test('presentChallenge → undefined', async () => {
            const loc = await interaction_presentChallenge(
                strangerId as never,
                (testUserId ? Number.parseInt(testUserId, 10) : strangerId) as never,
                'X',
                'Q?',
                [['A', 'tok-x']],
                60,
            )
            assert.equal(loc, undefined)
        })

        await t.test('updateStatus resolves (failure logged, not thrown)', async () => {
            await interaction_updateStatus([strangerId, 1] as never, 'status')
        })

        await t.test('scheduleMessageCleanup resolves (failure logged, not thrown)', async () => {
            await interaction_scheduleMessageCleanup([strangerId, 1] as never, 0)
            await new Promise(resolve => setTimeout(resolve, 500))
        })

        await t.test('enforceDecision → Error result, never rejects', async () => {
            const result = await interaction_enforceDecision(
                strangerId as never,
                (testUserId ? Number.parseInt(testUserId, 10) : strangerId) as never,
                'Punish_soft',
                'In_group',
            )
            assert.equal(result.TAG, 'Error')
        })
    })
}
