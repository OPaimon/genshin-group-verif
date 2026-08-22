/**
 * QuizSourceSig.S — file-based quiz bank with hot-reload,
 * loaded from bot-data/quizzes.json.
 */

import type { quiz } from '../Domain.gen.js'

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as v from 'valibot'

import { logger } from '../logger.js'

const QUIZ_FILE_PATH = resolve(process.cwd(), 'bot-data/quizzes.json')

let quizBank: quiz[] = []

function nonBlankString(field: string) {
    return v.pipe(
        v.string(`${field} must be a string`),
        v.check(value => value.trim().length > 0, `${field} must be a non-empty string`),
    )
}

const rawQuizSchema = v.object({
    Id: v.pipe(v.number('Id must be a number'), v.integer('Id must be an integer')),
    Question: nonBlankString('Question'),
    Options: v.pipe(
        v.array(nonBlankString('option'), 'Options must be an array'),
        v.minLength(2, 'Options must contain at least two options'),
    ),
    CorrectOptionIndex: v.pipe(
        v.number('CorrectOptionIndex must be a number'),
        v.integer('CorrectOptionIndex must be an integer'),
    ),
})

function quizLabel(index: number, input: unknown): string {
    if (typeof input === 'object' && input !== null && 'Id' in input) {
        if (typeof input.Id === 'number' || typeof input.Id === 'string') {
            return `Quiz ${index + 1} (ID ${input.Id})`
        }
    }
    return `Quiz ${index + 1}`
}

function issueLocation(issue: v.BaseIssue<unknown>): string {
    const keys = issue.path?.map(item => item.key) ?? []
    if (keys[0] === 'Options' && typeof keys[1] === 'number') return `option ${keys[1] + 1}`
    return typeof keys[0] === 'string' ? keys[0] : 'quiz'
}

export function decodeQuizBank(input: unknown): quiz[] {
    if (!Array.isArray(input)) throw new Error('Quiz bank must be an array')

    return input.map((candidate, index) => {
        const result = v.safeParse(rawQuizSchema, candidate)
        const label = quizLabel(index, candidate)
        if (!result.success) {
            const issue = result.issues[0]
            throw new Error(`${label}: ${issueLocation(issue)} ${issue.message}`)
        }

        if (result.output.CorrectOptionIndex < 0 || result.output.CorrectOptionIndex >= result.output.Options.length) {
            throw new Error(`${label}: CorrectOptionIndex must be within the options range`)
        }

        return {
            id: result.output.Id,
            question: result.output.Question,
            options: result.output.Options,
            correctOptionIndex: result.output.CorrectOptionIndex,
        }
    })
}

async function loadQuizzesFromFile(path: string): Promise<quiz[]> {
    const content = await readFile(path, 'utf-8')
    return decodeQuizBank(JSON.parse(content))
}

/** Must be called once at startup, before the bot starts processing updates. */
export async function initQuizBank(path = QUIZ_FILE_PATH): Promise<void> {
    try {
        quizBank = await loadQuizzesFromFile(path)
        logger.info(`[QuizSource] Loaded ${quizBank.length} quizzes from ${path}`)
    } catch (err) {
        logger.error(
            `[QuizSource] Failed to load quiz bank from ${path}. Verification is unavailable until the file is provided or fixed; run /reload or restart to recover:`,
            err,
        )
        quizBank = []
    }
}

export async function quiz_getRandom(): Promise<quiz | undefined> {
    if (quizBank.length === 0) return undefined
    const idx = Math.floor(Math.random() * quizBank.length)
    return quizBank[idx]
}

export async function quiz_reload(path = QUIZ_FILE_PATH): Promise<{ TAG: 'Ok', _0: void } | { TAG: 'Error', _0: string }> {
    try {
        quizBank = await loadQuizzesFromFile(path)
        logger.info(`[QuizSource] Reloaded ${quizBank.length} quizzes`)
        return { TAG: 'Ok', _0: undefined }
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        logger.error('[QuizSource] Reload failed:', msg)
        return { TAG: 'Error', _0: msg }
    }
}
