import type { TelegramClient } from '@mtcute/node'

let _tg: TelegramClient | undefined

export function setRuntime(client: TelegramClient): void {
    _tg = client
}

export function tg(): TelegramClient {
    if (_tg === undefined) {
        throw new Error('[Interpreter] Runtime not initialized. Call setRuntime(tg) first.')
    }
    return _tg
}
