open Domain

@module("./interpreter/task.js")
external pureImpl: 'a => promise<'a> = "pure"

@module("./interpreter/task.js")
external bindImpl: (promise<'a>, 'a => promise<'b>) => promise<'b> = "bind"

@module("./interpreter/interaction.js")
external presentChallengeImpl: (
  Peer.id<'a>,
  Peer.id<Peer.user>,
  string,
  string,
  array<(string, string)>,
  int,
) => promise<Message.location<'a>> = "interaction_presentChallenge"

@module("./interpreter/interaction.js")
external updateStatusImpl: (Message.location<'a>, string) => promise<unit> = "interaction_updateStatus"

@module("./interpreter/interaction.js")
external acknowledgeClickImpl: (CallbackQuery.id, string, bool) => promise<unit> = "interaction_acknowledgeClick"

@module("./interpreter/interaction.js")
external enforceDecisionImpl: (Peer.id<'a>, Peer.id<Peer.user>, decision, context) => promise<unit> = "interaction_enforceDecision"

@module("./interpreter/interaction.js")
external logActivityImpl: (log_kind, Peer.id<'a>, Peer.id<Peer.user>) => promise<unit> = "interaction_logActivity"

@module("./interpreter/interaction.js")
external sendTempMessageImpl: (Peer.id<'a>, string) => promise<unit> = "interaction_sendTempMessage"

@module("./interpreter/interaction.js")
external scheduleMessageCleanupImpl: (Message.location<'a>, int) => promise<unit> = "interaction_scheduleMessageCleanup"

@module("./interpreter/interaction.js")
external restrictUserImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<unit> = "interaction_restrictUser"

@module("./interpreter/state.js")
external sessionWaitAndPeekImpl: (string, int) => promise<option<session>> = "session_waitAndPeek"

@module("./interpreter/state.js")
external cooldownCheckImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<bool> = "cooldown_check"

@module("./interpreter/state.js")
external cooldownApplyImpl: (Peer.id<'a>, Peer.id<Peer.user>, int) => promise<unit> = "cooldown_apply"

@module("./interpreter/state.js")
external sessionSaveImpl: session => promise<unit> = "session_save"

@module("./interpreter/state.js")
external sessionFindByTokenImpl: string => promise<option<session>> = "session_findByToken"

@module("./interpreter/state.js")
external sessionFindPendingImpl: (Peer.id<'a>, Peer.id<Peer.user>) => promise<option<session>> = "session_findPending"

@module("./interpreter/state.js")
external sessionClaimImpl: string => promise<option<session>> = "session_claim"

@module("./interpreter/state.js")
external sessionUpdateLocationImpl: (session, Message.location<Peer.unknown>) => promise<unit> = "session_updateLocation"

@module("./interpreter/quizSource.js")
external quizGetRandomImpl: unit => promise<option<quiz>> = "quiz_getRandom"

@module("./interpreter/quizSource.js")
external quizReloadImpl: unit => promise<result<unit, string>> = "quiz_reload"

module Interaction: InteractionSig.S with type t<'a> = promise<'a> = {
  type t<'a> = promise<'a>

  let pure = pureImpl
  let bind = bindImpl

  let presentChallenge = (~chatId, ~userId, ~userFirstName, ~question, ~options, ~timeoutSec) =>
    presentChallengeImpl(chatId, userId, userFirstName, question, options, timeoutSec)

  let updateStatus = (~loc, ~status) => updateStatusImpl(loc, status)

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
    let claim = sessionClaimImpl
    let updateLocation = sessionUpdateLocationImpl
    let waitAndPeek = (~sessionId, ~delaySec) =>
      sessionWaitAndPeekImpl(sessionId, delaySec)
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
