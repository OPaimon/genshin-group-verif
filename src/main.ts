import type { ChatMemberUpdate } from '@mtcute/node'
import type { callback_input, start_input } from './Domain.gen.js'
import { Dispatcher, filters } from '@mtcute/dispatcher'

import { TelegramClient } from '@mtcute/node'
import * as AppBridge from './AppBridge.res.mjs'
import { env } from './env.js'
import { toUnknownPeerId, toUserPeerId } from './interpreter/peer.js'
import { initQuizBank } from './interpreter/quizSource.js'
import { setRuntime } from './interpreter/runtime.js'

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

        if (actorId !== (userId as number)) {
            try {
                const member = await tg.getChatMember({
                    chatId: chatId as number,
                    userId: actorId,
                })
                const status = member?.status
                if (status === 'creator' || status === 'admin') {
                    console.log(
                        `[Event] User ${userId as number} was added/approved by admin ${actorId} in ${chatId as number}, skipping verification`,
                    )
                    return
                }
            } catch {
                // If we can't look up the actor, proceed with verification
                // to be safe (don't let lookup failures bypass security).
            }
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
