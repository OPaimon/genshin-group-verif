import type { StateBackendConfig, StateStore } from './store.js'

import { createMemoryStore } from './memoryStore.js'
import { createRedisStore } from './redisStore.js'
import { createSqliteStore } from './sqliteStore.js'

export function createStore(config: StateBackendConfig): StateStore {
    switch (config.backend) {
        case 'memory':
            return createMemoryStore()
        case 'sqlite':
            return createSqliteStore(config.path)
        case 'redis':
            return createRedisStore(config.url, config.keyPrefix)
    }
}
