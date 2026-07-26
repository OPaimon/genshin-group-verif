module type S = {
  type t<'a>
  let pure: 'a => t<'a>
  let bind: (t<'a>, 'a => t<'b>) => t<'b>

  module Cooldown: {
    let check: (~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>) => t<bool>
    let apply: (~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>, ~durationSec: int) => t<unit>
  }

  module Session: {
    let save: Domain.session => t<unit>
    let findByToken: string => t<option<Domain.session>>
    let findPending: (~chatId: Domain.Peer.id<'a>, ~userId: Domain.Peer.id<Domain.Peer.user>) => t<option<Domain.session>>

    /// 原子认领: 一步完成「取出 + 全量删除 (session + lookup + token_map)」。
    /// 会话的终态转移 (通过/失败/超时) 必须先 claim, 拿到 Some 才有权执行;
    /// None 表示已被并发路径处理, 调用方必须放弃。
    let claim: string => t<option<Domain.session>>

    /// 更新 session 的 verificationLocation 字段
    let updateLocation: (Domain.session, Domain.Message.location<Domain.Peer.unknown>) => t<unit>

    /// 超时观察: 等待 delaySec 后窥视会话是否仍在。None = 已被应答路径处理,
    /// 超时链应放弃。最终裁决仍由 claim 完成 — 这里只是避免多余的超时链。
    let waitAndPeek: (~sessionId: string, ~delaySec: int) => t<option<Domain.session>>
  }
}
