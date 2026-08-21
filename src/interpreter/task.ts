/**
 * Monad instance for the effect chain: t<'a> = Promise<'a>.
 * Bound by AppBridge.res as `pure`/`bind` for all three signature modules.
 */

export const pure = <T>(value: T): Promise<T> => Promise.resolve(value)

export function bind<T, U>(task: Promise<T>, fn: (value: T) => Promise<U>): Promise<U> {
    return task.then(fn)
}

export function recoverError<T>(task: () => Promise<T>, recover: (error: unknown) => Promise<T>): Promise<T> {
    return Promise.resolve().then(task).catch(recover)
}
