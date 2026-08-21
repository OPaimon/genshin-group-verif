module type S = {

  type t<'a>
  let pure: 'a => t<'a>
  let bind: (t<'a>, 'a => t<'b>) => t<'b>
  /// 从惰性 effect thunk 中恢复同步异常或异步 rejection。
  /// thunk 确保 identity mock 也能捕获 effect 构造期间的同步 throw。
  let recoverError: (() => t<'a>, exn => t<'a>) => t<'a>

  /// detached timeout observer 的最后一道日志边界；实现必须永不失败。
  let logObserverError: exn => t<unit>

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
  ) => t<unit>

  let logActivity: (~kind: Domain.log_kind, ~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>) => t<unit>

  let sendTempMessage: (~chatId: Domain.Peer.id<'a>, ~text: string) => t<unit>

  let scheduleMessageCleanup: (~loc: Domain.Message.location<'a>, ~delaySec: int) => t<unit>

  /// 建立无自动到期的群内隔离。失败必须 reject/throw，调用方会立即尝试踢出。
  let restrictUser: (
    ~chatId: Domain.Peer.id<'a>,
    ~userId: Domain.Peer.id<Domain.Peer.user>,
  ) => t<unit>
}
