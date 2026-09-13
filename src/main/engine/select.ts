import { execFileSync } from 'node:child_process'
import type { EngineCredentials, EngineKind, EngineStatus } from '@shared/engine'
import type { Settings } from '@shared/settings'
import { AgentEngine } from './agent'
import { ApiKeyEngine } from './api-key'
import type {
  ClassifiedIntent,
  ClassifyRequest,
  Engine,
  EngineState,
  PlanRequest,
  PlanResult,
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

const MODELS: Record<Settings['editModel'], string> = {
  // Careful. The default: an edit is judgement about someone's writing, and
  // the diff card makes the judgement visible before it costs anything.
  sonnet: 'claude-sonnet-5',
  // Fast. The lane is latency-bound against a 1.2 s first-token budget, and on
  // ordinary tightening this is hard to tell apart.
  haiku: 'claude-haiku-4-5'
}

export interface ResolveEngineOptions {
  credentials: EngineCredentials
  settings: Pick<Settings, 'engine' | 'editModel'>
  /** Result of `detectClaudeCodeLogin()`, passed in so this stays pure. */
  detectedLogin: boolean
  log?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void
}

export function resolveEngine(options: ResolveEngineOptions): Engine {
  const { credentials, settings, detectedLogin, log } = options
  const model = MODELS[settings.editModel]
  const subscription = credentials.oauthToken !== null || detectedLogin

  const agent = (): Engine =>
    new AgentEngine({ oauthToken: credentials.oauthToken, model, log })
  const apiKey = (): Engine =>
    new ApiKeyEngine({ apiKey: credentials.apiKey as string, model })

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

  async plan(): Promise<PlanResult> {
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

  plan(request: PlanRequest): Promise<PlanResult> {
    return this.inner.plan(request)
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
