/**
 * Usage normalization/delta accounting, AGY_ERROR parsing, turn failure classification,
 * exponential backoff, and budget circuit breaking for agy-loop.
 */

export const EMPTY_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
  duration_seconds: 0,
  num_turns: 0,
});

function nonNegInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.trunc(n);
}

function nonNegFloat(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Number(n.toFixed(6));
}

/**
 * Normalizes a raw usage payload into a non-negative finite telemetry object.
 *
 * @param {object | null | undefined} rawUsage
 * @param {number} [durationSeconds]
 * @param {number} [numTurns]
 * @returns {{ input_tokens: number, output_tokens: number, thinking_tokens: number, cache_read_tokens: number, total_tokens: number, duration_seconds: number, num_turns: number }}
 */
export function normalizeUsage(
  rawUsage,
  durationSeconds = rawUsage?.duration_seconds ?? 0,
  numTurns = rawUsage?.num_turns ?? 0
) {
  const raw = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const input_tokens = nonNegInt(raw.input_tokens);
  const output_tokens = nonNegInt(raw.output_tokens);
  const thinking_tokens = nonNegInt(raw.thinking_tokens);
  const cache_read_tokens = nonNegInt(raw.cache_read_tokens);
  const total_tokens =
    raw.total_tokens != null
      ? nonNegInt(raw.total_tokens)
      : input_tokens + output_tokens + thinking_tokens + cache_read_tokens;

  return {
    input_tokens,
    output_tokens,
    thinking_tokens,
    cache_read_tokens,
    total_tokens,
    duration_seconds: nonNegFloat(durationSeconds),
    num_turns: nonNegInt(numTurns),
  };
}

/**
 * Computes per-turn usage delta from cumulative stream-json totals, clamping each field >= 0.
 *
 * @param {object | null | undefined} currentTotals
 * @param {object | null | undefined} prevTotals
 * @returns {{ delta: ReturnType<typeof normalizeUsage>, nextTotals: ReturnType<typeof normalizeUsage> }}
 */
export function computeUsageDelta(currentTotals, prevTotals) {
  const cur = normalizeUsage(currentTotals);
  const prev = normalizeUsage(prevTotals);

  const delta = {
    input_tokens: Math.max(0, cur.input_tokens - prev.input_tokens),
    output_tokens: Math.max(0, cur.output_tokens - prev.output_tokens),
    thinking_tokens: Math.max(0, cur.thinking_tokens - prev.thinking_tokens),
    cache_read_tokens: Math.max(0, cur.cache_read_tokens - prev.cache_read_tokens),
    total_tokens: Math.max(0, cur.total_tokens - prev.total_tokens),
    duration_seconds: nonNegFloat(Math.max(0, cur.duration_seconds - prev.duration_seconds)),
    num_turns: Math.max(0, cur.num_turns - prev.num_turns),
  };

  return { delta, nextTotals: cur };
}

/**
 * Returns a new usage totals object summing `accum` and `delta`.
 *
 * @param {object | null | undefined} accum
 * @param {object | null | undefined} delta
 * @returns {ReturnType<typeof normalizeUsage>}
 */
export function addUsageTotals(accum, delta) {
  const a = normalizeUsage(accum);
  const d = normalizeUsage(delta);

  return {
    input_tokens: a.input_tokens + d.input_tokens,
    output_tokens: a.output_tokens + d.output_tokens,
    thinking_tokens: a.thinking_tokens + d.thinking_tokens,
    cache_read_tokens: a.cache_read_tokens + d.cache_read_tokens,
    total_tokens: a.total_tokens + d.total_tokens,
    duration_seconds: nonNegFloat(a.duration_seconds + d.duration_seconds),
    num_turns: a.num_turns + d.num_turns,
  };
}

/**
 * Scans stderr lines for `AGY_ERROR: {...}` and returns the last valid JSON object, or null.
 *
 * @param {string} stderr
 * @returns {object | null}
 */
export function parseAgyError(stderr) {
  if (typeof stderr !== "string" || !stderr) {
    return null;
  }

  let lastParsed = null;
  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^AGY_ERROR:\s*(\{.*\})\s*$/);
    if (!match) {
      continue;
    }
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lastParsed = parsed;
      }
    } catch {
      // Ignore malformed AGY_ERROR line and keep scanning.
    }
  }
  return lastParsed;
}

function collectErrorText(agyError, rawStderr, resultError) {
  const parts = [];
  if (agyError && typeof agyError === "object") {
    for (const key of ["short_error", "reason", "error_code", "code_kind", "status", "error_id"]) {
      if (agyError[key] != null) {
        parts.push(String(agyError[key]));
      }
    }
  }
  if (typeof rawStderr === "string" && rawStderr.trim()) {
    parts.push(rawStderr);
  }
  if (typeof resultError === "string" && resultError.trim()) {
    parts.push(resultError);
  } else if (resultError && typeof resultError === "object") {
    try {
      parts.push(JSON.stringify(resultError));
    } catch {
      // Ignore circular/unserializable error objects.
    }
  }
  return parts.join("\n");
}

const HARD_QUOTA_RE =
  /weekly\s*(?:usage\s*)?limit|spend(?:ing)?\s*(?:cap|limit)|billing\s*(?:limit|exhausted|disabled|inactive)|(?:out\s*of|no)\s*credits|credits?\s*exhausted|subscription\s*(?:limit|expired|required)|hard\s*quota|monthly\s*(?:usage\s*)?limit/i;

const QUOTA_OR_RATE_LIMIT_RE =
  /resource_exhausted|\b429\b|quota|rate[\s_-]*limit|capacity|overloaded|too\s*many\s*requests|limit\s*(?:reached|exceeded)/i;

/**
 * Returns true for non-retryable quota errors (weekly limit, spend cap, billing exhausted,
 * or explicit `retryable === false` paired with quota/rate-limit wording).
 *
 * @param {object | null | undefined} agyError
 * @param {string} [rawStderr=""]
 * @param {string | object | null} [resultError=null]
 * @returns {boolean}
 */
export function isNonRetryableQuotaError(agyError, rawStderr = "", resultError = null) {
  const text = collectErrorText(agyError, rawStderr, resultError);
  if (!text) {
    return false;
  }
  if (HARD_QUOTA_RE.test(text)) {
    return true;
  }
  if (agyError && agyError.retryable === false) {
    const status429 = Number(agyError.status) === 429;
    return status429 || QUOTA_OR_RATE_LIMIT_RE.test(text);
  }
  return false;
}

/**
 * Returns true if the error indicates quota exhaustion, rate limiting, capacity, or overload.
 *
 * @param {object | null | undefined} agyError
 * @param {string} [rawStderr=""]
 * @param {string | object | null} [resultError=null]
 * @returns {boolean}
 */
export function isQuotaOrRateLimitError(agyError, rawStderr = "", resultError = null) {
  if (agyError && typeof agyError === "object") {
    if (Number(agyError.status) === 429) {
      return true;
    }
    if (String(agyError.error_code || "").toUpperCase() === "RESOURCE_EXHAUSTED") {
      return true;
    }
  }
  const text = collectErrorText(agyError, rawStderr, resultError);
  return Boolean(text && QUOTA_OR_RATE_LIMIT_RE.test(text));
}

/**
 * Computes jittered exponential backoff in integer seconds (>= 1).
 *
 * @param {number} attempt
 * @param {{ baseSec?: number, maxSec?: number, jitterRatio?: number, rng?: () => number }} [opts]
 * @returns {number}
 */
export function computeBackoffSec(
  attempt,
  { baseSec = 30, maxSec = 120, jitterRatio = 0.15, rng = Math.random } = {}
) {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const base = Math.min(maxSec, baseSec * 2 ** (safeAttempt - 1));
  const rawRand = Number(typeof rng === "function" ? rng() : 0.5);
  const clampedRand = Number.isFinite(rawRand) ? Math.min(1, Math.max(0, rawRand)) : 0.5;
  const factor = 1 + (clampedRand * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round(base * factor));
}

function summarizeFailureReason({
  exitCode,
  result,
  agyError,
  rawStderr,
  timedOut = false,
  isPrintTimeout = false,
}) {
  if (agyError?.short_error && String(agyError.short_error).trim()) {
    return String(agyError.short_error).trim();
  }
  if (agyError?.reason && String(agyError.reason).trim()) {
    return String(agyError.reason).trim();
  }
  if (typeof result?.error === "string" && result.error.trim()) {
    return result.error.trim();
  }
  if (result?.error?.message && String(result.error.message).trim()) {
    return String(result.error.message).trim();
  }
  if (timedOut && !isPrintTimeout) {
    return "turn timed out (outer watchdog)";
  }
  if (result?.finished_reason && String(result.finished_reason).trim()) {
    return String(result.finished_reason).trim();
  }
  if (typeof rawStderr === "string" && rawStderr.trim()) {
    const firstLine = rawStderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("AGY_ERROR:"));
    if (firstLine) {
      return firstLine.slice(0, 200);
    }
  }
  if (result?.status === "ERROR") {
    return "agy returned ERROR status";
  }
  return `agy exited with code ${exitCode}`;
}

/**
 * Classifies a failed turn and determines whether to fail fast, switch fallback model,
 * retry with backoff, or mark the loop blocked.
 *
 * @param {object} params
 * @returns {{ action: "fatal_config", exitCode: number, reason: string } | { action: "switch_fallback", nextModel: string, delaySec: number, reason: string } | { action: "retry", delaySec: number, reason: string } | { action: "blocked", reason: string }}
 */
export function classifyTurnFailure({
  exitCode,
  result = null,
  agyError = null,
  rawStderr = "",
  timedOut = false,
  activeModel = null,
  fallbackModel = null,
  alreadyOnFallback = false,
  attempt = 1,
  maxRetries = 3,
  rng = Math.random,
}) {
  const isPrintTimeout =
    result?.finished_reason === "print_timeout" ||
    agyError?.reason === "print_timeout" ||
    /print timeout/i.test(rawStderr);
  const reason = summarizeFailureReason({
    exitCode,
    result,
    agyError,
    rawStderr,
    timedOut: Boolean(timedOut),
    isPrintTimeout,
  });

  if (exitCode === 1 || exitCode === 2) {
    return { action: "fatal_config", exitCode, reason };
  }

  const resultError = result?.error ?? null;
  const quotaOrRate = isQuotaOrRateLimitError(agyError, rawStderr, resultError);

  if (
    quotaOrRate &&
    fallbackModel &&
    !alreadyOnFallback &&
    fallbackModel !== activeModel
  ) {
    return {
      action: "switch_fallback",
      nextModel: fallbackModel,
      delaySec: 5,
      reason,
    };
  }

  if (isNonRetryableQuotaError(agyError, rawStderr, resultError)) {
    return { action: "blocked", reason };
  }

  if (
    (isPrintTimeout || timedOut === true || agyError?.retryable === true || quotaOrRate) &&
    attempt <= maxRetries
  ) {
    return {
      action: "retry",
      delaySec: computeBackoffSec(attempt, { rng }),
      reason,
    };
  }

  return { action: "blocked", reason };
}

/**
 * Checks consecutive-error, iteration, duration, and token budgets.
 *
 * @param {object} params
 * @returns {{ exceeded: true, status: "circuit_broken" | "max_reached", exitReason: string, message: string } | { exceeded: false }}
 */
export function checkBudgets({
  iteration,
  maxIterations,
  elapsedSec,
  maxDurationSec = null,
  usageTotals = null,
  maxTokens = null,
  consecutiveErrors = 0,
  maxErrors = 3,
}) {
  if (consecutiveErrors >= maxErrors) {
    return {
      exceeded: true,
      status: "circuit_broken",
      exitReason: "consecutive_errors",
      message: `Circuit broken after ${consecutiveErrors} consecutive error(s) (limit ${maxErrors})`,
    };
  }

  if (iteration > maxIterations) {
    return {
      exceeded: true,
      status: "max_reached",
      exitReason: "max_iterations",
      message: `Reached max iterations (${maxIterations})`,
    };
  }

  if (maxDurationSec != null && elapsedSec >= maxDurationSec) {
    return {
      exceeded: true,
      status: "max_reached",
      exitReason: "max_duration",
      message: `Reached max duration (${maxDurationSec}s)`,
    };
  }

  const totalTokens = usageTotals?.total_tokens || 0;
  if (maxTokens != null && totalTokens >= maxTokens) {
    return {
      exceeded: true,
      status: "max_reached",
      exitReason: "max_tokens",
      message: `Reached max token budget (${totalTokens}/${maxTokens})`,
    };
  }

  return { exceeded: false };
}
