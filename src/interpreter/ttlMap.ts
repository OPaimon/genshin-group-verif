/**
 * A Map that automatically expires entries after their TTL.
 * Supports periodic background sweeps to prevent unbounded memory growth.
 */
export class TTLMap<K, V> {
    private _data = new Map<K, { value: V, expiresAt: number }>()
    private _timer: ReturnType<typeof setInterval>

    constructor(sweepIntervalMs: number = 60_000) {
        this._timer = setInterval(() => this._sweep(), sweepIntervalMs)
        // Allow Node.js process to exit naturally even with the timer
        if (typeof this._timer === 'object' && 'unref' in this._timer) {
            this._timer.unref()
        }
    }

    set(key: K, value: V, ttlMs: number): void {
        this._data.set(key, { value, expiresAt: Date.now() + ttlMs })
    }

    get(key: K): V | undefined {
        const entry = this._data.get(key)
        if (!entry) return undefined
        if (Date.now() > entry.expiresAt) {
            this._data.delete(key)
            return undefined
        }
        return entry.value
    }

    has(key: K): boolean {
        return this.get(key) !== undefined
    }

    delete(key: K): void {
        this._data.delete(key)
    }

    /** All live values (expired entries are skipped and dropped). */
    values(): V[] {
        const now = Date.now()
        const result: V[] = []
        for (const [key, entry] of this._data) {
            if (now > entry.expiresAt) {
                this._data.delete(key)
            } else {
                result.push(entry.value)
            }
        }
        return result
    }

    /** Stop the background sweep timer. The map itself remains usable. */
    dispose(): void {
        clearInterval(this._timer)
    }

    private _sweep(): void {
        const now = Date.now()
        for (const [key, entry] of this._data) {
            if (now > entry.expiresAt) {
                this._data.delete(key)
            }
        }
    }
}
