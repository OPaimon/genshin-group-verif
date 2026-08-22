import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

process.env.API_ID ??= '1'
process.env.API_HASH ??= 'dummy'
process.env.BOT_TOKEN ??= 'dummy'
process.env.LOG_PEER ??= '1'

interface Binding {
    wrapperName: string
    moduleFile: string
    boundName: string
    callArgCount: number
    returnsValue: boolean
}

const IMPORT_PATTERN = /import \* as (\w+) from "(\.\/interpreter\/[^"\n]+\.js)";/g
const IMPL_DECLARATION_PATTERN = /function (\w+Impl)\s*\(/g
const IMPL_WRAPPER_PATTERN = /function (\w+Impl)\s*\(([^)]*)\) \{\s*(return )?(\w+)\.([\w$]+)\(([^;]*)\);\s*\}/g

function parseBindings(source: string): Binding[] {
    const imports = new Map<string, string>()
    for (const match of source.matchAll(IMPORT_PATTERN)) {
        imports.set(match[1], match[2])
    }
    assert.ok(imports.size > 0, 'AppBridge parser found no ./interpreter/*.js namespace imports')

    const declaredWrappers = [...source.matchAll(IMPL_DECLARATION_PATTERN)].map(match => match[1])
    assert.ok(declaredWrappers.length > 0, 'AppBridge parser found no generated *Impl wrapper functions')

    const bindings: Binding[] = []
    for (const match of source.matchAll(IMPL_WRAPPER_PATTERN)) {
        const [, wrapperName, , returnKeyword, moduleAlias, boundName, rawArgs] = match
        const moduleFile = imports.get(moduleAlias)
        assert.ok(moduleFile, `${wrapperName} calls unknown namespace ${moduleAlias}`)

        const args = rawArgs.trim() === '' ? [] : rawArgs.split(',').map(arg => arg.trim())
        for (const arg of args) {
            assert.match(arg, /^prim\d*$/, `${wrapperName} has unsupported generated call argument: ${arg}`)
        }
        bindings.push({
            wrapperName,
            moduleFile,
            boundName,
            callArgCount: args.length,
            returnsValue: returnKeyword !== undefined,
        })
    }

    const parsedWrappers = new Set(bindings.map(binding => binding.wrapperName))
    const unparsedWrappers = declaredWrappers.filter(name => !parsedWrappers.has(name))
    assert.deepStrictEqual(
        unparsedWrappers,
        [],
        `AppBridge parser does not understand current ReScript 12.1 Impl wrapper output: ${unparsedWrappers.join(', ')}`,
    )

    return bindings
}

test('AppBridge generated Impl wrappers match TypeScript exports and arities', async () => {
    const source = await readFile(new URL('../AppBridge.res.mjs', import.meta.url), 'utf8')
    const bindings = parseBindings(source)
    const failures: string[] = []
    const observed = new Set<string>()
    const voidWrappers: Record<string, true> = { detachImpl: true }

    for (const binding of bindings) {
        observed.add(`${binding.moduleFile}:${binding.boundName}`)
        const isVoidWrapper = voidWrappers[binding.wrapperName] === true
        if (binding.returnsValue === isVoidWrapper) {
            failures.push(
                binding.returnsValue
                    ? `${binding.wrapperName}: expected a void wrapper but generated code returns its result`
                    : `${binding.wrapperName}: non-void wrapper does not return its result`,
            )
        }
        const moduleUrl = new URL(`..${binding.moduleFile.slice(1)}`, import.meta.url)
        const exports = await import(moduleUrl.href) as Record<string, unknown>
        const bound = exports[binding.boundName]

        if (bound === undefined) {
            failures.push(`${binding.wrapperName}: ${binding.moduleFile} has no export ${binding.boundName}`)
            continue
        }
        if (typeof bound !== 'function') {
            failures.push(`${binding.wrapperName}: ${binding.moduleFile}.${binding.boundName} is ${typeof bound}, not function`)
            continue
        }
        // All current bound exports use plain parameters. A future default/rest
        // parameter needs an explicit exception because Function.length changes.
        if (bound.length !== binding.callArgCount) {
            failures.push(
                `${binding.wrapperName}: ${binding.moduleFile}.${binding.boundName}.length is ${bound.length}, wrapper calls with ${binding.callArgCount} args`,
            )
        }
    }

    for (const requiredRuntimeExport of [
        'pure',
        'bind',
        'recoverError',
        'nowMs',
        'randomUUID',
        'randomInt',
        'sleep',
        'detach',
    ]) {
        assert.ok(
            observed.has(`./interpreter/task.js:${requiredRuntimeExport}`),
            `AppBridge parser did not observe runtime binding ${requiredRuntimeExport}`,
        )
    }
    assert.deepStrictEqual(failures, [], `AppBridge binding conformance failures:\n${failures.join('\n')}`)
})
