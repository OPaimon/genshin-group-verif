# Copilot Instructions for genshin-group-verif

## Project Overview
A Telegram bot built with **mtcute** (lightweight Telegram client library) for group verification. Uses TypeScript with ReScript compilation support, managed with pnpm and tsx for development/production.

## Architecture & Key Patterns

### Bot Setup (src/main.ts)
- **TelegramClient**: Initialized with API credentials from env vars, stores session in `bot-data/session`
- **Dispatcher**: Routes incoming messages to handlers based on filters
- **Pattern**: Register handlers with `dp.onNewMessage(filters.condition, async handler)` 
- Session persistence enables stateful bot operations across restarts

### Environment Management (src/env.ts)
- Uses **Zod** for runtime schema validation of env vars
- Required vars: `API_ID` (number), `API_HASH`, `BOT_TOKEN` (strings)
- Throws early with detailed error messages if validation fails
- **Pattern**: Import `{ env }` to access validated config throughout codebase

### Language Integration
- **Primary**: TypeScript (src/*.ts) - main bot logic
- **Secondary**: ReScript (src/*.res) - compiles to ESM (.res.mjs) via rescript.json config
- Both compile to `src/` directory; ReScript outputs `.res.mjs` files alongside sources
- No build step needed before running - tsx handles TypeScript at runtime

### ReScript & TypeScript Interop with genType
ReScript uses **genType** to automatically generate TypeScript type definitions:
- Add `@genType` annotations to ReScript exports that will be used from TypeScript
- genType generates `.gen.tsx` files with complete type definitions during compilation
- TypeScript imports from `.gen.tsx` files get full type checking and IDE support
- No manual type maintenance needed - types stay synchronized automatically

**Example workflow**:
```rescript
// src/Handlers.res
@genType
type message = { answerText: string => promise<unit> }

@genType
let handleStart = async (msg: message) => {
  await msg.answerText("Hello!")
}
```
Generates `Handlers.gen.tsx` with:
```typescript
export type message = { readonly answerText: (arg: string) => Promise<void> };
export const handleStart: (msg: message) => Promise<void>;
```
TypeScript imports and gets full type safety:
```typescript
import { handleStart, type message } from './Handlers.gen.js'
await handleStart(msg)  // ✅ Type checked
```

See `GENTYPE_APPLICATION.md` for detailed setup and examples.

### ReScript Documentation
ReScript documentation is available locally in `.github/`:
- **llm-full.txt**: Complete ReScript documentation with all examples and details
- **llm-small.txt**: Abridged version with essential content for quick reference
- **llms.txt**: Index and overview of available documentation sets
Reference these files when working with ReScript code for syntax, stdlib APIs, and patterns.

## Development Workflow

### Commands
- `pnpm dev`: Watch mode with hot-reload for main.ts changes
- `pnpm start`: Production mode (requires .env file)
- `pnpm res:build`, `pnpm res:dev`, `pnpm res:clean`: ReScript compilation tasks
- `pnpm lint` / `pnpm lint:fix`: ESLint (@antfu/eslint-config)

### Getting Started
```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env with API_ID, API_HASH, BOT_TOKEN
pnpm dev
```

### Dependencies
- **@mtcute/dispatcher**: Message routing and filter matching
- **@mtcute/node**: Telegram client with node.js transport
- **tsx**: TypeScript execution without build step
- **zod**: Schema validation

## Project Structure
- `src/`: TypeScript + ReScript sources (main entry: main.ts)
- `lib/bs/`: ReScript build artifacts (compiled .cmj files)
- `bot-data/`: Persisted bot session (SQLite with WAL)
- Dockerfile: Alpine Node 22, uses pnpm for deps

## Architecture Pattern: Hybrid TypeScript + ReScript

**Current Design**: Separates concerns by language
- **TypeScript** (`src/main.ts`): mtcute integration, TelegramClient initialization, Dispatcher setup, message routing
- **ReScript** (`src/Handlers.res`, etc): Business logic, message handlers, type-safe async operations

**Compilation flow**:
1. `pnpm res:build` compiles `*.res` files → `*.res.mjs` (ESModule)
2. `main.ts` imports handlers: `import * as Handlers from './Handlers.res.mjs'`
3. Both run together: TS calls ReScript handlers via standard ES imports

**Why this pattern**:
- mtcute is pure TypeScript (frequently updated APIs) - keep in TS to avoid binding maintenance
- Business logic benefits from ReScript's strong types and immutability guarantees
- Minimal risk: failing ts → rescript is low-cost, can proceed incrementally
- No performance overhead: ReScript compiles to efficient JavaScript


## Conventions & Gotchas
- **Session persistence**: Changes in `bot-data/session` survive restarts - critical for state
- **ReScript modules**: Can import .res.mjs files directly in TypeScript but keep logic separate
- **Error handling**: All env validation errors halt startup (intentional fail-fast)
- **ESLint**: Uses @antfu config - run `lint:fix` before commits
