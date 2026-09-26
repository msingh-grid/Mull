import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NavStep } from '@shared/nav'
import type {
  AnswerRequest,
  ClassifiedIntent,
  ClassifyRequest,
  ComposeRequest,
  Engine,
  EngineState,
  NavigateRequest,
  TransformRequest,
  TransformResult
} from './types'
import { EngineHealth } from './health'
import {
  CLASSIFIER_SYSTEM_PROMPT,
  classifyPrompt,
  parseClassification
} from './classify'
import {
  ANSWER_SYSTEM_PROMPT,
  COMPOSE_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  NAVIGATE_SYSTEM_PROMPT,
  answerPrompt,
  cleanEditOutput,
  cleanEditPartial,
  composeContent,
  editContent,
  navigateContent,
  parseNavStep,
  type PromptBlock
} from './prompts'

/** The subset of `codex exec` on which this engine's isolation depends. */
export const REQUIRED_CODEX_FLAGS = [
  '--config',
  '--json',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--model',
  '--output-schema',
  '--sandbox',
  '--skip-git-repo-check'
] as const

export interface CodexCliInspection {
  path: string | null
  version: string | null
  compatible: boolean
  loggedIn: boolean
  reason: string | null
}

interface InspectCommandResult {
  stdout: string
  stderr: string
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

type RunCommand = (
  file: string,
  args: string[],
  options: { timeout: number }
) => InspectCommandResult

const defaultRunCommand: RunCommand = (file, args, options) => {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: options.timeout,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    ...(result.error ? { error: result.error } : {})
  }
}

/**
 * Inspect, but never repair, the user's Codex installation.
 *
 * Authentication belongs to Codex. Mull reads the command's redacted status,
 * accepts only a ChatGPT login, and never opens or copies its token cache.
 */
export function inspectCodexCli(
  path: string | null,
  run: RunCommand = defaultRunCommand
): CodexCliInspection {
  if (!path) {
    return {
      path: null,
      version: null,
      compatible: false,
      loggedIn: false,
      reason: 'Codex CLI is not installed.'
    }
  }

  let version: string | null = null
  try {
    const versionResult = run(path, ['--version'], { timeout: 2_000 })
    assertCommandSucceeded(versionResult, 'Codex version check')
    version = versionResult.stdout.trim() || null
    const helpResult = run(path, ['exec', '--help'], { timeout: 2_000 })
    assertCommandSucceeded(helpResult, 'Codex capability check')
    const help = `${helpResult.stdout}\n${helpResult.stderr}`
    const missing = REQUIRED_CODEX_FLAGS.filter((flag) => !help.includes(flag))
    if (missing.length > 0) {
      return {
        path,
        version,
        compatible: false,
        loggedIn: false,
        reason: `Codex CLI is missing required options: ${missing.join(', ')}.`
      }
    }
  } catch (err) {
    return {
      path,
      version,
      compatible: false,
      loggedIn: false,
      reason: `Codex CLI could not be inspected: ${messageOf(err)}.`
    }
  }

  try {
    const statusResult = run(path, ['login', 'status'], { timeout: 3_000 })
    assertCommandSucceeded(statusResult, 'Codex login check')
    // Codex CLI versions may write the human-readable status to stderr even
    // on a successful exit, particularly when a startup warning precedes it.
    const status = `${statusResult.stdout}\n${statusResult.stderr}`
    const loggedIn = /logged in using chatgpt/i.test(status)
    return {
      path,
      version,
      compatible: true,
      loggedIn,
      reason: loggedIn
        ? null
        : /api key/i.test(status)
          ? 'Codex is using an API key; this lane requires a ChatGPT login.'
          : 'Codex is not signed in with ChatGPT.'
    }
  } catch {
    return {
      path,
      version,
      compatible: true,
      loggedIn: false,
      reason: 'Codex is not signed in with ChatGPT.'
    }
  }
}

function assertCommandSucceeded(result: InspectCommandResult, label: string): void {
  if (result.error) throw result.error
  if (result.status === 0) return
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  throw new Error(
    detail ||
      `${label} exited ${result.signal ? `after ${result.signal}` : `with code ${result.status}`}.`
  )
}

type SpawnCodex = typeof spawn

export interface CodexCliEngineOptions {
  codexPath: string
  model: string
  classifierModel: string
  spawn?: SpawnCodex
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

interface RunOptions {
  label: string
  model: string
  reasoningEffort?: 'low'
  systemPrompt: string
  content: string | PromptBlock[]
  outputSchema?: object
  onPartial?: (text: string) => void
  firstResponseMs?: number
}

type CodexFailureCategory =
  | 'cancelled'
  | 'event-error'
  | 'malformed-jsonl'
  | 'no-response'
  | 'nonzero-exit'
  | 'spawn-error'
  | 'stdin-error'
  | 'timeout'
  | 'tool-violation'

interface PreparedInput {
  text: string
  imageBase64: string | null
}

const FIRST_RESPONSE_MS = 60_000
const CLASSIFIER_RESPONSE_MS = 18_000
const STALL_MS = 25_000
const MAX_STDERR_CHARS = 8_000

/**
 * Codex through the user's installed CLI and ChatGPT subscription.
 *
 * This is intentionally not advertised as a tool-free model call. Codex is an
 * agent runtime and its public CLI has no hard `tools: []` switch. Mull reduces
 * the surface (empty workspace, read-only sandbox, no web, no user/project
 * configuration), tells it not to call tools, and aborts on any tool event.
 * That is a constrained experimental lane, not the stronger boundary the
 * Claude Agent SDK exposes for Mull's existing one-turn sessions.
 */
export class CodexCliEngine implements Engine {
  readonly name = 'codex'
  readonly model: string
  readonly classifierModel: string
  private readonly health: EngineHealth
  private readonly spawnCodex: SpawnCodex
  private readonly log: NonNullable<CodexCliEngineOptions['log']>
  private readonly now: () => number
  private readonly active = new Set<ChildProcessWithoutNullStreams>()
  private runCounter = 0
  private disposed = false

  constructor(private readonly options: CodexCliEngineOptions) {
    this.model = options.model
    this.classifierModel = options.classifierModel
    this.health = new EngineHealth({ now: options.now })
    this.spawnCodex = options.spawn ?? spawn
    this.log = options.log ?? ((): void => {})
    this.now = options.now ?? (() => Date.now())
  }

  async ready(): Promise<EngineState> {
    return this.health.current()
  }

  async classify(request: ClassifyRequest): Promise<ClassifiedIntent> {
    return this.call(async () => {
      const reply = await this.run({
        label: 'classify',
        model: this.classifierModel,
        reasoningEffort: 'low',
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        content: classifyPrompt(request),
        outputSchema: CLASSIFICATION_SCHEMA,
        firstResponseMs: CLASSIFIER_RESPONSE_MS
      })
      return parseClassification(reply)
    })
  }

  async transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    return this.call(async () => {
      const text = await this.run({
        label: 'edit',
        model: this.model,
        systemPrompt: EDIT_SYSTEM_PROMPT,
        content: editContent(request),
        onPartial: onPartial
          ? (partial) => onPartial(cleanEditPartial(partial))
          : undefined
      })
      return { text: cleanEditOutput(text) }
    })
  }

  async compose(
    request: ComposeRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    return this.call(async () => {
      const text = await this.run({
        label: 'compose',
        model: this.model,
        systemPrompt: COMPOSE_SYSTEM_PROMPT,
        content: composeContent(request),
        onPartial: onPartial
          ? (partial) => onPartial(cleanEditPartial(partial))
          : undefined
      })
      return { text: cleanEditOutput(text) }
    })
  }

  async navigate(request: NavigateRequest): Promise<NavStep> {
    return this.call(async () => {
      const reply = await this.run({
        label: 'navigate',
        model: this.model,
        systemPrompt: NAVIGATE_SYSTEM_PROMPT,
        content: navigateContent(request),
        outputSchema: NAVIGATION_SCHEMA
      })
      return parseNavStep(reply)
    })
  }

  async answer(
    request: AnswerRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    return this.call(async () => {
      const text = await this.run({
        label: 'answer',
        model: this.model,
        systemPrompt: ANSWER_SYSTEM_PROMPT,
        content: answerPrompt(request),
        onPartial: onPartial
          ? (partial) => onPartial(cleanEditPartial(partial))
          : undefined
      })
      return { text: cleanEditOutput(text) }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const child of this.active) child.kill('SIGTERM')
    this.active.clear()
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      const result = await work()
      this.health.recover()
      return result
    } catch (err) {
      this.health.degrade(err)
      throw err
    }
  }

  private async run(options: RunOptions): Promise<string> {
    if (this.disposed) throw new Error('The Codex engine has been closed.')

    const directory = mkdtempSync(join(tmpdir(), 'mull-codex-'))
    const workspace = join(directory, 'workspace')
    chmodSync(directory, 0o700)
    mkdirSync(workspace, { mode: 0o700 })
    try {
      const prepared = prepareInput(options.content)
      const args = [
        'exec',
        '--model',
        options.model,
        '--json',
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-C',
        workspace,
        '--config',
        'approval_policy="never"',
        '--config',
        'web_search="disabled"'
      ]

      if (options.reasoningEffort) {
        args.push('--config', `model_reasoning_effort="${options.reasoningEffort}"`)
      }

      if (options.outputSchema) {
        const schemaPath = join(directory, 'output-schema.json')
        writeFileSync(schemaPath, `${JSON.stringify(options.outputSchema)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        })
        args.push('--output-schema', schemaPath)
      }

      if (prepared.imageBase64) {
        const imagePath = join(directory, 'screen.jpg')
        writeFileSync(imagePath, Buffer.from(prepared.imageBase64, 'base64'), { mode: 0o600 })
        args.push('--image', imagePath)
      }

      // `-` is the prompt: screen contents stay on stdin rather than appearing
      // in argv/process listings.
      args.push('-')
      const prompt = codexPrompt(options.systemPrompt, prepared.text)
      return await this.spawnRun(args, prompt, options)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  private spawnRun(args: string[], prompt: string, options: RunOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const runId = `c${(this.runCounter += 1)}`
      const startedAt = this.now()
      const elapsed = (): number => this.now() - startedAt
      let failureLogged = false
      const logFailure = (category: CodexFailureCategory): void => {
        if (failureLogged) return
        failureLogged = true
        this.log('warn', 'codex.run.failed', {
          runId,
          lane: options.label,
          model: options.model,
          ms: elapsed(),
          category
        })
      }

      this.log('info', 'codex.run.start', {
        runId,
        lane: options.label,
        model: options.model,
        reasoning: options.reasoningEffort ?? 'default'
      })

      let child: ChildProcessWithoutNullStreams
      try {
        child = this.spawnCodex(this.options.codexPath, args, {
          env: subscriptionEnvironment(process.env),
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        logFailure('spawn-error')
        reject(err instanceof Error ? err : new Error(messageOf(err)))
        return
      }
      this.active.add(child)

      let settled = false
      let stdoutBuffer = ''
      let stderr = ''
      let response = ''
      let eventCount = 0
      let sawEvent = false
      let sawMessage = false
      let sawAssistantText = false
      let firstTimer: NodeJS.Timeout | null = null
      let stallTimer: NodeJS.Timeout | null = null

      const clearTimers = (): void => {
        if (firstTimer) clearTimeout(firstTimer)
        if (stallTimer) clearTimeout(stallTimer)
        firstTimer = null
        stallTimer = null
      }

      const fail = (error: Error, category: CodexFailureCategory): void => {
        if (settled) return
        settled = true
        clearTimers()
        logFailure(category)
        child.kill('SIGTERM')
        reject(error)
      }

      const armStall = (): void => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(
          () => fail(
            new Error(`Codex ${options.label} stopped responding for ${STALL_MS / 1000}s.`),
            'timeout'
          ),
          STALL_MS
        )
      }

      firstTimer = setTimeout(
        () => fail(
          new Error(`Codex ${options.label} said nothing for ${(options.firstResponseMs ?? FIRST_RESPONSE_MS) / 1000}s.`),
          'timeout'
        ),
        options.firstResponseMs ?? FIRST_RESPONSE_MS
      )

      const accept = (event: unknown): void => {
        eventCount += 1
        if (!sawEvent) {
          sawEvent = true
          this.log('info', 'codex.run.first-event', {
            runId,
            lane: options.label,
            ms: elapsed(),
            event: safeEventType(event)
          })
        }

        const policy = policyViolation(event)
        if (policy) {
          fail(
            new Error(`Codex attempted ${policy}; Mull stopped the constrained run.`),
            'tool-violation'
          )
          return
        }

        const eventError = errorFromEvent(event)
        if (eventError) {
          fail(codexError(eventError), 'event-error')
          return
        }

        const message = assistantMessage(event)
        if (message === null) return
        if (!sawAssistantText) {
          sawAssistantText = true
          this.log('info', 'codex.run.first-text', {
            runId,
            lane: options.label,
            ms: elapsed(),
            chars: message.length
          })
        }
        sawMessage = true
        if (firstTimer) clearTimeout(firstTimer)
        firstTimer = null
        armStall()

        const next = mergeMessage(response, message)
        if (next !== response) {
          response = next
          options.onPartial?.(response)
        }
      }

      const consume = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed || settled) return
        try {
          accept(JSON.parse(trimmed) as unknown)
        } catch (err) {
          fail(new Error(`Codex returned malformed JSONL: ${messageOf(err)}.`), 'malformed-jsonl')
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        let newline = stdoutBuffer.indexOf('\n')
        while (newline >= 0) {
          consume(stdoutBuffer.slice(0, newline))
          stdoutBuffer = stdoutBuffer.slice(newline + 1)
          newline = stdoutBuffer.indexOf('\n')
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS)
      })

      child.once('error', (err) => fail(err, 'spawn-error'))
      child.once('close', (code, signal) => {
        this.active.delete(child)
        if (stdoutBuffer.trim()) consume(stdoutBuffer)
        if (settled) return
        settled = true
        clearTimers()

        if (code !== 0) {
          logFailure(this.disposed ? 'cancelled' : 'nonzero-exit')
          reject(codexExitError(stderr, code, signal))
          return
        }
        if (!sawMessage) {
          logFailure('no-response')
          reject(new Error('Codex completed without an assistant response.'))
          return
        }
        this.log('info', 'codex.run.done', {
          runId,
          lane: options.label,
          model: options.model,
          ms: elapsed(),
          events: eventCount,
          chars: response.length
        })
        resolve(response)
      })

      child.stdin.on('error', (err) => fail(err, 'stdin-error'))
      child.stdin.end(prompt)
    })
  }
}

function prepareInput(content: string | PromptBlock[]): PreparedInput {
  if (typeof content === 'string') return { text: content, imageBase64: null }
  const text = content
    .filter((block): block is Extract<PromptBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
  const image = content.find(
    (block): block is Extract<PromptBlock, { type: 'image' }> => block.type === 'image'
  )
  return { text, imageBase64: image?.source.data ?? null }
}

function codexPrompt(systemPrompt: string, content: string): string {
  return `You are the text-generation backend inside Mull, a macOS writing tool.

Do not call tools, run commands, inspect files, browse, or modify the computer. Answer directly from the material below. The surrounding Codex runtime is transport only.

<mull-system-instructions>
${systemPrompt}
</mull-system-instructions>

<mull-input>
${content}
</mull-input>`
}

/** Keep Codex's auth-cache location, but never let API credentials select this lane. */
function subscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  delete env['OPENAI_API_KEY']
  delete env['OPENAI_BASE_URL']
  delete env['OPENAI_ORG_ID']
  delete env['OPENAI_PROJECT_ID']
  return env
}

function assistantMessage(event: unknown): string | null {
  if (!isRecord(event)) return null
  const item = isRecord(event['item']) ? event['item'] : event
  const type = typeof item['type'] === 'string' ? item['type'] : ''
  if (type !== 'agent_message' && type !== 'assistant_message') return null
  if (typeof item['text'] === 'string') return item['text']
  if (typeof item['message'] === 'string') return item['message']
  const content = item['content']
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .map((block) => typeof block['text'] === 'string' ? block['text'] : '')
    .join('')
}

function mergeMessage(current: string, incoming: string): string {
  if (!current || incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming) || current.endsWith(incoming)) return current
  return `${current}${incoming}`
}

function policyViolation(event: unknown): string | null {
  if (!isRecord(event)) return null
  const item = isRecord(event['item']) ? event['item'] : event
  const type = typeof item['type'] === 'string' ? item['type'] : ''
  if (/command|tool|file_change|web_search|computer|mcp/i.test(type)) return type
  return null
}

function errorFromEvent(event: unknown): string | null {
  if (!isRecord(event)) return null
  const type = typeof event['type'] === 'string' ? event['type'] : ''
  if (type !== 'error' && type !== 'turn.failed') return null
  const error = event['error']
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error['message'] === 'string') return error['message']
  if (typeof event['message'] === 'string') return event['message']
  return 'Codex reported an error.'
}

/** An event name is useful timing context; arbitrary event content is not. */
function safeEventType(event: unknown): string {
  if (!isRecord(event) || typeof event['type'] !== 'string') return 'unknown'
  const type = event['type'].replace(/[^a-z0-9._-]/giu, '').slice(0, 64)
  return type || 'unknown'
}

/**
 * Turn stderr into stable, user-actionable categories without retaining or
 * logging the CLI's raw diagnostic stream. Structured JSONL errors still take
 * their normal path above and can describe model availability precisely.
 */
function codexExitError(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null
): Error & { status?: number } {
  if (/401|403|not logged in|sign in|authentication|unauthorized/i.test(stderr)) {
    return codexError('Codex is not logged in. Run codex login.')
  }
  if (/429|rate.?limit|usage limit|quota/i.test(stderr)) {
    return codexError('Codex usage limit reached.')
  }
  if (/\b5\d\d\b|overloaded|service unavailable/i.test(stderr)) {
    return codexError('The Codex service is temporarily unavailable.')
  }
  return codexError(`Codex exited ${signal ? `after ${signal}` : `with code ${code}`}.`)
}

function codexError(message: string): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number }
  if (/401|403|not logged in|sign in|authentication|unauthorized/i.test(message)) error.status = 401
  else if (/429|rate.?limit|usage limit|quota/i.test(message)) error.status = 429
  else if (/\b5\d\d\b|overloaded|service unavailable/i.test(message)) error.status = 503
  return error
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.replace(/\s+/gu, ' ').trim() : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// The Responses structured-output dialect requires an object at the root and
// every property to be required. Irrelevant fields are null and are stripped
// by the existing Zod parsers after the CLI returns.
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { enum: ['dictate', 'edit', 'compose', 'ask', 'navigate'] },
    target: { anyOf: [{ enum: ['selection', 'document'] }, { type: 'null' }] },
    instruction: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    question: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    goal: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] }
  },
  required: ['intent', 'target', 'instruction', 'question', 'goal']
}

const NAVIGATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verb: { enum: ['press', 'type', 'navKey', 'read', 'done'] },
    index: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    text: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'null' }]
    },
    key: {
      anyOf: [
        {
          enum: [
            'escape',
            'tab',
            'backTab',
            'up',
            'down',
            'left',
            'right',
            'pageUp',
            'pageDown'
          ]
        },
        { type: 'null' }
      ]
    },
    found: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    because: { anyOf: [{ type: 'string' }, { type: 'null' }] }
  },
  required: ['verb', 'index', 'label', 'text', 'key', 'found', 'because']
}
