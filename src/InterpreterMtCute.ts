/**
 * Production-level implementation of InteractionSig.S, StateSig.S, and QuizSourceSig.S
 * using mtcute for Telegram interactions, in-memory Maps with TTL for state, and
 * file-based quiz source from bot-data/quizzes.json.
 */

import type { TelegramClient } from '@mtcute/node'
import type {
    CallbackQuery_id,
    context,
    decision,
    log_kind,
    Message_id,
    Message_location,
    Peer_id,
    Peer_unknown,
    Peer_user,
    quiz,
    session,
} from './Domain.gen.js'

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { BotKeyboard, html } from '@mtcute/node'

import { env } from './env.js'

// ════════════════════════════════════════════════════════════════
// Runtime management
// ════════════════════════════════════════════════════════════════

let _tg: TelegramClient | undefined

export function setRuntime(client: TelegramClient): void {
    _tg = client
}

function tg(): TelegramClient {
    if (_tg === undefined) {
        throw new Error('[InterpreterMtCute] Runtime not initialized. Call setRuntime(tg) first.')
    }
    return _tg
}

// ════════════════════════════════════════════════════════════════
// Peer helpers
// ════════════════════════════════════════════════════════════════

export const toUnknownPeerId = (id: number): Peer_id<Peer_unknown> => id as Peer_id<Peer_unknown>
export const toUserPeerId = (id: number): Peer_id<Peer_user> => id as Peer_id<Peer_user>

function peerKey(chatId: Peer_id<Peer_unknown>, userId: Peer_id<Peer_user>): string {
    return `${chatId as number}:${userId as number}`
}

// ════════════════════════════════════════════════════════════════
// Monad: t<'a> = Promise<'a>
// ════════════════════════════════════════════════════════════════

export const pure = <T>(value: T): Promise<T> => Promise.resolve(value)

export function bind<T, U>(task: Promise<T>, fn: (value: T) => Promise<U>): Promise<U> {
    return task.then(fn)
}

// ════════════════════════════════════════════════════════════════
// InteractionSig.S — Telegram interactions via mtcute
// ════════════════════════════════════════════════════════════════

/** "60" → "1 分钟", "90" → "90 秒" — keeps the copy natural for round minutes. */
function formatDuration(sec: number): string {
    return sec % 60 === 0 ? `${sec / 60} 分钟` : `${sec} 秒`
}

/**
 * Present a verification challenge with inline keyboard buttons.
 * Sends an HTML-formatted message with one callback button per option.
 * The user's name comes from the triggering update — no extra getUser call.
 */
export async function interaction_presentChallenge(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, userFirstName: string, question: string, options: Array<[string, string]>, timeoutSec: number): Promise<Message_location<any>> {
    const ad = env.AD_LIST_URL
        ? html`<br>----------<br><b>广告时间：</b>希望加入更多米哈游相关群聊/频道?<br><a href="${env.AD_LIST_URL}">-->请戳我<--</a>`
        : ''

    const content = html`<b>入群验证</b><br>旅行者 <a href="tg://user?id=${userId as number}">${userFirstName}</a> 你好！<br>欢迎加入本群！请完成以下问题验证：<br>问题: ${question}<br>请在 ${formatDuration(timeoutSec)}内点击正确答案完成验证。${ad}`

    // Each option gets its own row with a callback button.
    // The callback data is the token (UUID), which is looked up in the token index.
    const keyboard = options.map(([label, token]) => [
        BotKeyboard.callback(label, token),
    ])

    const sent = await tg().sendText(chatId as number, content, {
        replyMarkup: BotKeyboard.inline(keyboard),
        disableWebPreview: true,
    })

    return [chatId, sent.id as Message_id]
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
                    console.error('[updateStatus] Retry without markup also failed:', retryErr)
                }
            }
            return
        }
        console.error('[updateStatus] Failed:', err)
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
        console.error('[acknowledgeClick] Failed:', err)
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
        console.error(`[enforceDecision] Failed (decision=${JSON.stringify(dec)}, ctx=${ctx}):`, err)
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
    console.log(`[Verification] ${ts} kind=${tag} chat=${chatId as number} user=${userId as number}`)
    try {
        const user = await tg().getUser(userId as number)
        const chat = await tg().getChat(chatId as number)
        const text = html`#${tag} <br><b>群:</b> ${'title' in chat ? chat.title : String(chatId)} <br>群ID: #GID${-chatId} <br><b>用户:</b> <a href="tg://user?id=${user.id}">${user.firstName}</a> <br>用户ID: #UID${user.id} <br><b>时间:</b> ${ts}`
        await tg().sendText(env.LOG_PEER, text, { disableWebPreview: true })
    } catch (err) {
        console.error('[logActivity] Failed to send log message:', err)
    }
}

function formatLogKind(kind: log_kind): string {
    if (kind === 'Request_start') return 'REQUEST_START'
    if (kind === 'Success') return 'SUCCESS'
    if (kind === 'Fail_timeout') return 'FAIL_TIMEOUT'
    if (kind === 'Fail_error') return 'FAIL_ERROR'
    return String(kind)
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
            } catch { /* message may already be deleted */ }
        }, TEMP_MESSAGE_TTL_MS)
    } catch (err: any) {
        console.error('[sendTempMessage] Failed:', err)
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
        } catch { /* message may already be deleted */ }
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
        console.error('[restrictUser] Failed:', err)
    }
}

// ════════════════════════════════════════════════════════════════
// StateSig.S — In-memory state with TTL-based auto-expiry
// ════════════════════════════════════════════════════════════════

/**
 * A Map that automatically expires entries after their TTL.
 * Supports periodic background sweeps to prevent unbounded memory growth.
 */
class TTLMap<K, V> {
    private _data = new Map<K, { value: V, expiresAt: number }>()
    private _timer: ReturnType<typeof setInterval>

    constructor(sweepIntervalMs: number = 60_000) {
        this._timer = setInterval(() => this._sweep(), sweepIntervalMs)
        // Allow Node.js process to exit naturally even with the timer
        if (typeof this._timer === 'object' && 'unref' in this._timer) {
            this._timer.unref()
        }
    }

    set(key: K, value: V, ttlMs: number): void {
        this._data.set(key, { value, expiresAt: Date.now() + ttlMs })
    }

    get(key: K): V | undefined {
        const entry = this._data.get(key)
        if (!entry) return undefined
        if (Date.now() > entry.expiresAt) {
            this._data.delete(key)
            return undefined
        }
        return entry.value
    }

    has(key: K): boolean {
        return this.get(key) !== undefined
    }

    delete(key: K): void {
        this._data.delete(key)
    }

    private _sweep(): void {
        const now = Date.now()
        for (const [key, entry] of this._data) {
            if (now > entry.expiresAt) {
                this._data.delete(key)
            }
        }
    }
}

// Safety net only: sessions are normally removed by claim (answer or 60s
// timeout); the TTL exists so that a lost timer can't leak entries forever.
const SESSION_TTL_MS = 5 * 60_000 // 5 minutes

// Session store: sessionId → session
const sessionById = new TTLMap<string, session>()
// Token reverse index: token → sessionId (all option tokens, not just correct)
const tokenIndex = new TTLMap<string, string>()
// Pending lookup: "chatId:userId" → sessionId
const lookupIndex = new TTLMap<string, string>()
// Cooldown: "chatId:userId" → true
const cooldownMap = new TTLMap<string, true>()

/**
 * Deferred observation for timeouts: wait, then peek the session store.
 * If the session was already claimed by the answer callback in the interim,
 * this resolves to `undefined` and the timeout path must no-op.
 * The final arbiter is still `session_claim` — the peek only avoids running
 * the timeout chain in the common (already-handled) case.
 * (Part of InteractionSig, but lives here next to the store it reads.)
 */
export async function interaction_waitAndPeekSession(sessionId: string, delaySec: number): Promise<session | undefined> {
    await new Promise(resolve => setTimeout(resolve, delaySec * 1000))

    const session = sessionById.get(sessionId)

    if (session) {
        console.log(`[Observer] Session ${sessionId} is still active after ${delaySec}s. Triggering timeout logic.`)
    } else {
        console.log(`[Observer] Session ${sessionId} was already handled/cleaned up. Skipping.`)
    }

    return session
}

// ── Cooldown ────────────────────────────────────────────────

export async function cooldown_check(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<boolean> {
    const key = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    return cooldownMap.has(key)
}

export async function cooldown_apply(chatId: Peer_id<any>, userId: Peer_id<Peer_user>, durationSec: number): Promise<void> {
    const key = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    cooldownMap.set(key, true, durationSec * 1000)
}

// ── Session ─────────────────────────────────────────────────

export async function session_save(s: session): Promise<void> {
    sessionById.set(s.id, s, SESSION_TTL_MS)

    // Index ALL option tokens → sessionId (not just the correct one).
    // This allows findByToken to work for any clicked button.
    for (const opt of s.optionsWithTokens) {
        tokenIndex.set(opt.token, s.id, SESSION_TTL_MS)
    }

    const lk = peerKey(s.chatId, s.userId)
    lookupIndex.set(lk, s.id, SESSION_TTL_MS)
}

export async function session_findByToken(token: string): Promise<session | undefined> {
    const sessionId = tokenIndex.get(token)
    if (sessionId === undefined) return undefined
    return sessionById.get(sessionId)
}

export async function session_findPending(chatId: Peer_id<any>, userId: Peer_id<Peer_user>): Promise<session | undefined> {
    const lk = peerKey(chatId as Peer_id<Peer_unknown>, userId)
    const sessionId = lookupIndex.get(lk)
    if (sessionId === undefined) return undefined
    return sessionById.get(sessionId)
}

/**
 * Atomically claim (remove and return) a session, including all token mappings
 * and the lookup index entry. This is the single removal primitive: competing
 * terminal paths (answer callback vs. timeout) both claim first, and only the
 * winner — the one that gets the session back — may act on it.
 *
 * Atomicity invariant: there must be NO `await` before the store mutations, so
 * the lookup + deletes run as one uninterrupted step on the event loop.
 */
export async function session_claim(id: string): Promise<session | undefined> {
    const claimed = sessionById.get(id)
    if (claimed === undefined) return undefined
    for (const opt of claimed.optionsWithTokens) {
        tokenIndex.delete(opt.token)
    }
    lookupIndex.delete(peerKey(claimed.chatId, claimed.userId))
    sessionById.delete(claimed.id)
    return claimed
}

/**
 * Update a session's verificationLocation field (set after the quiz message is sent).
 */
export async function session_updateLocation(s: session, loc: Message_location<Peer_unknown>): Promise<void> {
    const updated: session = { ...s, verificationLocation: loc }
    sessionById.set(s.id, updated, SESSION_TTL_MS)
}

// ════════════════════════════════════════════════════════════════
// QuizSourceSig.S — File-based quiz bank with hot-reload
// ════════════════════════════════════════════════════════════════

/** Raw JSON shape from bot-data/quizzes.json (PascalCase, matching C# bot format) */
interface RawQuiz {
    Id: number
    Question: string
    Options: string[]
    CorrectOptionIndex: number
}

const QUIZ_FILE_PATH = resolve(process.cwd(), 'bot-data/quizzes.json')

let quizBank: quiz[] = []

function parseQuizzes(raw: RawQuiz[]): quiz[] {
    return raw.map(r => ({
        id: r.Id,
        question: r.Question,
        options: r.Options,
        correctOptionIndex: r.CorrectOptionIndex,
    }))
}

async function loadQuizzesFromFile(): Promise<quiz[]> {
    const content = await readFile(QUIZ_FILE_PATH, 'utf-8')
    const raw: RawQuiz[] = JSON.parse(content)
    return parseQuizzes(raw)
}

/**
 * Initialize the quiz bank. Must be called once at startup, before the bot
 * starts processing updates.
 */
export async function initQuizBank(): Promise<void> {
    try {
        quizBank = await loadQuizzesFromFile()
        console.log(`[QuizSource] Loaded ${quizBank.length} quizzes from ${QUIZ_FILE_PATH}`)
    } catch (err) {
        console.error('[QuizSource] Failed to load quizzes at startup:', err)
        quizBank = []
    }
}

export async function quiz_getRandom(): Promise<quiz | undefined> {
    if (quizBank.length === 0) return undefined
    const idx = Math.floor(Math.random() * quizBank.length)
    return quizBank[idx]
}

export async function quiz_reload(): Promise<{ TAG: 'Ok', _0: void } | { TAG: 'Error', _0: string }> {
    try {
        quizBank = await loadQuizzesFromFile()
        console.log(`[QuizSource] Reloaded ${quizBank.length} quizzes`)
        return { TAG: 'Ok', _0: undefined }
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        console.error('[QuizSource] Reload failed:', msg)
        return { TAG: 'Error', _0: msg }
    }
}
