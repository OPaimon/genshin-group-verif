open Domain
open Utils

let messageDeletionDelaySec = 10
let sessionCleanupDelaySec = 60
let cooldownDurationSec = 60

module Make = (
  I: InteractionSig.S,
  S: StateSig.S with type t<'a> = I.t<'a>,
  Q: QuizSourceSig.S with type t<'a> = I.t<'a>,
) => {
  let return = I.pure
  let bind = I.bind

  // ── helpers ───────────────────────────────

  type quizWithTokens = {
    question: string,
    optionsWithTokens: array<option_with_token>,
    correctToken: string,
  }

  let prepareQuiz = (quiz: quiz): quizWithTokens => {
    let withTokens =
      quiz.options->Array.map((text): option_with_token => {optionText: text, token: randomUUID()})
    let correctToken = Array.getUnsafe(withTokens, quiz.correctOptionIndex).token
    let shuffled = withTokens->shuffle
    {question: quiz.question, optionsWithTokens: shuffled, correctToken}
  }

  let targetChat = (session: session) =>
    switch session.context {
    | In_group => session.chatId
    | Join_request => session.userId->Peer.widen
    }

  // claim 输掉竞争(会话已被并发路径处理)时的统一回复
  let ackExpired = queryId =>
    I.acknowledgeClick(~queryId, ~text=`验证已过期或无效，请重新发起。`, ~showAlert=true)

  let cleanupWithMessage = (session: session) =>
    S.Session.claim(session.id)->bind(claimed =>
      switch claimed {
      | Some({verificationLocation: Some(loc)}) =>
        I.scheduleMessageCleanup(~loc, ~delaySec=messageDeletionDelaySec)
      | Some({verificationLocation: None}) | None => return()
      }
    )

  // 通用: 「验证失败」→ 编辑消息 → 踢出/拒绝 → 日志
  let rejectAndLog = (~session: session, ~loc, ~text, ~logKind) =>
    I.updateStatus(~loc, ~status=text)
    ->bind(() =>
      I.enforceDecision(
        ~chatId=session.chatId,
        ~userId=session.userId,
        ~decision=Punish_soft,
        ~context=session.context,
      )
    )
    ->bind(() => I.logActivity(~kind=logKind, ~chatId=session.chatId, ~userId=session.userId))

  // 验证题发送失败: 没有验证消息可编辑/清理, 直接裁决为验证失败。
  // 先 claim 再裁决, 输给超时观察者 (claim → None) 时放弃, 避免重复处理。
  let rejectChallengeSendFailure = (session: session) =>
    S.Session.claim(session.id)->bind(claimed =>
      switch claimed {
      | None => return()
      | Some(session) =>
        I.enforceDecision(
          ~chatId=session.chatId,
          ~userId=session.userId,
          ~decision=Punish_soft,
          ~context=session.context,
        )
        ->bind(() =>
          I.logActivity(~kind=Fail_error, ~chatId=session.chatId, ~userId=session.userId)
        )
      }
    )

  // ── Handle Timeout ────────────────────────

  // 先原子认领会话 — 若已被答题回调处理 (claim → None) 则直接放弃, 不惩罚
  let handleTimeout = (session: session) =>
    S.Session.claim(session.id)->bind(claimed =>
      switch claimed {
      | None => return()
      | Some(session) =>
        I.enforceDecision(
          ~chatId=session.chatId,
          ~userId=session.userId,
          ~decision=Punish_soft,
          ~context=session.context,
        )
        ->bind(() =>
          switch session.verificationLocation {
          | Some(loc) =>
            I.updateStatus(~loc, ~status=`验证已超时，操作已被取消。`)->bind(() =>
              I.scheduleMessageCleanup(~loc, ~delaySec=messageDeletionDelaySec)
            )
          | None => return()
          }
        )
        ->bind(() =>
          I.logActivity(~kind=Fail_timeout, ~chatId=session.chatId, ~userId=session.userId)
        )
      }
    )

  // fork: 启动超时观察者, 但不并入调用者的效应链 — 兜底不能依赖后续效应成功。
  // 注意: 被丢弃的链绝不能 reject, 其中各效应的实现必须自行吞掉错误。
  let armTimeoutObserver = (session: session) =>
    S.Session.waitAndPeek(~sessionId=session.id, ~delaySec=sessionCleanupDelaySec)
    ->bind(maybeSession =>
      switch maybeSession {
      | Some(session) => handleTimeout(session)
      | None => return()
      }
    )
    ->discard

  // ── Start Verification ────────────────────

  let startVerification = (input: start_input) => {
    let {userId, chatId, userChatId, userFirstName, context} = input

    let bail = msg =>
      I.sendTempMessage(~chatId=userChatId, ~text=msg)->bind(() =>
        I.enforceDecision(~chatId, ~userId, ~decision=Punish_soft, ~context)
      )

    S.Cooldown.check(~chatId, ~userId)->bind(onCooldown =>
      if onCooldown {
        bail(`您处于冷却时间内，请稍后再试。`)
      } else {
        S.Session.findPending(~chatId, ~userId)->bind(pending =>
          switch pending {
          // ── 存在旧会话: 清理 → 通知 → 踢出 ──
          | Some(old) =>
            cleanupWithMessage(old)->bind(
              () =>
                bail(`您有一个正在进行的验证。我们已将其清理。\n请您重新加入以开始新的验证。`),
            )

          // ── 正常流程 ──
          | None =>
            // 先确认题库可用再做任何对用户可见的动作 —
            // 服务不可用时不应留下「已被禁言却无题可答」的用户
            Q.getRandom()->bind(
              maybeQuiz =>
                switch maybeQuiz {
                | None =>
                  bail(`验证服务当前不可用，我们无法处理您的请求。`)

                | Some(raw) =>
                  let quiz = prepareQuiz(raw)
                  let session: session = {
                    id: randomUUID(),
                    chatId,
                    userId,
                    correctToken: quiz.correctToken,
                    context,
                    optionsWithTokens: quiz.optionsWithTokens,
                    verificationLocation: None,
                  }
                  let options = quiz.optionsWithTokens->Array.map(o => (o.optionText, o.token))
                  let dest = targetChat(session)

                  // in-group 先禁言
                  switch context {
                  | In_group => I.restrictUser(~chatId, ~userId)
                  | Join_request => return()
                  }
                  ->bind(() => S.Session.save(session))
                  ->bind(() => {
                    // 兜底观察者仍先挂上; presentChallenge 返回 option, 发送失败
                    // 不再打断整条链, 而是进入下方 None 分支立即裁决
                    armTimeoutObserver(session)
                    I.presentChallenge(
                      ~chatId=dest,
                      ~userId,
                      ~userFirstName,
                      ~question=quiz.question,
                      ~options,
                      ~timeoutSec=sessionCleanupDelaySec,
                    )
                  })
                  ->bind(sent =>
                    switch sent {
                    | Some(loc) =>
                      S.Session.updateLocation(session, loc)
                      ->bind(() => I.logActivity(~kind=Request_start, ~chatId, ~userId))
                    | None => rejectChallengeSendFailure(session)
                    }
                  )
                },
            )
          }
        )
      }
    )
  }

  // ── Handle Callback (quiz answer) ─────────

  let handleCallback = (cb: callback_input) => {
    let {callbackData, queryId, userId, messageLocation} = cb

    S.Session.findByToken(callbackData)->bind(found =>
      switch found {
      | None =>
        // token 无效/过期 — 直接告知
        ackExpired(queryId)

      | Some(session) if session.userId != userId =>
        // 不是本人 — 不 claim, 会话保持原样
        I.acknowledgeClick(~queryId, ~text=`该验证不适用于你。`, ~showAlert=true)

      | Some(session) =>
        // 终态转移: 先原子认领。findByToken 和 claim 之间可能被并发路径
        // (超时/重复点击)抢先 — 输掉 claim 则视为过期, 不做任何裁决。
        S.Session.claim(session.id)->bind(claimed =>
          switch claimed {
          | None => ackExpired(queryId)

          | Some(session) if session.correctToken == callbackData =>
            // 回答正确
            I.acknowledgeClick(~queryId, ~text=`验证通过！`, ~showAlert=false)
            ->bind(() => I.updateStatus(~loc=messageLocation, ~status=`验证通过！欢迎加入！`))
            ->bind(() =>
              I.enforceDecision(
                ~chatId=session.chatId,
                ~userId=session.userId,
                ~decision=Grant_access,
                ~context=session.context,
              )
            )
            ->bind(() =>
              I.scheduleMessageCleanup(~loc=messageLocation, ~delaySec=messageDeletionDelaySec)
            )
            ->bind(() =>
              I.logActivity(~kind=Success, ~chatId=session.chatId, ~userId=session.userId)
            )

          | Some(session) =>
            // 回答错误
            I.acknowledgeClick(~queryId, ~text=`回答错误，验证失败。`, ~showAlert=true)
            ->bind(() =>
              rejectAndLog(
                ~session,
                ~loc=messageLocation,
                ~text=`验证失败，入群请求已被拒绝。`,
                ~logKind=Fail_error,
              )
            )
            ->bind(() =>
              I.scheduleMessageCleanup(~loc=messageLocation, ~delaySec=messageDeletionDelaySec)
            )
            ->bind(() =>
              S.Cooldown.apply(
                ~chatId=session.chatId,
                ~userId=session.userId,
                ~durationSec=cooldownDurationSec,
              )
            )
          }
        )
      }
    )
  }
}
