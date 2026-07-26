import type { ChatMemberUpdate } from '@mtcute/node'
import type { callback_input, start_input } from './Domain.gen.js'
import { Dispatcher, filters } from '@mtcute/dispatcher'

import { TelegramClient } from '@mtcute/node'
import * as AppBridge from './AppBridge.res.mjs'
import { env } from './env.js'
import { toUnknownPeerId, toUserPeerId } from './interpreter/peer.js'
import { initQuizBank } from './interpreter/quizSource.js'
import { setRuntime } from './interpreter/runtime.js'
import { stateStore } from './interpreter/state.js'
import { wasAddedByAdmin } from './joinPolicy.js'

const tg = new TelegramClient({
    apiId: env.API_ID,
    apiHash: env.API_HASH,
    storage: 'bot-data/session',
})

const dp = Dispatcher.for(tg)

// Without this, a throwing handler propagates out of the dispatch loop as an
// unhandled rejection. Log and mark handled — the verification flow's own
// safety net (timeout observer) resolves any half-finished session.
dp.onError((err, update) => {
    console.error(`[Dispatcher] Handler error on ${update.name}:`, err)
    return true
})

// Initialize runtime and quiz bank
setRuntime(tg)
await initQuizBank()

console.log('🚀 Starting bot')

// ── /ping health check ─────────────────────────────────────

dp.onNewMessage(
    filters.command('ping'),
    async (msg) => {
        await msg.answerText('Pong')
        console.log('Handled /ping command')
    },
)

// ── /reload — hot-reload quizzes (ADMIN_IDS only) ──────────

dp.onNewMessage(
    filters.command('reload'),
    async (msg) => {
        if (!env.ADMIN_IDS.includes(msg.sender.id)) {
            console.log(`[Reload] Ignored /reload from unauthorized user=${msg.sender.id}`)
            return
        }
        const result = await AppBridge.QuizSource.reload()
        if (result.TAG === 'Ok') {
            await msg.answerText('✅ 题库已重新加载。')
        } else {
            await msg.answerText(`❌ 重新加载失败: ${result._0}`)
        }
    },
)

// ── Join request verification ──────────────────────────────

dp.onBotChatJoinRequest(async (req) => {
    const chatId = toUnknownPeerId(Number(req.chat.id))
    const userId = toUserPeerId(Number(req.user.id))

    console.log(`[Event] Join request from user=${userId as number} chat=${chatId as number}`)

    const input: start_input = {
        userId,
        chatId,
        userChatId: toUnknownPeerId(Number(req.user.id)), // DM goes to user
        userFirstName: req.user.firstName ?? String(req.user.id),
        context: 'Join_request',
    }

    await AppBridge.App.startVerification(input)
})

// ── In-group member joined verification ────────────────────

dp.onChatMemberUpdate(
    filters.and(
        filters.chatMember(['joined', 'added']),
        filters.or(
            filters.chat('group'),
            filters.chat('supergroup'),
        ),
        (upd: ChatMemberUpdate) => !upd.user.isBot,
    ),
    async (upd) => {
        const chatId = toUnknownPeerId(Number(upd.chat.id))
        const userId = toUserPeerId(Number(upd.user.id))
        const actorId = Number(upd.actor.id)

        if (await wasAddedByAdmin(tg, chatId as number, userId as number, actorId)) {
            console.log(
                `[Event] User ${userId as number} was added/approved by admin ${actorId} in ${chatId as number}, skipping verification`,
            )
            return
        }

        console.log(`[Event] User ${userId as number} joined group ${chatId as number}`)

        const input: start_input = {
            userId,
            chatId,
            userChatId: chatId, // In-group: quiz is sent to the group itself
            userFirstName: upd.user.firstName ?? String(upd.user.id),
            context: 'In_group',
        }

        await AppBridge.App.startVerification(input)
    },
)

// ── Callback query (quiz answer button click) ──────────────

dp.onCallbackQuery(async (q) => {
    if (!q.dataStr) return

    const cbInput: callback_input = {
        callbackData: q.dataStr,
        queryId: q.id as unknown as callback_input['queryId'],
        userId: toUserPeerId(Number(q.user.id)),
        messageLocation: [
            toUnknownPeerId(Number(q.chat.id)),
            q.messageId as unknown as callback_input['messageLocation'][1],
        ],
    }

    await AppBridge.App.handleCallback(cbInput)
})

// ── Start the client ───────────────────────────────────────

const me = await tg.start({ botToken: env.BOT_TOKEN })
console.log(`✅ Logged in as @${me.username}`)

// ── Restart recovery ───────────────────────────────────────
// With a persistent backend, sessions survive a restart but their in-process
// timeout observers don't — re-arm one per pending session so nobody stays
// restricted forever. Double-arming is harmless: the observers' terminal
// paths all go through claim, and only one claimer can win.

const pendingSessions = await stateStore().session.listAll()
for (const session of pendingSessions) {
    AppBridge.App.armTimeoutObserver(session)
}
if (pendingSessions.length > 0) {
    console.log(`[Recovery] Re-armed timeout observers for ${pendingSessions.length} pending session(s)`)
}
