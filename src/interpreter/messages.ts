/**
 * All user-facing copy for the Telegram interpreter — pure builders,
 * no client access. Edit wording here without touching transport logic.
 */

import type { log_kind } from '../Domain.gen.js'

import { html } from '@mtcute/node'

/** "60" → "1 分钟", "90" → "90 秒" — keeps the copy natural for round minutes. */
export function formatDuration(sec: number): string {
    return sec % 60 === 0 ? `${sec / 60} 分钟` : `${sec} 秒`
}

export function formatLogKind(kind: log_kind): string {
    if (kind === 'Request_start') return 'REQUEST_START'
    if (kind === 'Success') return 'SUCCESS'
    if (kind === 'Fail_timeout') return 'FAIL_TIMEOUT'
    if (kind === 'Fail_error') return 'FAIL_ERROR'
    if (kind === 'Enforcement_failed') return 'ENFORCEMENT_FAILED'
    return String(kind)
}

/** The verification challenge text. `adListUrl` empty = no ad block. */
export function challengeMessage(opts: {
    userId: number
    userFirstName: string
    question: string
    timeoutSec: number
    adListUrl: string
}) {
    const ad = opts.adListUrl
        ? html`<br>----------<br><b>广告时间：</b>希望加入更多米哈游相关群聊/频道?<br><a href="${opts.adListUrl}">-->请戳我<--</a>`
        : ''

    return html`<b>入群验证</b><br>旅行者 <a href="tg://user?id=${opts.userId}">${opts.userFirstName}</a> 你好！<br>欢迎加入本群！请完成以下问题验证：<br>问题: ${opts.question}<br>请在 ${formatDuration(opts.timeoutSec)}内点击正确答案完成验证。${ad}`
}

export function activityLogMessage(opts: {
    tag: string
    chatTitle: string
    chatId: number
    userId: number
    userFirstName: string
    ts: string
}) {
    return html`#${opts.tag} <br><b>群:</b> ${opts.chatTitle} <br>群ID: #GID${-opts.chatId} <br><b>用户:</b> <a href="tg://user?id=${opts.userId}">${opts.userFirstName}</a> <br>用户ID: #UID${opts.userId} <br><b>时间:</b> ${opts.ts}`
}
