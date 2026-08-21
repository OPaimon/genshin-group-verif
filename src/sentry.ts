import type { ErrorEvent, Log } from '@sentry/node'

import { createHash } from 'node:crypto'
import * as Sentry from '@sentry/node'

/**
 * Sentry is an opt-in error-monitoring sidecar.
 *
 * - SENTRY_DSN empty/absent → this module is a no-op (local dev default).
 * - Error monitoring: tracing is disabled, console and local-variable
 *   integrations are disabled so PII from ordinary logging can never leak
 *   into error events, and `beforeSend` scrubs Telegram-style numeric IDs as a
 *   second line of defence.
 * - Logging: Sentry Logs are enabled for console levels at or above
 *   SENTRY_LOG_LEVEL; `beforeSendLog` applies the same ID scrubbing to log
 *   messages and their structured attributes.
 * - The crash handlers live in main.ts (capture, flush, exit) — Sentry's own
 *   OnUncaughtException/OnUnhandledRejection integrations are disabled so the
 *   exit policy stays in one place.
 */

let initialized = false

const DISABLED_INTEGRATIONS = new Set([
    'Console',
    'LocalVariablesAsync',
    'OnUncaughtException',
    'OnUnhandledRejection',
])

const LOG_LEVEL_ORDER = ['debug', 'info', 'warn', 'error'] as const

const TELEGRAM_ID_PATTERN = /\b-?\d{7,13}\b/g

function hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex').slice(0, 10)
}

function scrubText(text: string): string {
    return text.replace(TELEGRAM_ID_PATTERN, match => `#${hashToken(match)}`)
}

/**
 * Last line of defence for the privacy policy: messages and exception values
 * may not contain raw long numeric tokens (Telegram IDs). Stack frames are
 * left untouched.
 */
export function sanitizeEvent(event: ErrorEvent): ErrorEvent {
    if (event.message) {
        event.message = scrubText(event.message)
    }
    for (const exception of event.exception?.values ?? []) {
        if (exception.value) {
            exception.value = scrubText(exception.value)
        }
    }
    if (typeof event.extra?.logger_message === 'string') {
        event.extra.logger_message = scrubText(event.extra.logger_message)
    }
    return event
}

/**
 * Recursively scrub log attributes: console args are stored under
 * `sentry.message.parameter.*` and numeric Telegram IDs arrive as numbers,
 * so a string-only scrub is not enough.
 */
function scrubValue(value: unknown): unknown {
    if (typeof value === 'string') return scrubText(value)
    if (typeof value === 'number') {
        const raw = String(value)
        return /^-?\d{7,13}$/.test(raw) ? `#${hashToken(raw)}` : value
    }
    if (Array.isArray(value)) return value.map(scrubValue)
    if (value !== null && typeof value === 'object') {
        const scrubbed: Record<string, unknown> = {}
        for (const [key, entry] of Object.entries(value)) {
            scrubbed[key] = scrubValue(entry)
        }
        return scrubbed
    }
    return value
}

function scrubAttributes(attributes?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!attributes) return attributes
    return scrubValue(attributes) as Record<string, unknown>
}

function sanitizeLog(log: Log): Log | null {
    log.message = scrubText(log.message) as Log['message']
    log.attributes = scrubAttributes(log.attributes)
    return log
}

export async function initSentry(): Promise<void> {
    // Load env lazily: importing env.ts executes its startup validation, and
    // this module is also reachable from logger.ts in test environments that
    // do not provide Telegram credentials.
    const { env } = await import('./env.js')
    if (!env.SENTRY_DSN) return

    Sentry.init({
        dsn: env.SENTRY_DSN,
        environment: env.SENTRY_ENVIRONMENT,
        tracesSampleRate: 0,
        registerEsmLoaderHooks: false,
        enableLogs: true,
        integrations: [
            ...Sentry.getDefaultIntegrationsWithoutPerformance()
                .filter(integration => !DISABLED_INTEGRATIONS.has(integration.name)),
            Sentry.consoleLoggingIntegration({
                levels: [...LOG_LEVEL_ORDER.slice(LOG_LEVEL_ORDER.indexOf(env.SENTRY_LOG_LEVEL))],
            }),
        ],
        beforeSend: env.SENTRY_SCRUB_PII ? sanitizeEvent : undefined,
        beforeSendLog: env.SENTRY_SCRUB_PII ? sanitizeLog : undefined,
    })

    initialized = true
}

export function describeValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    if (value === undefined || value === null) return ''
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

/**
 * Report an error-ish value to Sentry. `context` is the logger prefix/args
 * that accompanied the error; it is attached as `extra.logger_message` for
 * exceptions and folded into the message otherwise.
 */
export function captureError(error: unknown, level: 'error' | 'warning', context: string): void {
    if (!initialized) return

    if (error instanceof Error) {
        Sentry.captureException(error, {
            level,
            extra: context ? { logger_message: context } : undefined,
        })
        return
    }

    const described = describeValue(error)
    const message = (context
        ? `${context}${described ? ` ${described}` : ''}`
        : (described || 'unknown error')).trim()
    Sentry.captureMessage(message, level)
}

/** Flush queued events; used by the crash handlers before exit. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
    if (!initialized) return
    await Sentry.flush(timeoutMs)
}
