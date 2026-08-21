/**
 * QuizSourceSig.S — file-based quiz bank with hot-reload,
 * loaded from bot-data/quizzes.json.
 */

import type { quiz } from '../Domain.gen.js'

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { logger } from '../logger.js'

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

/** Must be called once at startup, before the bot starts processing updates. */
export async function initQuizBank(): Promise<void> {
    try {
        quizBank = await loadQuizzesFromFile()
        logger.info(`[QuizSource] Loaded ${quizBank.length} quizzes from ${QUIZ_FILE_PATH}`)
    } catch (err) {
        logger.error(
            `[QuizSource] Failed to load quiz bank from ${QUIZ_FILE_PATH}. Verification is unavailable until the file is provided or fixed; run /reload or restart to recover:`,
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

export async function quiz_reload(): Promise<{ TAG: 'Ok', _0: void } | { TAG: 'Error', _0: string }> {
    try {
        quizBank = await loadQuizzesFromFile()
        logger.info(`[QuizSource] Reloaded ${quizBank.length} quizzes`)
        return { TAG: 'Ok', _0: undefined }
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        logger.error('[QuizSource] Reload failed:', msg)
        return { TAG: 'Error', _0: msg }
    }
}
