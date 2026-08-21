import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const buildInputs = [
    'build.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'rescript.json',
    'tsconfig.json',
    'src',
]

function runBuild(quizContent) {
    const workspace = mkdtempSync(join(tmpdir(), 'genshin-group-verif-build-'))

    for (const entry of buildInputs) {
        cpSync(resolve(root, entry), resolve(workspace, entry), { recursive: true })
    }
    symlinkSync(resolve(root, 'node_modules'), resolve(workspace, 'node_modules'), 'dir')

    if (quizContent !== undefined) {
        const quizPath = resolve(workspace, 'bot-data/quizzes.json')
        mkdirSync(dirname(quizPath), { recursive: true })
        writeFileSync(quizPath, quizContent)
    }

    const result = spawnSync(process.execPath, ['build.mjs'], {
        cwd: workspace,
        encoding: 'utf8',
        env: process.env,
    })

    return { result, workspace }
}

test('build succeeds without quizzes.json and reports the skipped copy', () => {
    const { result, workspace } = runBuild(undefined)

    try {
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stderr, /bot-data\/quizzes\.json is missing; skipped quiz-bank copy/)
        assert.match(result.stdout, /quizzes\.json\s+skipped \(provide at runtime\)/)
        assert.ok(existsSync(resolve(workspace, 'dist/main.mjs')))
        assert.ok(!existsSync(resolve(workspace, 'dist/bot-data/quizzes.json')))
    } finally {
        rmSync(workspace, { recursive: true, force: true })
    }
})

test('build copies an existing quizzes.json byte-for-byte', () => {
    const quizContent = '[{"Id":1,"Question":"Q?","Options":["A","B"],"CorrectOptionIndex":0}]\n'
    const { result, workspace } = runBuild(quizContent)

    try {
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /quizzes\.json\s+✓/)
        assert.equal(readFileSync(resolve(workspace, 'dist/bot-data/quizzes.json'), 'utf8'), quizContent)
    } finally {
        rmSync(workspace, { recursive: true, force: true })
    }
})
