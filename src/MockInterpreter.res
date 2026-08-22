// ─────────────────────────────────────────────────────────────
// Mock Interpreter — identity monad + in-memory state + trace log
//
// t<'a> = 'a  (同步, 纯值, 无包装)
//
// 所有副作用操作只做两件事:
//   1. 操作内存中的 Map / Set
//   2. 向全局 trace 追加一条可读的操作记录
//
// 测试时:  Mock.reset() → 构造输入 → 跑 Flow → 断言 trace / state
// ─────────────────────────────────────────────────────────────

open Domain

// ── Trace ───────────────────────────────────────────────────

type trace_entry = string

let trace: ref<array<trace_entry>> = ref([])

let record = (entry: trace_entry) => {
  trace.contents = trace.contents->Array.concat([entry])
}

let getTrace = () => trace.contents->Array.copy

let printTrace = () => {
  Console.log("┌─── Trace (" ++ getTrace()->Array.length->Int.toString ++ " ops) ───")
  getTrace()->Array.forEachWithIndex((entry, i) => {
    let n = (i + 1)->Int.toString->String.padStart(2, " ")
    Console.log(`│ ${n}. ${entry}`)
  })
  Console.log("└───────────────────────────────────")
}

// ── helpers: pretty-print domain values ─────────────────────

let fmtPeer = (id: Peer.id<_>): string =>
  Peer.value(id)->Float.toString

let fmtLoc = ((peerId, msgId): Message.location<_>): string =>
  `(chat=${fmtPeer(peerId)}, msg=${(msgId :> int)->Int.toString})`

let fmtCtx = (ctx: context): string =>
  switch ctx {
  | In_group => "In_group"
  | Join_request => "Join_request"
  }

let fmtDecision = (d: decision): string =>
  switch d {
  | Grant_access => "Grant_access"
  | Punish_soft => "Punish_soft"
  }

let fmtLogKind = (k: log_kind): string =>
  switch k {
  | Request_start => "Request_start"
  | Success => "Success"
  | Fail_timeout => "Fail_timeout"
  | Fail_error => "Fail_error"
  | Enforcement_failed => "Enforcement_failed"
  }

// ── Shared mutable state ────────────────────────────────────

module State = {
  // session store:  sessionId → session
  let sessions: Map.t<string, session> = Map.make()

  // token → sessionId  (reverse index, mirrors the persistent store's token map)
  let tokenIndex: Map.t<string, string> = Map.make()

  // lookup: "chatId:userId" → sessionId  (mirrors the persistent store's lookup key)
  let lookupIndex: Map.t<string, string> = Map.make()

  // Telegram-side safety state used by start-flow failure tests.
  let restrictedUsers: Set.t<string> = Set.make()
  let removedUsers: Set.t<string> = Set.make()

  // cooldown set: "chatId:userId"
  let cooldowns: Set.t<string> = Set.make()

  let lookupKey = (~chatId: Peer.id<_>, ~userId: Peer.id<Peer.user>): string =>
    fmtPeer(chatId) ++ ":" ++ fmtPeer(userId)

  let reset = () => {
    sessions->Map.clear
    tokenIndex->Map.clear
    lookupIndex->Map.clear
    cooldowns->Set.clear
    restrictedUsers->Set.clear
    removedUsers->Set.clear
  }
}

// ── Quiz bank ───────────────────────────────────────────────

module QuizBank = {
  let quizzes: ref<array<quiz>> = ref([
    {
      id: 1,
      question: "提瓦特大陆有几个国家？",
      options: ["5", "7", "8", "9"],
      correctOptionIndex: 1,
    },
    {
      id: 2,
      question: "「风神」的名字是？",
      options: ["钟离", "巴巴托斯", "雷电影", "纳西妲"],
      correctOptionIndex: 1,
    },
  ])

  let setQuizzes = (qs: array<quiz>) => quizzes := qs
  let clear = () => quizzes := []
}

// ── Message ID counter (auto-increment) ─────────────────────

let nextMsgId: ref<int> = ref(1000)
let allocMsgId = (): Message.id => {
  let id = nextMsgId.contents
  nextMsgId := id + 1
  Message.castId(id)
}

let currentTimeMs: ref<float> = ref(1_000_000.0)
let uuidValues: ref<array<string>> = ref([])
let randomIntValues: ref<array<int>> = ref([])

// 测试注入: true 时对应 adapter/state operation 失败。
let failPresentChallenge: ref<bool> = ref(false)
exception RestrictUserFailure
exception SessionSavePendingFailure
exception CooldownApplyFailure
exception SleepFailure
exception SessionGetByIdFailure
exception SessionClaimFailure
let failRestrictUser: ref<bool> = ref(false)
let failEnforceDecision: ref<bool> = ref(false)
let failSessionSavePending: ref<bool> = ref(false)
let failCooldownApply: ref<bool> = ref(false)
let failSleep: ref<bool> = ref(false)
let failSessionGetById: ref<bool> = ref(false)
let returnSessionFromGetById: ref<bool> = ref(false)
let failSessionClaim: ref<bool> = ref(false)

// ── Master reset ────────────────────────────────────────────

let reset = () => {
  trace := []
  State.reset()
  QuizBank.quizzes := [
    {id: 1, question: "提瓦特大陆有几个国家？", options: ["5", "7", "8", "9"], correctOptionIndex: 1},
    {id: 2, question: "「风神」的名字是？", options: ["钟离", "巴巴托斯", "雷电影", "纳西妲"], correctOptionIndex: 1},
  ]
  currentTimeMs := 1_000_000.0
  uuidValues := ["token-a", "token-b", "token-c", "token-d", "session-1"]
  randomIntValues := [0, 0, 0]
  nextMsgId := 1000
  failPresentChallenge := false
  failRestrictUser := false
  failEnforceDecision := false
  failSessionSavePending := false
  failCooldownApply := false
  failSleep := false
  failSessionGetById := false
  returnSessionFromGetById := false
  failSessionClaim := false
}

// ═════════════════════════════════════════════════════════════
// Module implementations
// ═════════════════════════════════════════════════════════════

module Runtime: RuntimeSig.S with type t<'a> = 'a = {
  type t<'a> = 'a

  let pure = (x: 'a): 'a => x
  let bind = (x: 'a, f: 'a => 'b): 'b => f(x)
  let recoverError = (task, recover) =>
    try {
      task()
    } catch {
    | exn => recover(exn)
    }

  let nowMs = () => currentTimeMs.contents

  let randomUUID = () => {
    let value = uuidValues.contents->Array.get(0)->Option.getOrThrow
    uuidValues := uuidValues.contents->Array.slice(~start=1)
    value
  }

  let randomInt = (~upperExclusive) => {
    let value = randomIntValues.contents->Array.get(0)->Option.getOrThrow
    randomIntValues := randomIntValues.contents->Array.slice(~start=1)
    if value < 0 || value >= upperExclusive {
      invalid_arg(`randomInt mock value ${value->Int.toString} outside [0, ${upperExclusive->Int.toString})`)
    }
    value
  }

  let sleep = delayMs => {
    record(`Runtime.sleep  delay=${delayMs->Float.toString}ms`)
    if failSleep.contents {
      throw(SleepFailure)
    }
  }

  let detach = task => {
    recoverError(task, error => {
      let _ = error
      record("Observer.error")
    })
  }
}

module Interaction: InteractionSig.S with type t<'a> = 'a = {
  type t<'a> = 'a
  let presentChallenge = (~chatId, ~userId, ~userFirstName, ~question, ~options, ~timeoutSec) => {
    let optStr = options->Array.map(((text, tok)) => `"${text}"(${tok})`)->Array.join(", ")
    record(
      `presentChallenge  chat=${fmtPeer(chatId)} user=${fmtPeer(userId)} name="${userFirstName}" q="${question}" opts=[${optStr}] timeout=${timeoutSec->Int.toString}s`,
    )
    if failPresentChallenge.contents {
      None
    } else {
      let msgId = allocMsgId()
      Some((Peer.unsafeCastAny(Peer.value(chatId)), msgId))
    }
  }

  let updateStatus = (~loc, ~status) => {
    record(`updateStatus  ${fmtLoc(loc)} "${status}"`)
  }

  let acknowledgeClick = (~queryId, ~text, ~showAlert) => {
    let _ = queryId // BigInt, just ignore in pretty print
    record(`acknowledgeClick  text="${text}" alert=${showAlert ? "true" : "false"}`)
  }

  let enforceDecision = (~chatId, ~userId, ~decision, ~context) => {
    let key = State.lookupKey(~chatId, ~userId)
    record(`enforceDecision  chat=${fmtPeer(chatId)} user=${fmtPeer(userId)} decision=${fmtDecision(decision)} ctx=${fmtCtx(context)}`)
    if failEnforceDecision.contents {
      Error("injected")
    } else {
      switch (decision, context) {
      | (Grant_access, In_group) => State.restrictedUsers->Set.delete(key)->ignore
      | (Punish_soft, In_group) => State.removedUsers->Set.add(key)->ignore
      | (_, Join_request) => ()
      }
      Ok()
    }
  }

  let logActivity = (~kind, ~chatId, ~userId) => {
    record(`logActivity  kind=${fmtLogKind(kind)} chat=${fmtPeer(chatId)} user=${fmtPeer(userId)}`)
  }

  let sendTempMessage = (~chatId, ~text) => {
    record(`sendTempMessage  chat=${fmtPeer(chatId)} "${text}"`)
  }

  let scheduleMessageCleanup = (~loc, ~delaySec) => {
    record(`scheduleCleanup  ${fmtLoc(loc)} delay=${delaySec->Int.toString}s`)
  }

  let restrictUser = (~chatId, ~userId) => {
    let key = State.lookupKey(~chatId, ~userId)
    record(`restrictUser  chat=${fmtPeer(chatId)} user=${fmtPeer(userId)}`)
    if failRestrictUser.contents {
      throw(RestrictUserFailure)
    }
    State.restrictedUsers->Set.add(key)->ignore
  }
}

module StateMock: StateSig.S with type t<'a> = 'a = {
  type t<'a> = 'a


  module Cooldown = {
    let check = (~chatId, ~userId) => {
      let key = State.lookupKey(~chatId, ~userId)
      let result = State.cooldowns->Set.has(key)
      record(`Cooldown.check  ${key} → ${result ? "ON_COOLDOWN" : "ok"}`)
      result
    }

    let apply = (~chatId, ~userId, ~durationSec) => {
      let key = State.lookupKey(~chatId, ~userId)
      record(`Cooldown.apply  ${key} ${durationSec->Int.toString}s`)
      if failCooldownApply.contents {
        throw(CooldownApplyFailure)
      }
      State.cooldowns->Set.add(key)->ignore
    }
  }

  module Session = {
    let getById = (sessionId: string) => {
      let result = returnSessionFromGetById.contents
        ? State.sessions->Map.get(sessionId)
        : None
      record(`Session.getById  id=${sessionId} → ${result->Option.isSome ? "found" : "none"}`)
      if failSessionGetById.contents {
        throw(SessionGetByIdFailure)
      }
      result
    }
    let savePending = (session: session) => {
      record(`Session.savePending  id=${session.id}`)
      if failSessionSavePending.contents {
        throw(SessionSavePendingFailure)
      }
      let lk = State.lookupKey(~chatId=session.chatId, ~userId=session.userId)
      let replaced = State.lookupIndex->Map.get(lk)->Option.flatMap(id => State.sessions->Map.get(id))
      replaced->Option.forEach(old => {
        old.optionsWithTokens->Array.forEach(o => {
          if State.tokenIndex->Map.get(o.token) == Some(old.id) {
            State.tokenIndex->Map.delete(o.token)->ignore
          }
        })
        State.sessions->Map.delete(old.id)->ignore
      })
      State.sessions->Map.set(session.id, session)
      session.optionsWithTokens->Array.forEach(o => {
        State.tokenIndex->Map.set(o.token, session.id)
      })
      State.lookupIndex->Map.set(lk, session.id)
      replaced
    }

    let findByToken = (token: string) => {
      let sessId = State.tokenIndex->Map.get(token)
      let result = sessId->Option.flatMap(id => State.sessions->Map.get(id))
      record(`Session.findByToken  token=${token} → ${result->Option.isSome ? "found" : "none"}`)
      result
    }

    let findPending = (~chatId, ~userId) => {
      let lk = State.lookupKey(~chatId, ~userId)
      let sessId = State.lookupIndex->Map.get(lk)
      let result = sessId->Option.flatMap(id => State.sessions->Map.get(id))
      record(`Session.findPending  ${lk} → ${result->Option.isSome ? "found" : "none"}`)
      result
    }

    let claim = (sessionId: string) => {
      let claimed = State.sessions->Map.get(sessionId)
      record(`Session.claim  id=${sessionId} → ${claimed->Option.isSome ? "won" : "lost"}`)
      if failSessionClaim.contents {
        throw(SessionClaimFailure)
      }
      switch claimed {
      | Some(s) =>
        s.optionsWithTokens->Array.forEach(o => {
          if State.tokenIndex->Map.get(o.token) == Some(s.id) {
            State.tokenIndex->Map.delete(o.token)->ignore
          }
        })
        let lk = State.lookupKey(~chatId=s.chatId, ~userId=s.userId)
        if State.lookupIndex->Map.get(lk) == Some(s.id) {
          State.lookupIndex->Map.delete(lk)->ignore
        }
        State.sessions->Map.delete(sessionId)->ignore
      | None => ()
      }
      claimed
    }

    let updateLocation = (session: session, loc: Message.location<Peer.unknown>) => {
      let live = State.sessions->Map.has(session.id)
      if live {
        State.sessions->Map.set(session.id, {...session, verificationLocation: Some(loc)})
      }
      record(`Session.updateLocation  id=${session.id} loc=${fmtLoc(loc)} → ${live ? "live" : "gone"}`)
      live
    }

  }
}

module QuizSource: QuizSourceSig.S with type t<'a> = 'a = {
  type t<'a> = 'a


  let getRandom = () => {
    let qs = QuizBank.quizzes.contents
    let result = if qs->Array.length == 0 {
      None
    } else {
      Some(Array.getUnsafe(qs, 0)) // 测试用: 总是返回第一题, 保证确定性
    }
    record(`Quiz.getRandom → ${result->Option.isSome ? "some" : "none"}`)
    result
  }

  let reload = () => {
    record(`Quiz.reload`)
    Ok()
  }
}

// ═══════════════════════════════════════════════════════════
// Instantiate Flow with mock modules
// ═══════════════════════════════════════════════════════════

module TestFlow = Flow.Make(Runtime, Interaction, StateMock, QuizSource)
