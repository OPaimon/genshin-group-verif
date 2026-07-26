import { createSqliteStore } from './sqliteStore.js'
import { runStoreContract } from './storeContract.js'

runStoreContract('sqlite', () => createSqliteStore(':memory:'))
