import antfu from '@antfu/eslint-config'

export default antfu({
    stylistic: {
        indent: 4,
    },
    typescript: true,
    yaml: false,
    // genType output, archived code, and Claude Code local settings — not hand-written
    ignores: ['**/*.gen.tsx', 'archive/', '.claude/'],
    rules: {
        'curly': ['error', 'multi-line'],
        'style/brace-style': ['error', '1tbs', { allowSingleLine: true }],
        'style/quotes': ['error', 'single', { avoidEscape: true }],
        'antfu/if-newline': 'off',
        'style/max-statements-per-line': ['error', { max: 2 }],
        'no-console': 'off',
        'node/prefer-global/process': 'off',
        'antfu/no-top-level-await': 'off',
        // This repo's test runner is node:test (see FlowTest.res / NodeTest.res), not vitest
        'test/no-import-node-test': 'off',
    },
})
