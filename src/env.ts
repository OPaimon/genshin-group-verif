import * as v from 'valibot'

function numericEnv(name: string) {
    return v.pipe(
        v.string(`${name} is required`),
        v.nonEmpty(`${name} is required`),
        v.transform(Number),
        v.number(`${name} must be a number`),
        v.finite(`${name} must be a finite number`),
    )
}

function requiredString(name: string) {
    return v.pipe(
        v.string(`${name} is required`),
        v.nonEmpty(`${name} is required`),
    )
}

const adminIdsSchema = v.pipe(
    v.optional(v.string(), ''),
    v.transform(value => value
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0)),
    v.array(v.pipe(
        v.string(),
        v.regex(/^[-+]?\d+(?:\.\d+)?$/, 'ADMIN_IDS must be a comma-separated list of numeric user IDs'),
        v.transform(Number),
        v.finite('ADMIN_IDS must be a comma-separated list of numeric user IDs'),
    )),
)

const truthyEnvSchema = v.pipe(
    v.optional(v.string(), ''),
    v.transform(value => ['true', '1', 'yes'].includes(value.toLowerCase().trim())),
)

const rawEnvSchema = v.object({
    API_ID: numericEnv('API_ID'),
    API_HASH: requiredString('API_HASH'),
    BOT_TOKEN: requiredString('BOT_TOKEN'),
    LOG_PEER: numericEnv('LOG_PEER'),
    ADMIN_IDS: adminIdsSchema,
    AD_LIST_URL: v.optional(v.string(), 'https://t.me/addlist/UEpWJGzDD6A1Y2I1'),
    STATE_BACKEND: v.optional(
        v.picklist(['memory', 'sqlite'], 'STATE_BACKEND must be one of "memory", "sqlite"'),
        'memory',
    ),
    STATE_SQLITE_PATH: v.optional(v.string(), 'bot-data/state.db'),
    SENTRY_DSN: v.optional(v.string(), ''),
    SENTRY_ENVIRONMENT: v.optional(v.string()),
    SENTRY_LOG_LEVEL: v.optional(
        v.picklist(
            ['debug', 'info', 'warn', 'error'],
            'SENTRY_LOG_LEVEL must be one of "debug", "info", "warn", "error"',
        ),
        'info',
    ),
    SENTRY_SCRUB_PII: truthyEnvSchema,
    NODE_ENV: v.optional(v.string()),
})

export interface Env {
    API_ID: number
    API_HASH: string
    BOT_TOKEN: string
    LOG_PEER: number
    SENTRY_DSN: string
    SENTRY_ENVIRONMENT: string
    SENTRY_LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error'
    ADMIN_IDS: number[]
    AD_LIST_URL: string
    STATE_BACKEND: 'memory' | 'sqlite'
    STATE_SQLITE_PATH: string
    SENTRY_SCRUB_PII: boolean
}

export function decodeEnv(input: Record<string, string | undefined>): Env {
    const result = v.safeParse(rawEnvSchema, input)
    if (!result.success) {
        const issue = result.issues[0]
        const field = issue.path?.[0]?.key
        const prefix = typeof field === 'string' ? `${field}: ` : ''
        throw new Error(`Invalid env: ${prefix}${issue.message}`)
    }

    const { NODE_ENV, ...parsed } = result.output
    return {
        ...parsed,
        SENTRY_ENVIRONMENT: parsed.SENTRY_ENVIRONMENT ?? (NODE_ENV === 'production' ? 'production' : 'development'),
    }
}

export const env = decodeEnv(process.env)
