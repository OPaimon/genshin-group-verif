module type S = {

  type t<'a>
  let pure: 'a => t<'a>
  let bind: (t<'a>, 'a => t<'b>) => t<'b>

  let presentChallenge: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
    ~question: string,
    ~options: array<(string, string)>,
  ) => t<Domain.Message.location<'a>>

  let updateStatus: (~loc: Domain.Message.location<'a>, ~status: string) => t<unit>

  let destroyUI: (~loc: Domain.Message.location<'a>) => t<unit>

  let acknowledgeClick: (~queryId: Domain.CallbackQuery.id, ~text: string, ~showAlert: bool) => t<unit>

  let enforceDecision: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
    ~decision: Domain.decision,
    ~context: Domain.context,
  ) => t<unit>

  let logActivity: (~kind: Domain.log_kind, ~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>) => t<unit>

  let sendTempMessage: (~chatId: Domain.Peer.id<'a>, ~text: string) => t<unit>

  let scheduleMessageCleanup: (~loc: Domain.Message.location<'a>, ~delaySec: int) => t<unit>

  let restrictUser: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
  ) => t<unit>

  let waitAndPeekSession: (~sessionId: string, ~delaySec: int) => t<option<Domain.session>>
}
