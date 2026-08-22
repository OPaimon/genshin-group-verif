import * as crypto from 'node:crypto'

import { logger } from '../logger.js'

/** Effect runtime bound to RuntimeSig.S. */
export const pure = <T>(value: T): Promise<T> => Promise.resolve(value)

export function bind<T, U>(task: Promise<T>, fn: (value: T) => Promise<U>): Promise<U> {
    return task.then(fn)
}

export function recoverError<T>(task: () => Promise<T>, recover: (error: unknown) => Promise<T>): Promise<T> {
    return Promise.resolve().then(task).catch(recover)
}

export const nowMs = (): Promise<number> => Promise.resolve(Date.now())

export const randomUUID = (): string => crypto.randomUUID()

export function randomInt(upperExclusive: number): number {
    return crypto.randomInt(upperExclusive)
}

export function sleep(delayMs: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, delayMs)
    return promise
}

/** Start an observer without attaching it to the caller's promise chain. */
export function detach(task: () => Promise<void>): void {
    void recoverError(task, async (error) => {
        try {
            logger.error('[Observer] Timeout observer failed:', error)
        } catch {
            try {
                console.error('[Observer] Timeout observer failed; logger also failed')
            } catch {}
        }
    })
}
