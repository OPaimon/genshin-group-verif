import type { Peer_id, Peer_unknown, Peer_user } from '../Domain.gen.js'

export const toUnknownPeerId = (id: number): Peer_id<Peer_unknown> => id as Peer_id<Peer_unknown>
export const toUserPeerId = (id: number): Peer_id<Peer_user> => id as Peer_id<Peer_user>

export function peerKey(chatId: Peer_id<Peer_unknown>, userId: Peer_id<Peer_user>): string {
    return `${chatId as number}:${userId as number}`
}
