import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexCliEngine,
  REQUIRED_CODEX_FLAGS,
  inspectCodexCli
} from './codex'

interface FakeRun {
  args: string[]
  prompt: string
  child: FakeChild
  env: NodeJS.ProcessEnv
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private closed = false

  readonly kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => this.close(null, 'SIGTERM'))
    return true
  })

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}

function fakeCodex(
  respond: (run: FakeRun) => void
): { spawn: typeof import('node:child_process').spawn; runs: FakeRun[] } {
  const runs: FakeRun[] = []
  const spawn = vi.fn((_file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const child = new FakeChild()
    let prompt = ''
    child.stdin.setEncoding('utf8')
    child.stdin.on('data', (chunk: string) => {
      prompt += chunk
    })
    child.stdin.on('finish', () => {
      const run = { args: [...args], prompt, child, env: options.env ?? {} }
      runs.push(run)
      queueMicrotask(() => respond(run))
    })
    return child as unknown as ChildProcessWithoutNullStreams
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, runs }
}

function message(text: string): string {
  return JSON.stringify({
    type: 'item.completed',
    item: { id: 'item-1', type: 'agent_message', text }
  })
}

function finish(run: FakeRun, text: string): void {
  run.child.stdout.write(`${message(text)}\n`)
  run.child.close(0)
}

function inspectionResult(
  stdout = '',
  stderr = '',
  status: number | null = 0,
  error?: Error
): { stdout: string; stderr: string; status: number | null; signal: null; error?: Error } {
  return { stdout, stderr, status, signal: null, ...(error ? { error } : {}) }
}

function testEngine(
  spawn: typeof import('node:child_process').spawn,
  extra: {
    now?: () => number
    log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
  } = {}
): CodexCliEngine {
  return new CodexCliEngine({
    codexPath: '/bin/codex',
    model: 'gpt-5.6-sol',
    classifierModel: 'gpt-5.6-luna',
    spawn,
    ...extra
  })
}

const classifyRequest = {
  transcript: 'make this crisp',
  app: null,
  selection: 'This is rather long.',
  fieldText: null,
  fieldTruncated: false,
  context: null,
  targets: []
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('inspectCodexCli', () => {
  it('requires every isolation flag and accepts ChatGPT status from stderr', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') return inspectionResult(REQUIRED_CODEX_FLAGS.join('\n'))
      return inspectionResult('', 'Logged in using ChatGPT\n')
    })
    expect(inspectCodexCli('/bin/codex', run)).toEqual({
      path: '/bin/codex',
      version: 'codex-cli 1.2.3',
      compatible: true,
      loggedIn: true,
      reason: null
    })
  })

  it('does not treat API-key auth as subscription auth', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') return inspectionResult(REQUIRED_CODEX_FLAGS.join('\n'))
      return inspectionResult('', 'Logged in using an API key\n')
    })
    expect(inspectCodexCli('/bin/codex', run)).toMatchObject({
      compatible: true,
      loggedIn: false,
      reason: expect.stringMatching(/API key/i)
    })
  })

  it('refuses a CLI missing a required safety option', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli old\n')
      return inspectionResult('--json\n')
    })
    expect(inspectCodexCli('/bin/codex', run)).toMatchObject({
      compatible: false,
      loggedIn: false,
      reason: expect.stringMatching(/missing required options/i)
    })
  })

  it('requires the config override capability used for safety and reasoning', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') {
        return inspectionResult(REQUIRED_CODEX_FLAGS.filter((flag) => flag !== '--config').join('\n'))
      }
      return inspectionResult('', 'Logged in using ChatGPT\n')
    })
    expect(inspectCodexCli('/bin/codex', run)).toMatchObject({
      compatible: false,
      reason: expect.stringMatching(/--config/)
    })
  })

  it('requires explicit model selection support', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli old\n')
      return inspectionResult(REQUIRED_CODEX_FLAGS.filter((flag) => flag !== '--model').join('\n'))
    })
    expect(inspectCodexCli('/bin/codex', run)).toMatchObject({
      compatible: false,
      reason: expect.stringMatching(/--model/)
    })
  })

  it('rejects a nonzero login-status exit', () => {
    const run = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') return inspectionResult(REQUIRED_CODEX_FLAGS.join('\n'))
      return inspectionResult('', 'not logged in', 1)
    })
    expect(inspectCodexCli('/bin/codex', run)).toMatchObject({
      compatible: true,
      loggedIn: false
    })
  })

  it('rejects missing status text and command timeouts', () => {
    const base = (_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') return inspectionResult(REQUIRED_CODEX_FLAGS.join('\n'))
      return inspectionResult()
    }
    expect(inspectCodexCli('/bin/codex', vi.fn(base))).toMatchObject({ loggedIn: false })

    const timedOut = vi.fn((_file: string, args: string[]) => {
      if (args[0] === '--version') return inspectionResult('codex-cli 1.2.3\n')
      if (args[0] === 'exec') return inspectionResult(REQUIRED_CODEX_FLAGS.join('\n'))
      return inspectionResult('', '', null, Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))
    })
    expect(inspectCodexCli('/bin/codex', timedOut)).toMatchObject({ loggedIn: false })
  })

  it('reports a spawn error as an incompatible CLI', () => {
    const missing = vi.fn(() =>
      inspectionResult('', '', null, Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    )
    expect(inspectCodexCli('/bin/codex', missing)).toMatchObject({
      compatible: false,
      loggedIn: false,
      reason: expect.stringMatching(/ENOENT/)
    })
  })
})

describe('CodexCliEngine transport', () => {
  it('uses only the constrained ephemeral CLI contract and keeps the prompt on stdin', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-codex')
    const fake = fakeCodex((run) => finish(run, 'Tighter text.'))
    const engine = testEngine(fake.spawn)
    const partials: string[] = []
    const result = await engine.transform(
      { instruction: 'tighten', text: 'Text that is too long.', app: null },
      (partial) => partials.push(partial)
    )

    expect(result).toEqual({ text: 'Tighter text.' })
    expect(partials).toEqual(['Tighter text.'])
    const run = fake.runs[0]!
    for (const flag of REQUIRED_CODEX_FLAGS.filter((flag) => flag !== '--output-schema')) {
      expect(run.args).toContain(flag)
    }
    expect(run.args).toContain('read-only')
    expect(run.args).toContain('approval_policy="never"')
    expect(run.args).toContain('web_search="disabled"')
    expect(run.args.slice(run.args.indexOf('--model'), run.args.indexOf('--model') + 2)).toEqual([
      '--model',
      'gpt-5.6-sol'
    ])
    expect(run.args).not.toContain('model_reasoning_effort="low"')
    expect(run.args.at(-1)).toBe('-')
    expect(run.args.join(' ')).not.toContain('Text that is too long')
    expect(run.prompt).toContain('<mull-system-instructions>')
    expect(run.prompt).toContain('Text that is too long.')
    expect(run.env['OPENAI_API_KEY']).toBeUndefined()
  })

  it('parses fragmented JSONL and monotonic message snapshots', async () => {
    const fake = fakeCodex((run) => {
      const first = `${message('Hello')}\n`
      const second = `${message('Hello world')}\n`
      run.child.stdout.write(first.slice(0, 17))
      run.child.stdout.write(first.slice(17) + second)
      run.child.close(0)
    })
    const engine = testEngine(fake.spawn)
    const partials: string[] = []
    const result = await engine.answer({ goal: 'say hello' }, (text) => partials.push(text))
    expect(result.text).toBe('Hello world')
    expect(partials).toEqual(['Hello', 'Hello world'])
  })

  it('logs content-free process timing from first event through completion', async () => {
    let clock = 100
    const logs: Array<{ level: string; message: string; meta: unknown }> = []
    const fake = fakeCodex((run) => {
      clock = 125
      run.child.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'private' })}\n`)
      clock = 150
      run.child.stderr.write('raw stderr must stay private')
      run.child.stdout.write(`${message('private assistant response')}\n`)
      clock = 175
      run.child.close(0)
    })
    const engine = new CodexCliEngine({
      codexPath: '/bin/codex',
      model: 'gpt-5.6-sol',
      classifierModel: 'gpt-5.6-luna',
      spawn: fake.spawn,
      now: () => clock,
      log: (level, logMessage, meta) => logs.push({ level, message: logMessage, meta })
    })

    await engine.transform({
      instruction: 'private prompt instruction',
      text: 'private source text',
      app: null
    })

    expect(logs.map((entry) => entry.message)).toEqual([
      'codex.run.start',
      'codex.run.first-event',
      'codex.run.first-text',
      'codex.run.done'
    ])
    expect(logs[0]?.meta).toMatchObject({
      runId: 'c1',
      lane: 'edit',
      model: 'gpt-5.6-sol',
      reasoning: 'default'
    })
    expect(logs[1]?.meta).toMatchObject({ ms: 25, event: 'thread.started' })
    expect(logs[2]?.meta).toMatchObject({ ms: 50, chars: 26 })
    expect(logs[3]?.meta).toMatchObject({ ms: 75, events: 2, chars: 26 })

    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('private prompt instruction')
    expect(serialized).not.toContain('private source text')
    expect(serialized).not.toContain('private assistant response')
    expect(serialized).not.toContain('raw stderr must stay private')
    expect(serialized).not.toContain('thread_id')
  })

  it('writes schemas and images with private permissions, then removes the workspace', async () => {
    let directory = ''
    const fake = fakeCodex((run) => {
      directory = run.args[run.args.indexOf('-C') + 1]!
      const schema = run.args[run.args.indexOf('--output-schema') + 1]!
      const image = run.args[run.args.indexOf('--image') + 1]!
      expect(readdirSync(directory)).toEqual([])
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(schema).mode & 0o777).toBe(0o600)
      expect(statSync(image).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(schema, 'utf8'))).toMatchObject({
        type: 'object',
        additionalProperties: false
      })
      finish(run, '{"verb":"read"}')
    })
    const engine = testEngine(fake.spawn)
    const step = await engine.navigate({
      goal: 'read this',
      app: null,
      context: {
        app: null,
        windowTitle: null,
        blocks: [],
        truncated: false,
        image: {
          mediaType: 'image/jpeg',
          dataBase64: Buffer.from('jpeg').toString('base64'),
          width: 1,
          height: 1,
          bytes: 4
        },
        imageReason: null,
        chars: 0,
        harvestMs: 1
      },
      targets: [],
      history: [],
      stepsLeft: 1
    })
    expect(step).toEqual({ verb: 'read' })
    expect(existsSync(directory)).toBe(false)
  })

  it('supports classification, composition, answers and navigation without optional agent methods', async () => {
    const replies = [
      '{"intent":"edit","target":"selection","instruction":"make this crisp"}',
      'I can send it tomorrow.',
      'They chose Tuesday.',
      '{"verb":"done","found":true,"because":"the thread is open"}'
    ]
    const fake = fakeCodex((run) => finish(run, replies.shift()!))
    const engine = testEngine(fake.spawn)

    await expect(engine.classify(classifyRequest)).resolves.toEqual({
      kind: 'edit',
      target: 'selection',
      instruction: 'make this crisp'
    })
    await expect(engine.compose({ instruction: 'reply', app: null })).resolves.toEqual({
      text: 'I can send it tomorrow.'
    })
    await expect(engine.answer({ goal: 'what was decided?' })).resolves.toEqual({
      text: 'They chose Tuesday.'
    })
    await expect(
      engine.navigate({ goal: 'open it', app: null, targets: [], history: [], stepsLeft: 1 })
    ).resolves.toEqual({ verb: 'done', found: true, because: 'the thread is open' })
    expect('runAgent' in engine).toBe(false)
    expect('distill' in engine).toBe(false)
    expect(fake.runs[0]!.args).toContain('gpt-5.6-luna')
    expect(fake.runs[0]!.args).toContain('model_reasoning_effort="low"')
    for (const run of fake.runs.slice(1)) {
      expect(run.args).toContain('gpt-5.6-sol')
      expect(run.args).not.toContain('model_reasoning_effort="low"')
    }
  })

  it('kills and rejects a run as soon as Codex reports a tool item', async () => {
    let directory = ''
    const log = vi.fn()
    const fake = fakeCodex((run) => {
      directory = run.args[run.args.indexOf('-C') + 1]!
      run.child.stdout.write(
        `${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } })}\n`
      )
    })
    const engine = testEngine(fake.spawn, { log })
    await expect(
      engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    ).rejects.toThrow(/attempted command_execution/i)
    expect(fake.runs[0]!.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(directory)).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'tool-violation' })
    )
  })

  it('rejects malformed JSONL and cleans up the private workspace', async () => {
    let directory = ''
    const log = vi.fn()
    const fake = fakeCodex((run) => {
      directory = run.args[run.args.indexOf('-C') + 1]!
      run.child.stdout.write('{not-json}\n')
    })
    const engine = testEngine(fake.spawn, { log })
    await expect(
      engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    ).rejects.toThrow(/malformed JSONL/i)
    expect(existsSync(directory)).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'malformed-jsonl' })
    )
  })

  it('categorizes a synchronous spawn failure without logging its detail', async () => {
    const log = vi.fn()
    const spawn = vi.fn(() => {
      throw new Error('private executable detail')
    }) as unknown as typeof import('node:child_process').spawn
    const engine = testEngine(spawn, { log })

    await expect(
      engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    ).rejects.toThrow(/private executable detail/)
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'spawn-error' })
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private executable detail')
  })

  it('maps CLI authentication failures to signed-out health', async () => {
    const log = vi.fn()
    const fake = fakeCodex((run) => {
      run.child.stderr.write('Not logged in. Run codex login.')
      run.child.close(1)
    })
    const engine = testEngine(fake.spawn, { log })
    await expect(
      engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    ).rejects.toThrow(/not logged in/i)
    await expect(engine.ready()).resolves.toEqual({ kind: 'signed-out' })
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'nonzero-exit' })
    )
  })

  it('maps CLI usage limits to temporary local-only health', async () => {
    const fake = fakeCodex((run) => {
      run.child.stderr.write('429: usage limit reached')
      run.child.close(1)
    })
    const engine = testEngine(fake.spawn)
    await expect(
      engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    ).rejects.toThrow(/usage limit/i)
    await expect(engine.ready()).resolves.toEqual({
      kind: 'local-only',
      reason: 'you’ve reached your usage limit for now.'
    })
  })

  it('terminates a child that produces no response before the first-response deadline', async () => {
    vi.useFakeTimers()
    let directory = ''
    const log = vi.fn()
    const fake = fakeCodex((run) => {
      directory = run.args[run.args.indexOf('-C') + 1]!
    })
    const engine = testEngine(fake.spawn, { log })
    const pending = engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    const rejected = expect(pending).rejects.toThrow(/said nothing for 60s/i)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60_001)
    await rejected
    expect(fake.runs[0]!.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(directory)).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'timeout' })
    )
  })

  it('terminates active children when disposed', async () => {
    let directory = ''
    const log = vi.fn()
    const fake = fakeCodex(() => {})
    const engine = testEngine(fake.spawn, { log })
    const pending = engine.transform({ instruction: 'tighten', text: 'hello', app: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    directory = fake.runs[0]!.args[fake.runs[0]!.args.indexOf('-C') + 1]!
    await engine.dispose()
    expect(fake.runs[0]!.child.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(pending).rejects.toThrow()
    expect(existsSync(directory)).toBe(false)
    expect(log).toHaveBeenCalledWith(
      'warn',
      'codex.run.failed',
      expect.objectContaining({ category: 'cancelled' })
    )
  })
})
