// ─────────────────────────────────────────────────────────────
// Minimal bindings for node:test + node:assert/strict
// ─────────────────────────────────────────────────────────────

// ── node:test ───────────────────────────────────────────────

type testContext

@module("node:test")
external describe: (string, @uncurry unit => unit) => unit = "describe"

@module("node:test")
external test: (string, @uncurry unit => unit) => unit = "test"

@module("node:test")
external beforeEach: (@uncurry unit => unit) => unit = "beforeEach"

@module("node:test")
external afterEach: (@uncurry unit => unit) => unit = "afterEach"

// ── node:assert/strict ──────────────────────────────────────

@module("node:assert/strict") external ok: (bool, ~message: string=?) => unit = "ok"
@module("node:assert/strict") external equal: ('a, 'a, ~message: string=?) => unit = "strictEqual"
@module("node:assert/strict") external notEqual: ('a, 'a, ~message: string=?) => unit = "notStrictEqual"
@module("node:assert/strict") external deepEqual: ('a, 'a, ~message: string=?) => unit = "deepStrictEqual"
