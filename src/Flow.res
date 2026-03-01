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
    let shuffled = withTokens->Array.toSorted((_, _) => Math.random() -. 0.5)
    {question: quiz.question, optionsWithTokens: shuffled, correctToken}
  }

  let targetChat = (session: session) =>
    switch session.context {
    | In_group => session.chatId
    | Join_request => session.userId->Peer.widen
    }

  let cleanupWithMessage = (session: session) =>
    S.Session.cleanup(session)->bind(() =>
      switch session.verificationLocation {
      | Some(loc) => I.scheduleMessageCleanup(~loc, ~delaySec=messageDeletionDelaySec)
      | None => return()
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

  // ── Handle Timeout ────────────────────────

  let handleTimeout = (session: session) =>
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
    ->bind(() => S.Session.cleanup(session))
    ->bind(() => I.logActivity(~kind=Fail_timeout, ~chatId=session.chatId, ~userId=session.userId))


  // ── Start Verification ────────────────────

  let startVerification = (input: start_input) => {
    let {userId, chatId, userChatId, context} = input

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
            // in-group 先禁言
            switch context {
            | In_group => I.restrictUser(~chatId, ~userId)
            | Join_request => return()
            }->bind(
              () =>
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
                      let dest = switch context {
                      | In_group => chatId
                      | Join_request => userId->Peer.widen
                      }

                      S.Session.save(session)
                      ->bind(
                        () =>
                          I.presentChallenge(
                            ~chatId=dest,
                            ~userId,
                            ~question=quiz.question,
                            ~options,
                          ),
                      )
                      ->bind(loc => S.Session.updateLocation(session, loc))
                      ->bind(() => I.logActivity(~kind=Request_start, ~chatId, ~userId))
                      ->bind(
                        () =>
                          I.waitAndPeekSession(
                            ~sessionId=session.id,
                            ~delaySec=sessionCleanupDelaySec,
                          )->bind(
                            maybeSession =>
                              switch maybeSession {
                              | Some(session) => handleTimeout(session)
                              | None => return()
                              },
                          ),
                      )
                    },
                ),
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
        I.acknowledgeClick(
          ~queryId,
          ~text=`验证已过期或无效，请重新发起。`,
          ~showAlert=true,
        )

      | Some(session) if session.userId != userId =>
        // 不是本人
        I.acknowledgeClick(~queryId, ~text=`该验证不适用于你。`, ~showAlert=true)

      | Some(session) if session.correctToken == callbackData =>
        // 回答正确
        I.updateStatus(~loc=messageLocation, ~status=`验证通过！欢迎加入！`)
        ->bind(() =>
          I.enforceDecision(
            ~chatId=session.chatId,
            ~userId=session.userId,
            ~decision=Grant_access,
            ~context=session.context,
          )
        )
        ->bind(() => S.Session.cleanup(session))
        ->bind(() =>
          I.scheduleMessageCleanup(~loc=messageLocation, ~delaySec=messageDeletionDelaySec)
        )
        ->bind(() => I.logActivity(~kind=Success, ~chatId=session.chatId, ~userId=session.userId))

      | Some(session) =>
        // 回答错误
        S.Cooldown.apply(
          ~chatId=session.chatId,
          ~userId=session.userId,
          ~durationSec=cooldownDurationSec,
        )
        ->bind(() => S.Session.cleanup(session))
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
      }
    )
  }
}
