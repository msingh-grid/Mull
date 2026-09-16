import Anthropic from '@anthropic-ai/sdk'
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
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL,
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
  maxOutputTokens,
  navigateContent,
  parseNavStep
} from './prompts'

/**
 * ApiKeyEngine — the Messages API directly.
 *
 * The lower-latency of the two lanes, and the reason `docs/PLAN.md` asks for a
 * bench: the edit lane has a 1.2 s first-token budget, and if the subscription
 * path cannot meet it, this is what the default flips to. It is also the right
 * shape for a BYOK tier later (docs/04).
 *
 * The system prompt is sent as a cached block. It never varies, so from the
 * second edit onward the model is re-reading it from cache rather than from
 * the wire — worth doing precisely because first-token time is the budget.
 */

export interface ApiKeyEngineOptions {
  apiKey: string
  model: string
  /**
   * The routing model, already resolved from `settings` by `resolveEngine`.
   * Optional so a test can build an engine from a key alone and still get the
   * documented default. There is no `agentModel` here: this lane has no tool
   * loop, so `runAgent` is not implemented on it at all.
   */
  classifierModel?: string
  /** Injected in tests; anything shaped like the SDK client will do. */
  client?: Pick<Anthropic['messages'], 'stream' | 'create'>
  now?: () => number
}

export class ApiKeyEngine implements Engine {
  readonly name = 'api-key'
  readonly model: string
  /** Public for the same reason as on `AgentEngine`: so a log can say it. */
  readonly classifierModel: string
  private readonly messages: Pick<Anthropic['messages'], 'stream' | 'create'>
  private readonly health: EngineHealth

  constructor(options: ApiKeyEngineOptions) {
    this.model = options.model
    this.classifierModel = options.classifierModel ?? CLASSIFIER_MODEL
    this.messages =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        // Main is a node process, not a browser; this only silences the SDK's
        // "are you sure you want to expose a key" guard for bundled code.
        dangerouslyAllowBrowser: false
      }).messages
    this.health = new EngineHealth({ now: options.now })
  }

  async ready(): Promise<EngineState> {
    return this.health.current()
  }

  /**
   * Not streamed, and not on `this.model`: the answer is a few tokens of JSON
   * and the only thing that matters is how fast the whole thing comes back.
   */
  async classify(request: ClassifyRequest): Promise<ClassifiedIntent> {
    try {
      const message = await this.messages.create({
        model: this.classifierModel,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        system: [
          { type: 'text', text: CLASSIFIER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: classifyPrompt(request) }]
      })
      this.health.recover()
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return parseClassification(text)
    } catch (err) {
      this.health.degrade(err)
      throw err
    }
  }

  async transform(
    request: TransformRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const stream = this.messages.stream({
        model: this.model,
        max_tokens: maxOutputTokens(request.text),
        system: [
          { type: 'text', text: EDIT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: editContent(request) as Anthropic.MessageParam['content'] }]
      })

      if (onPartial) {
        stream.on('text', (_delta, snapshot) => onPartial(cleanEditPartial(snapshot)))
      }

      const message = await stream.finalMessage()
      this.health.recover()

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      return { text: cleanEditOutput(text) }
    } catch (err) {
      // Classified and remembered, so the *next* edit knows without asking —
      // then rethrown, because this one still failed and the lane has to say so.
      this.health.degrade(err)
      throw err
    }
  }

  async compose(
    request: ComposeRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const stream = this.messages.stream({
        model: this.model,
        // A reply is short. Capping it here is not only thrift — it is a hint,
        // and the prompt asks for the length a person would actually type.
        max_tokens: 1_024,
        system: [
          { type: 'text', text: COMPOSE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          { role: 'user', content: composeContent(request) as Anthropic.MessageParam['content'] }
        ]
      })

      if (onPartial) {
        stream.on('text', (_delta, snapshot) => onPartial(cleanEditPartial(snapshot)))
      }

      const message = await stream.finalMessage()
      this.health.recover()

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      throw err
    }
  }

  /**
   * One navigation step.
   *
   * Not streamed, unlike every other lane here: the answer is a single line of
   * JSON and there is nothing to fill in progressively. The card shows the step
   * once it is decided, and a half-parsed action is not a thing to show anyone.
   */
  async navigate(request: NavigateRequest): Promise<NavStep> {
    try {
      const message = await this.messages.create({
        model: this.model,
        max_tokens: 256,
        system: [
          { type: 'text', text: NAVIGATE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [
          { role: 'user', content: navigateContent(request) as Anthropic.MessageParam['content'] }
        ]
      })
      this.health.recover()
      const reply = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')
      return parseNavStep(reply)
    } catch (err) {
      this.health.degrade(err)
      throw err
    }
  }

  /**
   * What the window said, once the navigator has arrived.
   *
   * Streamed, unlike `navigate` and like everything else that produces prose:
   * the card is already open and the user is watching it, so the sentences
   * arriving one at a time is the difference between working and hung.
   */
  async answer(
    request: AnswerRequest,
    onPartial?: (text: string) => void
  ): Promise<TransformResult> {
    try {
      const stream = this.messages.stream({
        model: this.model,
        // Read in a small panel, so the cap is also the brief — the prompt asks
        // for a few sentences and this is what that costs.
        max_tokens: 1_024,
        system: [
          { type: 'text', text: ANSWER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: answerPrompt(request) }]
      })

      if (onPartial) {
        stream.on('text', (_delta, snapshot) => onPartial(cleanEditPartial(snapshot)))
      }

      const message = await stream.finalMessage()
      this.health.recover()

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      return { text: cleanEditOutput(text) }
    } catch (err) {
      this.health.degrade(err)
      throw err
    }
  }
}
