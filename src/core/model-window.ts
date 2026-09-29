/** A hook reports only this session's effective env, never nodeterm's global environment.
 * Decimal safe integers only: reject partial parses, exponents, infinities and zero. */
export function sessionContextWindow(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value)) return null
  const window = Number(value)
  return Number.isSafeInteger(window) && window > 0 ? window : null
}

// Legacy Claude model-family ESTIMATES only; session env takes precedence in both tails.
//
// Empirically (verified via `/context` on this machine) Claude Code runs opus/sonnet/fable
// sessions in a 1M window — the model id in the transcript stays bare ("claude-opus-4-8")
// even when 1M is active, so the window can NOT be detected from the id alone. We therefore
// map the model FAMILY to its window: opus/sonnet/fable/mythos → 1M, haiku → 200k, unknown
// → 200k. (Accounts with 1M access see the right denominator; the Models API is not consulted
// — it returns capability, and the call added latency for no gain.) These native-Claude guesses
// apply only when the current gateway catalogue has no matching window. Fully synchronous.

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

// Model family → window. First match wins; an explicit "1m" marker also forces the large
// window. Plain ids like "claude-opus-4-8" resolve to 1M via the opus/sonnet/fable rule.
const STATIC: Array<[RegExp, number]> = [
  [/haiku/i, DEFAULT_WINDOW],
  [/opus|sonnet|fable|mythos|(^|[^a-z0-9])1m([^a-z0-9]|$)/i, LARGE_WINDOW]
]

export type GatewayModelWindowSource = () => readonly {
  id: string
  contextWindow?: number
}[]

/** Live source for the current gateway scope. PtyManager registers its already scope-checked
 *  catalogue; keeping the source as a function makes a settings or credential change take effect
 *  on the next lookup without a second cache or duplicated scope logic. */
let gatewayModelWindowSource: GatewayModelWindowSource | null = null

export function setGatewayModelWindowSource(source: GatewayModelWindowSource | null): void {
  gatewayModelWindowSource = source
}

function gatewayModels(): ReturnType<GatewayModelWindowSource> {
  try {
    return gatewayModelWindowSource?.() ?? []
  } catch {
    return []
  }
}

function gatewayWindowFor(model: string | null): number | undefined {
  if (!model) return undefined
  const base = model.trim().replace(/\[1m\]$/, '')
  if (!base) return undefined
  const models = gatewayModels()
  // Exact ids first. Some transcripts omit the provider prefix, so allow a unique unprefixed
  // match too. Never borrow another provider's window or resolve an ambiguous alias by order.
  for (const entry of models) {
    const gid = entry.id.trim().replace(/\[1m\]$/, '')
    const win = entry.contextWindow
    if ((gid === base || entry.id === model) && validWindow(win)) return win
  }
  if (base.includes('/')) return undefined
  const matches = models.filter((entry) => entry.id.trim().replace(/\[1m\]$/, '').split('/').pop() === base)
  if (matches.length === 1 && validWindow(matches[0].contextWindow)) return matches[0].contextWindow
  return undefined
}

function validWindow(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** Context window for a model id: 1M for opus/sonnet/fable/[1m], 200k for haiku/unknown. */
export function staticWindowFor(model: string | null): number {
  if (model) {
    for (const [re, win] of STATIC) if (re.test(model)) return win
  }
  return DEFAULT_WINDOW
}

/**
 * A matching discovery record owns the window, even below native Claude's default or family
 * estimate. Provider aliases can use any name; a familiar family name or [1m] launch marker
 * must not overwrite the backend's reported limit. Keep the native fallback only without
 * discovered metadata. The autocompact environment also reads discovery directly.
 */
export function cachedWindowFor(model: string | null): number {
  return gatewayWindowFor(model) ?? staticWindowFor(model)
}

// ---------------------------------------------------------------------------------------------
// Gemini. Its transcript states no window, so the model id is the only signal — but gemini does
// not need a guess, because the CLI's own resolver is a FAMILY rule with a catch-all default.
// Mirrored from the shipped bundle rather than restated as a per-model table:
//   gemini-cli 0.54.4, bundle/chunk-BS6BSLZD.js:331674-331686
//     var DEFAULT_TOKEN_LIMIT = 1048576
//     var GEMMA_4_TOKEN_LIMIT = 256e3
//     function tokenLimit(model) { switch (model) {
//       case GEMMA_4_31B_IT_MODEL: case GEMMA_4_26B_A4B_IT_MODEL:  return GEMMA_4_TOKEN_LIMIT
//       case PREVIEW_GEMINI_MODEL: … case DEFAULT_GEMINI_FLASH_LITE_MODEL: return 1048576
//       default: return DEFAULT_TOKEN_LIMIT } }
// Because that `default:` is 1M, the five named 1M cases are redundant and copying them would only
// create something to go stale: an unknown or newly released gemini model gets the RIGHT answer
// from the default, which is exactly what a per-model allowlist would get wrong (silently, with a
// confident wrong denominator). So the two gemma models are the only special case here, as they
// are there. The transcript we measured names `gemini-3.5-flash`, which is in neither list and
// lands on the default — evidence the default branch is the one that carries the feature.
const GEMINI_DEFAULT_TOKEN_LIMIT = 1_048_576
const GEMINI_GEMMA_4_TOKEN_LIMIT = 256_000
// GEMMA_4_31B_IT_MODEL / GEMMA_4_26B_A4B_IT_MODEL (bundle/chunk-QXLHAGLO.js:279469-279470)
const GEMMA_4_MODELS = new Set(['gemma-4-31b-it', 'gemma-4-26b-a4b-it'])

/**
 * Context window for a gemini model id, per gemini's own `tokenLimit`. `null` only when there is no
 * model at all — a transcript that never named one tells us nothing, and the meter then stays
 * hidden rather than dividing by a number we invented.
 */
export function geminiWindowFor(model: string | null): number | null {
  if (!model) return null
  return GEMMA_4_MODELS.has(model) ? GEMINI_GEMMA_4_TOKEN_LIMIT : GEMINI_DEFAULT_TOKEN_LIMIT
}
