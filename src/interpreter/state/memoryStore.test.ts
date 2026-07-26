import { createMemoryStore } from './memoryStore.js'
import { runStoreContract } from './storeContract.js'

runStoreContract('memory', () => createMemoryStore())
