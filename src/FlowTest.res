// ─────────────────────────────────────────────────────────────
// Flow tests — run with:  node --test src/FlowTest.res.mjs
//
// 使用 Node.js Test Runner (node:test) + node:assert/strict
// 每个 describe 块对应一个 Flow 入口, 每个 test 是一个场景
// ─────────────────────────────────────────────────────────────

open Domain
open NodeTest

// ── shorthand constructors ──────────────────────────────────

let user = (n): Peer.id<Peer.user> => Peer.unsafeCastUser(n)
let chat = (n): Peer.id<Peer.unknown> => Peer.unsafeCastAny(n)
external unsafeCastQueryId: bigint => CallbackQuery.id = "%identity"
let queryId = (n): CallbackQuery.id => BigInt.fromInt(n)->unsafeCastQueryId

// ── Trace assertion helpers ─────────────────────────────────

let traceLen = (expected: int) => {
  let actual = MockInterpreter.getTrace()->Array.length
  equal(actual, expected, ~message=`trace length: expected ${expected->Int.toString}, got ${actual->Int.toString}`)
}

let traceNth = (n: int, prefix: string) => {
  let tr = MockInterpreter.getTrace()
  switch tr->Array.get(n) {
  | Some(entry) =>
    ok(entry->String.startsWith(prefix),
      ~message=`trace[${n->Int.toString}] expected prefix "${prefix}", got "${entry}"`)
  | None =>
    ok(false, ~message=`trace[${n->Int.toString}] out of bounds (len=${tr->Array.length->Int.toString})`)
  }
}

let traceHas = (sub: string) => {
  let found = MockInterpreter.getTrace()->Array.some(e => e->String.includes(sub))
  ok(found, ~message=`trace should contain "${sub}"`)
}

let traceNot = (sub: string) => {
  let found = MockInterpreter.getTrace()->Array.some(e => e->String.includes(sub))
  ok(found == false, ~message=`trace should NOT contain "${sub}"`)
}

// ── State invariant helpers ─────────────────────────────────

let sessionCount = (n: int) => equal(MockInterpreter.State.sessions->Map.size, n, ~message="session count")
let tokenCount = (n: int) => equal(MockInterpreter.State.tokenIndex->Map.size, n, ~message="tokenIndex count")
let lookupCount = (n: int) => equal(MockInterpreter.State.lookupIndex->Map.size, n, ~message="lookupIndex count")
let hasCooldown = (key: string) => ok(MockInterpreter.State.cooldowns->Set.has(key), ~message=`cooldown "${key}"`)
let noCooldowns = () => equal(MockInterpreter.State.cooldowns->Set.size, 0, ~message="cooldowns empty")
let sessionExists = (id: string) => ok(MockInterpreter.State.sessions->Map.has(id), ~message=`session "${id}" exists`)
let sessionGone = (id: string) =>
  ok(!(MockInterpreter.State.sessions->Map.has(id)), ~message=`session "${id}" gone`)
let tokenGone = (tok: string) =>
  ok(!(MockInterpreter.State.tokenIndex->Map.has(tok)), ~message=`token "${tok}" gone`)

// ── Shared input builder ────────────────────────────────────

let defaultInput = (ctx: context): start_input => {
  userId: user(42.0),
  chatId: chat(-100.0),
  userChatId: switch ctx {
  | In_group => chat(-100.0)
  | Join_request => chat(42.0)
  },
  userFirstName: "Lumine",
  context: ctx,
}

// ═════════════════════════════════════════════════════════════
// describe: startVerification
// ═════════════════════════════════════════════════════════════

describe("startVerification", () => {
  beforeEach(() => MockInterpreter.reset())

  test("happy path — in-group", () => {
    MockInterpreter.TestFlow.startVerification(defaultInput(In_group))

    // trace: 9 ops — 观察者(waitAndPeekSession)必须先于 presentChallenge 挂上
    traceLen(9)
    traceNth(0, "Cooldown.check")
    traceNth(1, "Session.findPending")
    traceNth(2, "Quiz.getRandom")
    traceNth(3, "restrictUser")
    traceNth(4, "Session.save")
    traceNth(5, "waitAndPeekSession")
    traceNth(6, "presentChallenge")
    // 用户名与超时时长都来自输入, 不再由解释器另行拉取/硬编码
    traceHas(`name="Lumine"`)
    traceHas("timeout=60s")
    traceNth(7, "Session.updateLocation")
    traceNth(8, "logActivity")
    traceHas("kind=Request_start")

    // state
    sessionCount(1)
    lookupCount(1)
    tokenCount(4)
    noCooldowns()

    let sess = MockInterpreter.State.sessions->Map.values->Iterator.toArray->Array.getUnsafe(0)
    ok(sess.verificationLocation->Option.isSome, ~message="has verificationLocation")
    equal(sess.context, In_group, ~message="context")
  })

  test("happy path — join request", () => {
    MockInterpreter.TestFlow.startVerification(defaultInput(Join_request))

    traceLen(8)
    traceNth(0, "Cooldown.check")
    traceNth(1, "Session.findPending")
    traceNot("restrictUser")
    traceNth(2, "Quiz.getRandom")
    traceNth(3, "Session.save")
    traceNth(4, "waitAndPeekSession")
    traceNth(5, "presentChallenge")
    traceHas("presentChallenge  chat=42")
    traceNth(6, "Session.updateLocation")
    traceNth(7, "logActivity")
    traceHas("kind=Request_start")

    sessionCount(1)
    tokenCount(4)
    lookupCount(1)
    noCooldowns()

    let sess = MockInterpreter.State.sessions->Map.values->Iterator.toArray->Array.getUnsafe(0)
    equal(sess.context, Join_request, ~message="context")
  })

  test("on cooldown — bail with temp message", () => {
    MockInterpreter.State.cooldowns->Set.add("-100:42")->ignore

    MockInterpreter.TestFlow.startVerification(defaultInput(In_group))

    traceLen(3)
    traceNth(0, "Cooldown.check")
    traceHas("ON_COOLDOWN")
    traceNth(1, "sendTempMessage")
    traceHas("冷却时间")
    traceNth(2, "enforceDecision")
    traceHas("decision=Punish_soft")

    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
  })

  test("existing pending session — claim then bail", () => {
    let old: session = {
      id: "old-sess-1",
      chatId: chat(-100.0),
      userId: user(42.0),
      correctToken: "tok-correct",
      context: In_group,
      optionsWithTokens: [{optionText: "A", token: "tok-a"}, {optionText: "B", token: "tok-correct"}],
      verificationLocation: Some(Message.at(chat(-100.0), 999)),
    }
    MockInterpreter.StateMock.Session.save(old)
    MockInterpreter.trace := []

    MockInterpreter.TestFlow.startVerification(defaultInput(In_group))

    traceNth(0, "Cooldown.check")
    traceNth(1, "Session.findPending")
    traceHas("found")
    traceHas("Session.claim")
    traceHas("→ won")
    traceHas("scheduleCleanup")
    traceHas("sendTempMessage")
    traceHas("正在进行的验证")
    traceHas("enforceDecision")

    // old session fully removed, no new session created
    sessionGone("old-sess-1")
    tokenGone("tok-a")
    tokenGone("tok-correct")
    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
  })

  test("no quizzes available — bail without restricting", () => {
    MockInterpreter.QuizBank.clear()

    MockInterpreter.TestFlow.startVerification(defaultInput(In_group))

    traceLen(5)
    traceNth(0, "Cooldown.check")
    traceNth(1, "Session.findPending")
    traceNth(2, "Quiz.getRandom")
    traceHas("Quiz.getRandom → none")
    traceNth(3, "sendTempMessage")
    traceHas("验证服务当前不可用")
    traceNth(4, "enforceDecision")
    // 题库不可用时不应先禁言 — 避免「已禁言却无题可答」的遗留状态
    traceNot("restrictUser")

    sessionCount(0)
    tokenCount(0)
  })
})

// ═════════════════════════════════════════════════════════════
// describe: handleCallback
// ═════════════════════════════════════════════════════════════

// helper: start a verification and return the session
let seedSession = () => {
  MockInterpreter.TestFlow.startVerification(defaultInput(In_group))
  let sess = MockInterpreter.State.sessions->Map.values->Iterator.toArray->Array.getUnsafe(0)
  MockInterpreter.trace := []
  sess
}

describe("handleCallback", () => {
  beforeEach(() => MockInterpreter.reset())

  test("correct answer — claim, grant access", () => {
    let sess = seedSession()

    MockInterpreter.TestFlow.handleCallback({
      callbackData: sess.correctToken,
      queryId: queryId(1),
      userId: user(42.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    })

    traceLen(7)
    traceNth(0, "Session.findByToken")
    traceHas("found")
    traceNth(1, "Session.claim")
    traceHas("→ won")
    traceNth(2, "acknowledgeClick")
    traceNth(3, "updateStatus")
    traceHas("验证通过")
    traceNth(4, "enforceDecision")
    traceHas("Grant_access")
    traceNth(5, "scheduleCleanup")
    traceNth(6, "logActivity")
    traceHas("kind=Success")

    sessionGone(sess.id)
    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
    noCooldowns()
  })

  test("wrong answer — punish + cooldown", () => {
    let sess = seedSession()
    let wrong = sess.optionsWithTokens
      ->Array.find(o => o.token != sess.correctToken)
      ->Option.getOrThrow

    MockInterpreter.TestFlow.handleCallback({
      callbackData: wrong.token,
      queryId: queryId(2),
      userId: user(42.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    })

    traceNth(0, "Session.findByToken")
    traceNth(1, "Session.claim")
    traceHas("→ won")
    traceNth(2, "acknowledgeClick")
    traceHas("回答错误")
    traceHas("Cooldown.apply")
    traceHas("updateStatus")
    traceHas("验证失败")
    traceHas("Punish_soft")
    traceHas("kind=Fail_error")
    traceHas("scheduleCleanup")

    sessionGone(sess.id)
    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
    hasCooldown("-100:42")
  })

  test("user mismatch — reject silently, session untouched", () => {
    let sess = seedSession()

    MockInterpreter.TestFlow.handleCallback({
      callbackData: sess.correctToken,
      queryId: queryId(3),
      userId: user(999.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    })

    traceLen(2)
    traceNth(0, "Session.findByToken")
    traceNth(1, "acknowledgeClick")
    traceHas("不适用于你")
    traceNot("Session.claim")

    sessionExists(sess.id)
    sessionCount(1)
    tokenCount(4)
    noCooldowns()
  })

  test("expired/invalid token — acknowledge error", () => {
    MockInterpreter.TestFlow.handleCallback({
      callbackData: "nonexistent-token",
      queryId: queryId(4),
      userId: user(42.0),
      messageLocation: Message.at(chat(-100.0), 888),
    })

    traceLen(2)
    traceNth(0, "Session.findByToken")
    traceHas("→ none")
    traceNth(1, "acknowledgeClick")
    traceHas("过期")

    sessionCount(0)
    tokenCount(0)
    noCooldowns()
  })
})

// ═════════════════════════════════════════════════════════════
// describe: handleTimeout
// ═════════════════════════════════════════════════════════════

describe("handleTimeout", () => {
  beforeEach(() => MockInterpreter.reset())

  test("with verification message — claim, punish, update + cleanup schedule", () => {
    let sess = seedSession()

    MockInterpreter.TestFlow.handleTimeout(sess)

    traceLen(5)
    traceNth(0, "Session.claim")
    traceHas("→ won")
    traceNth(1, "enforceDecision")
    traceHas("Punish_soft")
    traceNth(2, "updateStatus")
    traceHas("超时")
    traceNth(3, "scheduleCleanup")
    traceNth(4, "logActivity")
    traceHas("kind=Fail_timeout")

    sessionGone(sess.id)
    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
  })

  test("without verification message — skip UI ops", () => {
    let bare: session = {
      id: "timeout-sess",
      chatId: chat(-100.0),
      userId: user(42.0),
      correctToken: "x",
      context: Join_request,
      optionsWithTokens: [],
      verificationLocation: None,
    }
    MockInterpreter.StateMock.Session.save(bare)
    MockInterpreter.trace := []

    MockInterpreter.TestFlow.handleTimeout(bare)

    traceLen(3)
    traceNth(0, "Session.claim")
    traceHas("→ won")
    traceNth(1, "enforceDecision")
    traceHas("Punish_soft")
    traceNth(2, "logActivity")
    traceHas("kind=Fail_timeout")
    traceNot("updateStatus")
    traceNot("scheduleCleanup")

    sessionGone("timeout-sess")
  })
})

// ═════════════════════════════════════════════════════════════
// describe: claim races — the timeout ↔ answer double-decision class
// ═════════════════════════════════════════════════════════════

describe("session claim races", () => {
  beforeEach(() => MockInterpreter.reset())

  test("claim is atomic — second claim loses", () => {
    let sess = seedSession()

    let first = MockInterpreter.StateMock.Session.claim(sess.id)
    let second = MockInterpreter.StateMock.Session.claim(sess.id)

    ok(first->Option.isSome, ~message="first claim wins")
    ok(second->Option.isNone, ~message="second claim loses")
    sessionCount(0)
    tokenCount(0)
    lookupCount(0)
  })

  test("late timeout after correct answer — loses claim, no punish", () => {
    let sess = seedSession()

    MockInterpreter.TestFlow.handleCallback({
      callbackData: sess.correctToken,
      queryId: queryId(10),
      userId: user(42.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    })

    // 60s 观察者随后携带(过期的)peek 副本触发
    MockInterpreter.trace := []
    MockInterpreter.TestFlow.handleTimeout(sess)

    traceLen(1)
    traceNth(0, "Session.claim")
    traceHas("→ lost")
    traceNot("enforceDecision")
    traceNot("kind=Fail_timeout")
    noCooldowns()
  })

  test("click after timeout — session already claimed, no grant", () => {
    let sess = seedSession()

    MockInterpreter.TestFlow.handleTimeout(sess)
    MockInterpreter.trace := []

    MockInterpreter.TestFlow.handleCallback({
      callbackData: sess.correctToken,
      queryId: queryId(11),
      userId: user(42.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    })

    traceLen(2)
    traceNth(0, "Session.findByToken")
    traceHas("→ none")
    traceNth(1, "acknowledgeClick")
    traceHas("过期")
    traceNot("Grant_access")
    noCooldowns()
  })

  test("duplicate correct clicks — no double grant", () => {
    let sess = seedSession()
    let input: callback_input = {
      callbackData: sess.correctToken,
      queryId: queryId(12),
      userId: user(42.0),
      messageLocation: sess.verificationLocation->Option.getOrThrow,
    }

    MockInterpreter.TestFlow.handleCallback(input)
    MockInterpreter.trace := []
    MockInterpreter.TestFlow.handleCallback(input)

    traceLen(2)
    traceNth(0, "Session.findByToken")
    traceHas("→ none")
    traceNth(1, "acknowledgeClick")
    traceHas("过期")
    traceNot("Grant_access")
  })
})
