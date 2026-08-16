import { captureError } from './sentry.js'

/**
 * Single thin logging entry point.
 *
 * - debug/info/warn/error → console. When Sentry is enabled, every level at
 *   or above SENTRY_LOG_LEVEL is additionally captured by the console-logs
 *   integration (scrubbed by sentry.ts beforeSendLog).
 * - warn/error also create a Sentry error/warning event (no-op when Sentry is
 *   disabled), so failures are visible in Issues as well as Logs.
 *
 * Keep this API intentionally small: no transport/provider abstraction.
 * The third surface — Telegram LOG_PEER audit messages — is a business log,
 * not part of this logger; it lives in interpreter/interaction.ts.
 */

function describe(value: unknown): string {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function splitError(args: unknown[]): { error: unknown, context: string } {
    const errorIndex = args.findIndex(arg => arg instanceof Error)
    if (errorIndex === -1) {
        if (args.length === 1) {
            return { error: args[0], context: '' }
        }
        return { error: undefined, context: args.map(describe).filter(Boolean).join(' ') }
    }
    const context = args
        .filter((_, index) => index !== errorIndex)
        .map(describe)
        .filter(Boolean)
        .join(' ')
    return { error: args[errorIndex], context }
}

export const logger = {
    debug(...args: unknown[]): void {
        console.debug(...args)
    },

    info(...args: unknown[]): void {
        console.info(...args)
    },

    warn(...args: unknown[]): void {
        console.warn(...args)
        const { error, context } = splitError(args)
        captureError(error, 'warning', context)
    },

    error(...args: unknown[]): void {
        console.error(...args)
        const { error, context } = splitError(args)
        captureError(error, 'error', context)
    },
}
