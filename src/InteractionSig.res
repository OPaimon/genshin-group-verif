module type S = {

  type t<'a>

  /// timeoutSec 会渲染进提示文案 — 由调用方传入实际的超时时长, 保证文案与行为一致
  /// None = 验证题发送失败; 调用方应直接按验证失败裁决
  let presentChallenge: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
    ~userFirstName: string,
    ~question: string,
    ~options: array<(string, string)>,
    ~timeoutSec: int,
  ) => t<option<Domain.Message.location<'a>>>

  let updateStatus: (~loc: Domain.Message.location<'a>, ~status: string) => t<unit>

  let acknowledgeClick: (~queryId: Domain.CallbackQuery.id, ~text: string, ~showAlert: bool) => t<unit>

  let enforceDecision: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
    ~decision: Domain.decision,
    ~context: Domain.context,
  ) => t<result<unit, string>>

  let logActivity: (~kind: Domain.log_kind, ~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>) => t<unit>

  let sendTempMessage: (~chatId: Domain.Peer.id<'a>, ~text: string) => t<unit>

  let scheduleMessageCleanup: (~loc: Domain.Message.location<'a>, ~delaySec: int) => t<unit>

  /// 建立无自动到期的群内隔离。失败必须 reject/throw，调用方会立即尝试踢出。
  let restrictUser: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
  ) => t<unit>
}
