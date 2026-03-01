open Domain

@module("./InterpreterMtCute.js")
external setRuntime: 'a => unit = "setRuntime"

@module("./InterpreterMtCute.js")
external pureImpl: 'a => promise<'a> = "pure"

@module("./InterpreterMtCute.js")
external bindImpl: (promise<'a>, 'a => promise<'b>) => promise<'b> = "bind"

@module("./InterpreterMtCute.js")
external presentChallengeImpl: (
  Peer.id<'a>,
  Peer.id<Peer.user>,
  string,
  array<(string, string)>,
) => promise<Message.location<'a>> = "interaction_presentChallenge"

@module("./InterpreterMtCute.js")
external updateStatusImpl: (Message.location<'a>, string) => promise<unit> = "interaction_updateStatus"

@module("./InterpreterMtCute.js")
external destroyUIImpl: Message.location<'a> => promise<unit> = "interaction_destroyUI"

@module("./InterpreterMtCute.js")
external acknowledgeClickImpl: (CallbackQuery.id, string, bool) => promise<unit> = "interaction_acknowledgeClick"

@module("./InterpreterMtCute.js")
external enforceDecisionImpl: (Peer.id<'a>, Peer.id<Peer.user>, decision, context) => promise<unit> = "interaction_enforceDecision"

@module("./InterpreterMtCute.js")
external logActivityImpl: (log_kind, Peer.id<'a>, Peer.id<Peer.user>) => promise<unit> = "interaction_logActivity"

@module("./InterpreterMtCute.js")
external sendTempMessageImpl: (Peer.id<'a>, string) => promise<unit> = "interaction_sendTempMessage"

@module("./InterpreterMtCute.js")
external scheduleMessageCleanupImpl: (Message.location<'a>, int) => promise<unit> = "interaction_scheduleMessageCleanup"

@module("./InterpreterMtCute.js")
external restrictUserImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<unit> = "interaction_restrictUser"

@module("./InterpreterMtCute.js")
external waitAndPeekSessionImpl: (string, int) => promise<option<session>> = "interaction_waitAndPeekSession"

@module("./InterpreterMtCute.js")
external cooldownCheckImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<bool> = "cooldown_check"

@module("./InterpreterMtCute.js")
external cooldownApplyImpl: (Peer.id<'a>, Peer.id<Peer.user>, int) => promise<unit> = "cooldown_apply"

@module("./InterpreterMtCute.js")
external sessionSaveImpl: session => promise<unit> = "session_save"

@module("./InterpreterMtCute.js")
external sessionFindByTokenImpl: string => promise<option<session>> = "session_findByToken"

@module("./InterpreterMtCute.js")
external sessionFindPendingImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<option<session>> = "session_findPending"

@module("./InterpreterMtCute.js")
external sessionDeleteImpl: string => promise<unit> = "session_delete"

@module("./InterpreterMtCute.js")
external sessionCleanupImpl: session => promise<unit> = "session_cleanup"

@module("./InterpreterMtCute.js")
external sessionUpdateLocationImpl: (session, Message.location<Peer.unknown>) => promise<unit> = "session_updateLocation"

@module("./InterpreterMtCute.js")
external quizGetRandomImpl: unit => promise<option<quiz>> = "quiz_getRandom"

@module("./InterpreterMtCute.js")
external quizReloadImpl: unit => promise<result<unit, string>> = "quiz_reload"

module Interaction: InteractionSig.S with type t<'a> = promise<'a> = {
  type t<'a> = promise<'a>

  let pure = pureImpl
  let bind = bindImpl

  let presentChallenge = (~chatId, ~userId, ~question, ~options) =>
    presentChallengeImpl(chatId, userId, question, options)

  let updateStatus = (~loc, ~status) => updateStatusImpl(loc, status)
  let destroyUI = (~loc) => destroyUIImpl(loc)

  let acknowledgeClick = (~queryId, ~text, ~showAlert) =>
    acknowledgeClickImpl(queryId, text, showAlert)

  let enforceDecision = (~chatId, ~userId, ~decision, ~context) =>
    enforceDecisionImpl(chatId, userId, decision, context)

  let logActivity = (~kind, ~chatId, ~userId) =>
    logActivityImpl(kind, chatId, userId)

  let sendTempMessage = (~chatId, ~text) =>
    sendTempMessageImpl(chatId, text)

  let scheduleMessageCleanup = (~loc, ~delaySec) =>
    scheduleMessageCleanupImpl(loc, delaySec)

  let restrictUser = (~chatId, ~userId) =>
    restrictUserImpl(chatId, userId)

  let waitAndPeekSession = (~sessionId, ~delaySec) =>
    waitAndPeekSessionImpl(sessionId, delaySec)
}

module State: StateSig.S with type t<'a> = promise<'a> = {
  type t<'a> = promise<'a>

  let pure = pureImpl
  let bind = bindImpl

  module Cooldown = {
    let check = (~chatId, ~userId) => cooldownCheckImpl(chatId, userId)
    let apply = (~chatId, ~userId, ~durationSec) =>
      cooldownApplyImpl(chatId, userId, durationSec)
  }

  module Session = {
    let save = sessionSaveImpl
    let findByToken = sessionFindByTokenImpl
    let findPending = (~chatId, ~userId) =>
      sessionFindPendingImpl(chatId, userId)
    let delete = sessionDeleteImpl
    let cleanup = sessionCleanupImpl
    let updateLocation = sessionUpdateLocationImpl
  }
}

module QuizSource: QuizSourceSig.S with type t<'a> = promise<'a> = {
  type t<'a> = promise<'a>

  let pure = pureImpl
  let bind = bindImpl

  let getRandom = quizGetRandomImpl
  let reload = quizReloadImpl
}

module App = Flow.Make(Interaction, State, QuizSource)
