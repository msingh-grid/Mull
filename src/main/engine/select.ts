import { execFileSync } from 'node:child_process'
import type { EngineCredentials, EngineKind, EngineStatus } from '@shared/engine'
import { MODEL_IDS, type Settings } from '@shared/settings'
import { AgentEngine } from './agent'
import { ApiKeyEngine } from './api-key'
import type { AgentGoal, AgentRunResult } from './agent-loop'
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

/**
 * Which engine serves edits, and what to tell the user when none can.
 *
 * `auto` prefers the subscription. That is the opposite of preferring the
 * fastest lane, and it is deliberate: docs/05-electron-architecture.md sets
 * out to build something that needs no API key, and someone who has pasted
 * both has told us they have a subscription. The API key is the escape hatch
 * they can select explicitly — and `npm run bench:engine` is how they find out
 * whether it is worth selecting.
 */

/**
 * Three jobs, three choices, one table of ids.
 *
 * `editModel` is careful-or-fast: an edit is judgement about someone's writing
 * and the diff card makes that judgement cheap to check, so it defaults
 * careful; the lane is latency-bound against a 1.2 s first-token budget, so
 * fast is a real option. The other two choose from `MODEL_IDS` directly and
 * are documented where they are declared, in `@shared/settings`.
 *
 * All three resolve here, at the one place that already has both the settings
 * and the engine constructors — so `classify.ts` and `@shared/agent` keep
 * their constants as defaults and neither has to learn what a setting is.
 */
const MODELS: Record<Settings['editModel'], string> = {
  sonnet: MODEL_IDS.sonnet,
  haiku: MODEL_IDS.haiku
}

export interface ResolveEngineOptions {
  credentials: EngineCredentials
  settings: Pick<Settings, 'engine' | 'editModel' | 'classifierModel' | 'agentModel'>
  /** Result of `detectClaudeCodeLogin()`, passed in so this stays pure. */
  detectedLogin: boolean
  /**
   * May the writing lanes think? Read per turn rather than captured, so arming
   * it on the HUD takes effect on the next utterance instead of the next
   * relaunch. Only the subscription lane has a knob for it.
   */
  thinking?: () => boolean
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export function resolveEngine(options: ResolveEngineOptions): Engine {
  const { credentials, settings, detectedLogin, log, thinking } = options
  const model = MODELS[settings.editModel]
  // Resolved here and passed in, rather than read from settings inside the
  // engines: an engine that reaches for a store is an engine that cannot be
  // built in a test without one.
  const classifierModel = MODEL_IDS[settings.classifierModel]
  const agentModel = MODEL_IDS[settings.agentModel]
  const subscription = credentials.oauthToken !== null || detectedLogin

  const agent = (): Engine =>
    new AgentEngine({
      oauthToken: credentials.oauthToken,
      model,
      classifierModel,
      agentModel,
      log,
      thinking
    })
  const apiKey = (): Engine =>
    new ApiKeyEngine({ apiKey: credentials.apiKey as string, model, classifierModel })

  switch (settings.engine) {
    case 'subscription':
      return subscription
        ? agent()
        : new SignedOutEngine('Mull is set to use your Claude subscription, but no token is saved.')
    case 'api-key':
      return credentials.apiKey
        ? apiKey()
        : new SignedOutEngine('Mull is set to use an API key, but none is saved.')
    default:
      if (subscription) return agent()
      if (credentials.apiKey) return apiKey()
      return new SignedOutEngine()
  }
}

/**
 * Is this Mac already signed in to Claude Code?
 *
 * If so the subscription lane works with nothing pasted, which is the single
 * best thing the settings pane can tell someone. The check reads the keychain
 * *item*, never its value — `security` prints attributes without `-w`, and the
 * secret stays where it belongs.
 */
export function detectClaudeCodeLogin(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: 'ignore',
      timeout: 2_000
    })
    return true
  } catch {
    return false
  }
}

/**
 * May Mull use the Claude Code login on this Mac?
 *
 * Two questions, and both have to be yes: whether the Mac has one, and whether
 * the user wants Mull reaching for it. The second is what "Sign out" means for
 * a credential Mull does not own — the keychain item belongs to Claude Code,
 * and one app deleting another's login because someone clicked its button
 * would be indefensible. So Mull stops using it and leaves it alone.
 *
 * Kept apart from `resolveEngine` so the settings pane can still be told a
 * login *exists* while the engine is told not to use it — that is the
 * difference between offering it back and pretending it is gone.
 */
export function inheritedLogin(
  detected: boolean,
  settings: Pick<Settings, 'inheritClaudeCodeLogin'>
): boolean {
  return detected && settings.inheritClaudeCodeLogin !== false
}

/** The engine that cannot edit, and says which thing is missing. */
export class SignedOutEngine implements Engine {
  readonly name = 'signed-out'
  readonly model = null

  constructor(private readonly reason?: string) {}

  async ready(): Promise<EngineState> {
    return { kind: 'signed-out' }
  }

  async classify(): Promise<ClassifiedIntent> {
    throw new Error(this.reason ?? 'No engine is connected.')
  }

  async transform(): Promise<TransformResult> {
    throw new Error(this.reason ?? 'No engine is connected.')
  }

  async compose(): Promise<TransformResult> {
    throw new Error(this.reason ?? 'No engine is connected.')
  }


  async navigate(): Promise<NavStep> {
    throw new Error(this.reason ?? 'No engine is connected.')
  }

  async answer(): Promise<TransformResult> {
    throw new Error(this.reason ?? 'No engine is connected.')
  }
}

/**
 * A stable `Engine` whose implementation can be replaced underneath it.
 *
 * Signing in, signing out and switching models all change which engine should
 * serve the next edit. Handing the lane a holder instead of an engine means
 * none of that has to reach into `SculptLane` — or wait for a relaunch, which
 * is what a user who has just pasted a token would otherwise be told to do.
 */
export class EngineHolder implements Engine {
  private inner: Engine

  constructor(inner: Engine) {
    this.inner = inner
  }

  get name(): string {
    return this.inner.name
  }

  get model(): string | null {
    return this.inner.model
  }

  /** The old engine is disposed; a warm subprocess should not outlive it. */
  swap(next: Engine): void {
    const previous = this.inner
    this.inner = next
    void previous.dispose?.()
  }

  get current(): Engine {
    return this.inner
  }

  ready(): Promise<EngineState> {
    return this.inner.ready()
  }

  classify(request: ClassifyRequest): Promise<ClassifiedIntent> {
    return this.inner.classify(request)
  }

  transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    return this.inner.transform(request, onPartial)
  }

  compose(request: ComposeRequest, onPartial?: (text: string) => void): Promise<TransformResult> {
    return this.inner.compose(request, onPartial)
  }

  navigate(request: NavigateRequest): Promise<NavStep> {
    return this.inner.navigate(request)
  }

  answer(request: AnswerRequest, onPartial?: (text: string) => void): Promise<TransformResult> {
    return this.inner.answer(request, onPartial)
  }

  /**
   * Can the engine behind this holder run a tool loop?
   *
   * Asked per utterance rather than once at boot, because `swap` replaces the
   * engine under everything — signing in, signing out, or changing the model
   * mid-session all go through it, and a lane chosen at startup would be
   * answering for an engine that is no longer there.
   */
  get canRunAgent(): boolean {
    return typeof this.inner.runAgent === 'function'
  }

  runAgent(request: AgentGoal): Promise<AgentRunResult> {
    const run = this.inner.runAgent
    if (!run) throw new Error('this engine cannot run an agent loop')
    return run.call(this.inner, request)
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.()
  }
}

/** One object for the settings pane: who is serving, and how it is doing. */
export async function engineStatus(
  engine: Engine,
  presence: { hasSubscription: boolean; hasApiKey: boolean },
  detectedLogin: boolean
): Promise<EngineStatus> {
  const state = await engine.ready()
  return {
    kind: engine.name as EngineKind,
    state: state.kind,
    reason: state.kind === 'local-only' ? state.reason : null,
    model: engine.model,
    hasSubscription: presence.hasSubscription,
    hasApiKey: presence.hasApiKey,
    detectedLogin
  }
}
