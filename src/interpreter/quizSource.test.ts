import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeQuizBank, initQuizBank, quiz_getRandom, quiz_reload } from './quizSource.js'

test('decodeQuizBank converts a valid external quiz bank into domain quizzes', () => {
    assert.deepEqual(
        decodeQuizBank([
            {
                Id: 7,
                Question: '派蒙是谁？',
                Options: ['应急食品', '最好的伙伴'],
                CorrectOptionIndex: 1,
            },
        ]),
        [
            {
                id: 7,
                question: '派蒙是谁？',
                options: ['应急食品', '最好的伙伴'],
                correctOptionIndex: 1,
            },
        ],
    )
})

const validQuiz = {
    Id: 7,
    Question: '派蒙是谁？',
    Options: ['应急食品', '最好的伙伴'],
    CorrectOptionIndex: 1,
}

function assertDecodeError(input: unknown, pattern: RegExp): void {
    assert.throws(() => decodeQuizBank(input), pattern)
}

test('decodeQuizBank rejects a non-array root', () => {
    assertDecodeError(validQuiz, /quiz bank.*array/i)
})

test('decodeQuizBank reports the invalid quiz number and ID', () => {
    assertDecodeError(
        [validQuiz, { ...validQuiz, Id: 42, Options: ['only one'] }],
        /quiz 2.*ID 42.*at least two/i,
    )
})

test('decodeQuizBank rejects missing or mistyped quiz fields', () => {
    const { Question: _question, ...missingQuestion } = validQuiz
    assertDecodeError([missingQuestion], /quiz 1.*Question.*undefined/i)
    assertDecodeError([{ ...validQuiz, Question: 123 }], /quiz 1.*Question.*string/i)
    assertDecodeError([{ ...validQuiz, Options: 'A,B' }], /quiz 1.*Options.*array/i)
})

test('decodeQuizBank rejects invalid quiz IDs', () => {
    assertDecodeError([{ ...validQuiz, Id: '7' }], /quiz 1.*ID 7.*Id.*number/i)
    assertDecodeError([{ ...validQuiz, Id: 7.5 }], /quiz 1.*ID 7.5.*Id.*integer/i)
})

test('decodeQuizBank rejects too few, empty, or non-string options', () => {
    assertDecodeError([{ ...validQuiz, Options: [] }], /quiz 1.*ID 7.*at least two/i)
    assertDecodeError([{ ...validQuiz, Options: ['only one'] }], /quiz 1.*ID 7.*at least two/i)
    assertDecodeError([{ ...validQuiz, Options: ['A', ''] }], /quiz 1.*ID 7.*option 2.*non-empty string/i)
    assertDecodeError([{ ...validQuiz, Options: ['A', 2] }], /quiz 1.*ID 7.*option 2.*string/i)
})

test('decodeQuizBank rejects invalid correct answer indexes', () => {
    assertDecodeError([{ ...validQuiz, CorrectOptionIndex: -1 }], /quiz 1.*ID 7.*CorrectOptionIndex.*range/i)
    assertDecodeError([{ ...validQuiz, CorrectOptionIndex: 2 }], /quiz 1.*ID 7.*CorrectOptionIndex.*range/i)
    assertDecodeError([{ ...validQuiz, CorrectOptionIndex: 0.5 }], /quiz 1.*ID 7.*CorrectOptionIndex.*integer/i)
})

test('quiz_reload keeps the previous trusted quiz bank when decoding fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'quiz-source-'))
    const quizPath = join(workspace, 'quizzes.json')

    try {
        await writeFile(quizPath, JSON.stringify([validQuiz]))
        await initQuizBank(quizPath)
        assert.equal((await quiz_getRandom())?.id, validQuiz.Id)

        await writeFile(quizPath, JSON.stringify([{ ...validQuiz, CorrectOptionIndex: 99 }]))
        const reloadResult = await quiz_reload(quizPath)

        assert.equal(reloadResult.TAG, 'Error')
        assert.equal((await quiz_getRandom())?.id, validQuiz.Id)
    } finally {
        await rm(workspace, { recursive: true, force: true })
    }
})
