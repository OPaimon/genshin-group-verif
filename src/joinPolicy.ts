import type { TelegramClient } from '@mtcute/node'

/**
 * Security policy: a member added or approved by the chat creator/an admin
 * skips quiz verification. A failed actor lookup returns false — lookup
 * errors must not become a verification bypass.
 */
export async function wasAddedByAdmin(tg: TelegramClient, chatId: number, userId: number, actorId: number): Promise<boolean> {
    if (actorId === userId) return false
    try {
        const member = await tg.getChatMember({ chatId, userId: actorId })
        return member?.status === 'creator' || member?.status === 'admin'
    } catch {
        return false
    }
}
