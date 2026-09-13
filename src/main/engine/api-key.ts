import Anthropic from '@anthropic-ai/sdk'
import type {
  ClassifiedIntent,
  ClassifyRequest,
  ComposeRequest,
  Engine,
  EngineState,
  PlanRequest,
  PlanResult,
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
  COMPOSE_SYSTEM_PROMPT,
  EDIT_SYSTEM_PROMPT,
  cleanEditOutput,
  cleanEditPartial,
  composeContent,
  editContent,
  maxOutputTokens
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
  /** Injected in tests; anything shaped like the SDK client will do. */
  client?: Pick<Anthropic['messages'], 'stream' | 'create'>
  now?: () => number
}

export class ApiKeyEngine implements Engine {
  readonly name = 'api-key'
  readonly model: string
  private readonly messages: Pick<Anthropic['messages'], 'stream' | 'create'>
  private readonly health: EngineHealth

  constructor(options: ApiKeyEngineOptions) {
    this.model = options.model
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
        model: CLASSIFIER_MODEL,
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

  async plan(_request: PlanRequest): Promise<PlanResult> {
    // Commands are M5. An empty plan would render as a card proposing nothing,
    // which is worse than an error nobody currently triggers.
    throw new Error('Mull can’t plan commands yet.')
  }
}
