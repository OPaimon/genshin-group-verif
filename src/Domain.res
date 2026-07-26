@genType
type context =
  | In_group
  | Join_request

@genType
type decision =
  | Grant_access // 通过验证
  | Punish_soft // 软惩罚 (踢出/拒绝, 可重新加入)

@genType
type log_kind =
  | Request_start
  | Success
  | Fail_timeout
  | Fail_error

@genType
module Peer = {
  type user
  type unknown

  type id<'a> = private float

  external value: id<'a> => float = "%identity"

  external unsafeCastUser: float => id<user> = "%identity"
  external unsafeCastAny: float => id<'a> = "%identity"

  let widen = (peerId: id<'a>): id<unknown> =>
    peerId->value->unsafeCastAny
}


@genType
module Message = {
  type id = private int
  external castId: int => id = "%identity"

  type location<'a> = (Peer.id<'a>, id)

  let at = (peerId: Peer.id<'a>, rawId: int): location<'a> => (peerId, castId(rawId))
}

@genType
module CallbackQuery = {
  type id = private BigInt.t
}

@genType
type option_with_token = {
  optionText: string,
  token: string,
}

@genType
type session = {
  id: string,
  chatId: Peer.id<Peer.unknown>,
  userId: Peer.id<Peer.user>,
  correctToken: string,
  context: context,
  optionsWithTokens: array<option_with_token>,
  verificationLocation: option<Message.location<Peer.unknown>>,
}

@genType
type quiz = {
  id: int,
  question: string,
  options: array<string>,
  correctOptionIndex: int,
}

@genType
type callback_input = {
  callbackData: string,
  queryId: CallbackQuery.id,
  userId: Peer.id<Peer.user>,
  messageLocation: Message.location<Peer.unknown>,
}

@genType
type start_input = {
  userId: Peer.id<Peer.user>,
  chatId: Peer.id<Peer.unknown>,
  userChatId: Peer.id<Peer.unknown>,
  userFirstName: string,
  context: context,
}
