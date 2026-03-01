#!/usr/bin/env node
/**
 * Production build script — esbuild.
 *
 * Why raw esbuild instead of tsup/tsdown/unbuild?
 *   • We ship an application, not a library — no DTS, no CJS+ESM dual-format.
 *   • ReScript .res.mjs inputs need `resolveExtensions` (1 line in esbuild,
 *     plugin in wrappers).
 *   • Native addon (better-sqlite3) + WASM (@mtcute/wasm) externals are
 *     trivial with esbuild's `external` + `loader` options.
 *   • Zero abstraction tax — ~80 LOC, no wrapper to debug.
 *
 * Usage:
 *   node build.mjs            — build to dist/
 *   node build.mjs --analyze  — also print bundle analysis
 */

import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const dist = resolve(root, 'dist')

// ── 1. ReScript → .res.mjs ───────────────────────────────────
console.log('⏳ Compiling ReScript …')
execSync('pnpm res:build', { stdio: 'inherit', cwd: root })

// ── 2. Bundle ─────────────────────────────────────────────────
console.log('⏳ Bundling with esbuild …')

const result = await esbuild.build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(dist, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',

  // Native addon — resolved from node_modules at runtime
  external: ['better-sqlite3'],

  minify: true,
  treeShaking: true,
  sourcemap: true,
  sourcesContent: false,
  metafile: true,

  // ReScript outputs .res.mjs; let esbuild resolve them
  resolveExtensions: ['.ts', '.tsx', '.mjs', '.js', '.json'],

  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.wasm': 'file' },
  assetNames: '[name]',

  // Shim `require()` for native addons in ESM context
  banner: {
    js: [
      '// genshin-group-verif production bundle',
      'import{createRequire as __cr}from"node:module";',
      'const require=__cr(import.meta.url);',
    ].join('\n'),
  },
})

// ── 3. Copy runtime data ──────────────────────────────────────
const quizDst = resolve(dist, 'bot-data/quizzes.json')
mkdirSync(dirname(quizDst), { recursive: true })
cpSync(resolve(root, 'bot-data/quizzes.json'), quizDst)

// ── 4. Report ─────────────────────────────────────────────────
writeFileSync(resolve(dist, 'metafile.json'), JSON.stringify(result.metafile))

if (process.argv.includes('--analyze')) {
  console.log('\n📊 Bundle analysis:\n')
  console.log(await esbuild.analyzeMetafile(result.metafile, { verbose: false }))
}

const kb = (f) => {
  const s = existsSync(f) ? statSync(f).size : 0
  return `${(s / 1024).toFixed(1)} KB`
}

console.log(`\n✅ Build complete → dist/`)
console.log(`   main.mjs      ${kb(resolve(dist, 'main.mjs'))}`)
console.log(`   main.mjs.map  ${kb(resolve(dist, 'main.mjs.map'))}`)
console.log(`   quizzes.json  ✓`)
console.log(`\n   Run:  node --enable-source-maps dist/main.mjs`)
