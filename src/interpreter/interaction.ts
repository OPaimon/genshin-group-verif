/**
 * InteractionSig.S — Telegram interactions via mtcute.
 * Message copy lives in ./messages.ts; this module is transport + error policy.
 */

import type {
    CallbackQuery_id,
    context,
    decision,
    log_kind,
    Message_id,
    Message_location,
    Peer_id,
    Peer_user,
} from '../Domain.gen.js'

import { BotKeyboard } from '@mtcute/node'

import { env } from '../env.js'
import { logger } from '../logger.js'
import { activityLogMessage, challengeMessage, formatLogKind } from './messages.js'
import { tg } from './runtime.js'

/**
 * Present a verification challenge with inline keyboard buttons.
 * Sends an HTML-formatted message with one callback button per option.
 * The user's name comes from the triggering update — no extra getUser call.
 * Returns `undefined` when the challenge message cannot be sent (e.g. the
 * user was deleted while their join request was pending); the flow layer
 * then treats the verification as failed and declines/kicks immediately.
 */
export async function interaction_presentChallenge(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, userFirstName: string, question: string, options: Array<[string, string]>, timeoutSec: number): Promise<Message_location<any> | undefined> {
    const content = challengeMessage({
        userId: userId as number,
        userFirstName,
        question,
        timeoutSec,
        adListUrl: env.AD_LIST_URL,
    })

    // Each option gets its own row with a callback button.
    // The callback data is the token (UUID), which is looked up in the token index.
    const keyboard = options.map(([label, token]) => [
        BotKeyboard.callback(label, token),
    ])

    try {
        const sent = await tg().sendText(chatId as number, content, {
            replyMarkup: BotKeyboard.inline(keyboard),
            disableWebPreview: true,
        })

        return [chatId, sent.id as Message_id]
    } catch (err: any) {
        logger.error('[presentChallenge] Failed to send verification question:', err)
        return undefined
    }
}

/**
 * Edit the verification message to show a status text and remove inline keyboard.
 */
export async function interaction_updateStatus(loc: Message_location<any>, status: string): Promise<void> {
    const [chatId, msgId] = loc
    try {
        // Pass raw TL replyInlineMarkup to remove inline keyboard.
        // BotKeyboard.inline([]) is also accepted but we use raw TL
        // to make the intent explicit.
        await tg().editMessage({
            chatId: chatId as number,
            message: msgId as number,
            text: status,
            replyMarkup: { _: 'replyInlineMarkup', rows: [] },
        })
    } catch (err: any) {
        // mtcute RpcError stores the Telegram error code in `err.text`
        // (e.g. "REPLY_MARKUP_INVALID"), not in `err.message` which
        // holds the human-readable description.
        const errText: string = err?.text ?? ''

        // MESSAGE_NOT_MODIFIED is benign (status already matches).
        if (errText === 'MESSAGE_NOT_MODIFIED') {
            return
        }
        // REPLY_MARKUP_INVALID can happen in DMs where the bot authored the
        // message — fall back to editing without touching the markup.
        if (errText === 'REPLY_MARKUP_INVALID') {
            try {
                await tg().editMessage({
                    chatId: chatId as number,
                    message: msgId as number,
                    text: status,
                })
            } catch (retryErr: any) {
                if (retryErr?.text !== 'MESSAGE_NOT_MODIFIED') {
                    logger.error('[updateStatus] Retry without markup also failed:', retryErr)
                }
            }
            return
        }
        logger.error('[updateStatus] Failed:', err)
    }
}

/**
 * Answer a callback query — shows a toast or alert to the user who clicked.
 * The queryId is passed through from mtcute's Long type, cast via BigInt in Domain.
 */
export async function interaction_acknowledgeClick(queryId: CallbackQuery_id, text: string, showAlert: boolean): Promise<void> {
    try {
        // queryId flows from main.ts where it's cast from mtcute's Long (tl.Long).
        // answerCallbackQuery accepts Long | CallbackQuery — we pass it as-is
        // since the underlying value is already the correct mtcute Long.
        await tg().answerCallbackQuery(queryId as any, {
            text,
            alert: showAlert,
        })
    } catch (err: any) {
        logger.error('[acknowledgeClick] Failed:', err)
    }
}

/**
 * Enforce a verification decision:
 *  - Grant_access: unrestrict (in_group) or approve join request
 *  - Punish_soft:  kick (in_group) or decline join request
 */
export async function interaction_enforceDecision(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, dec: decision, ctx: context): Promise<void> {
    const chat = chatId as number
    const user = userId as number

    try {
        if (dec === 'Grant_access') {
            if (ctx === 'In_group') {
                // Lift all restrictions by passing empty restrictions + short untilDate
                await tg().restrictChatMember({
                    chatId: chat,
                    userId: user,
                    restrictions: {},
                    until: Date.now() + 60_000,
                })
            } else {
                // ctx === 'Join_request': approve
                await tg().hideJoinRequest({
                    chatId: chat,
                    user,
                    action: 'approve',
                })
            }
        } else {
            // dec === 'Punish_soft'
            if (ctx === 'In_group') {
                // Kick: short ban that auto-expires, so they may rejoin
                await tg().banChatMember({
                    chatId: chat,
                    participantId: user,
                    untilDate: Date.now() + 60_000,
                })
            } else {
                // ctx === 'Join_request': decline
                await tg().hideJoinRequest({
                    chatId: chat,
                    user,
                    action: 'decline',
                })
            }
        }
    } catch (err: any) {
        logger.error(`[enforceDecision] Failed (decision=${JSON.stringify(dec)}, ctx=${ctx}):`, err)
    }
}

/**
 * Log verification activity to console and to the LOG_PEER channel.
 *
 * Logging must NEVER break the verification flow — the flow layer has no
 * failure handling and a rejection here would sever the effect chain (and,
 * before the claim/observer refactor, could strand a restricted user).
 * Every Telegram call in this function is therefore inside the try block.
 */
export async function interaction_logActivity(kind: log_kind, chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<void> {
    const ts = new Date().toISOString()
    const tag = formatLogKind(kind)
    logger.info(`[Verification] ${ts} kind=${tag} chat=${chatId as number} user=${userId as number}`)
    try {
        const user = await tg().getUser(userId as number)
        const chat = await tg().getChat(chatId as number)
        const text = activityLogMessage({
            tag,
            chatTitle: 'title' in chat ? chat.title : String(chatId),
            chatId: chatId as number,
            userId: user.id,
            userFirstName: user.firstName,
            ts,
        })
        await tg().sendText(env.LOG_PEER, text, { disableWebPreview: true })
    } catch (err) {
        logger.error('[logActivity] Failed to send log message:', err)
    }
}

// How long transient notices (cooldown / stale-session / no-quiz) stay visible.
const TEMP_MESSAGE_TTL_MS = 10_000

/**
 * Send a temporary message that auto-deletes after TEMP_MESSAGE_TTL_MS.
 */
export async function interaction_sendTempMessage(chatId: Peer_id<any>, text: string): Promise<void> {
    try {
        const sent = await tg().sendText(chatId as number, text)
        setTimeout(async () => {
            try {
                await tg().deleteMessagesById(chatId as number, [sent.id])
            } catch (err) { logger.debug('[sendTempMessage] Cleanup delete failed (ignored):', err) }
        }, TEMP_MESSAGE_TTL_MS)
    } catch (err: any) {
        logger.error('[sendTempMessage] Failed:', err)
    }
}

/**
 * Schedule a message for deletion after a delay.
 */
export async function interaction_scheduleMessageCleanup(loc: Message_location<any>, delaySec: number): Promise<void> {
    const [chatId, msgId] = loc
    setTimeout(async () => {
        try {
            await tg().deleteMessagesById(chatId as number, [msgId as number])
        } catch (err) { logger.debug('[scheduleMessageCleanup] Delete failed (ignored):', err) }
    }, delaySec * 1000)
}

/**
 * Mute a user in a supergroup while their verification is pending.
 * Note: mtcute's restrictChatMember only supports supergroups/channels;
 * for basic groups this throws and is swallowed (no mute happens).
 */
export async function interaction_restrictUser(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<void> {
    try {
        await tg().restrictChatMember({
            chatId: chatId as number,
            userId: userId as number,
            restrictions: {
                sendMessages: true,
                sendMedia: true,
                sendStickers: true,
                sendGifs: true,
                sendGames: true,
                sendInline: true,
                sendPolls: true,
                changeInfo: true,
                inviteUsers: true,
                pinMessages: true,
                manageTopics: true,
                sendPhotos: true,
                sendVideos: true,
                sendRoundvideos: true,
                sendAudios: true,
                sendVoices: true,
                sendDocs: true,
                sendPlain: true,
            },
        })
    } catch (err: any) {
        logger.error('[restrictUser] Failed:', err)
    }
}
