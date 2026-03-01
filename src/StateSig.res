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
    let delete: string => t<unit>

    /// 全量清理: 删除 session + lookup + token_map + timeout_queue
    let cleanup: Domain.session => t<unit>

    /// 更新 session 的 verificationLocation 字段
    let updateLocation: (Domain.session, Domain.Message.location<Domain.Peer.unknown>) => t<unit>
  }
}
