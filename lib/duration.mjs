/**
 * Pure duration parsing and formatting utilities for agy-loop.
 * Zero external dependencies; matches loop-helper.sh interval grammar.
 */

const UNIT_MAP = new Map([
  ["s", "s"],
  ["sec", "s"],
  ["secs", "s"],
  ["second", "s"],
  ["seconds", "s"],
  ["m", "m"],
  ["min", "m"],
  ["mins", "m"],
  ["minute", "m"],
  ["minutes", "m"],
  ["h", "h"],
  ["hr", "h"],
  ["hrs", "h"],
  ["hour", "h"],
  ["hours", "h"],
  ["d", "d"],
  ["day", "d"],
  ["days", "d"],
]);

const UNIT_SECONDS = Object.freeze({
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
});

function stripTrailingComma(token) {
  if (token.length > 1 && token.endsWith(",")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Normalizes an interval unit word to "s", "m", "h", or "d", or null if invalid.
 * Accepts singular/plural forms, case-insensitive, stripping a trailing comma.
 *
 * @param {string} w
 * @returns {"s" | "m" | "h" | "d" | null}
 */
export function isUnitWord(w) {
  if (typeof w !== "string") {
    return null;
  }
  const cleaned = stripTrailingComma(w.trim()).toLowerCase();
  if (!cleaned) {
    return null;
  }
  return UNIT_MAP.get(cleaned) ?? null;
}

/**
 * Parses a single or compound compact duration token (e.g. "30s", "1h30m", "2m30s", "1d12h").
 * Strips a trailing comma. Throws Error on explicit zero segments, duplicate units,
 * or fractional values; returns null if the token is not a duration.
 *
 * @param {string} w
 * @returns {{ seconds: number, label: string } | null}
 */
export function tryParseCompactDuration(w) {
  if (typeof w !== "string") {
    return null;
  }
  const trimmed = w.trim();
  if (!trimmed) {
    return null;
  }
  const cw = stripTrailingComma(trimmed);
  if (cw.length < 2) {
    return null;
  }

  // Detect fractional durations such as "1.5m", ".5h", or "1h1.5m" so we can give
  // an actionable error instead of silently falling back to literal text.
  if (cw.includes(".")) {
    const fracSegs = cw.match(/(?:\d*\.\d+|\d+)[A-Za-z]+/g);
    if (fracSegs && fracSegs.join("") === cw) {
      const allValidUnits = fracSegs.every((seg) => {
        const unitMatch = seg.match(/[A-Za-z]+$/);
        return unitMatch !== null && isUnitWord(unitMatch[0]) !== null;
      });
      if (allValidUnits) {
        throw new Error(
          `Invalid duration: ${cw} (fractional durations are not supported; use integer units like 90s or 1m30s)`
        );
      }
    }
    return null;
  }

  const segs = cw.match(/\d+[A-Za-z]+/g);
  if (!segs || segs.join("") !== cw) {
    return null;
  }

  const parsedSegs = [];
  for (const seg of segs) {
    const match = seg.match(/^(\d+)([A-Za-z]+)$/);
    if (!match) {
      return null;
    }
    const unit = isUnitWord(match[2]);
    if (!unit) {
      return null;
    }
    parsedSegs.push({ digits: match[1], unit });
  }

  const seenUnits = new Set();
  let totalSeconds = 0;
  let label = "";

  for (const { digits, unit } of parsedSegs) {
    if (seenUnits.has(unit)) {
      throw new Error(`Invalid duration: ${cw} (duplicate unit '${unit}')`);
    }
    seenUnits.add(unit);

    if (/^0+$/.test(digits)) {
      throw new Error(`Invalid duration: ${cw} (duration must be >= 1)`);
    }

    const num = Number.parseInt(digits, 10);
    const addSec = num * UNIT_SECONDS[unit];
    if (!Number.isSafeInteger(totalSeconds + addSec)) {
      throw new Error(`Invalid duration: ${cw} (duration overflows safe integer range)`);
    }
    totalSeconds += addSec;
    label += `${num}${unit}`;
  }

  return { seconds: totalSeconds, label };
}

/**
 * Parses a split two-token duration such as ("5", "minutes") or ("2", "hours,").
 * Throws Error on 0 or fractional values; returns null if not a split duration.
 *
 * @param {string} numStr
 * @param {string} unitStr
 * @returns {{ seconds: number, label: string } | null}
 */
export function tryParseSplitDuration(numStr, unitStr) {
  if (typeof numStr !== "string" || typeof unitStr !== "string") {
    return null;
  }
  const numClean = numStr.trim();
  const unitClean = stripTrailingComma(unitStr.trim());
  const unit = isUnitWord(unitClean);
  if (!unit || !numClean) {
    return null;
  }

  if (/^\d*\.\d+$/.test(numClean)) {
    throw new Error(
      `Invalid duration: ${numClean} ${unitClean} (fractional durations are not supported; use integer units like 90s or 1m30s)`
    );
  }

  if (!/^\d+$/.test(numClean)) {
    return null;
  }

  if (/^0+$/.test(numClean)) {
    throw new Error(`Invalid duration: ${numClean} ${unitClean} (duration must be >= 1)`);
  }

  const num = Number.parseInt(numClean, 10);
  const seconds = num * UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(seconds)) {
    throw new Error(
      `Invalid duration: ${numClean} ${unitClean} (duration overflows safe integer range)`
    );
  }
  return { seconds, label: `${num}${unit}` };
}

/**
 * Strictly parses a duration string for CLI option values, throwing a descriptive
 * Error naming `labelName` if invalid.
 *
 * @param {string} str
 * @param {string} [labelName="duration"]
 * @returns {{ seconds: number, label: string }}
 */
export function parseDurationStrict(str, labelName = "duration") {
  if (typeof str !== "string" || !str.trim()) {
    throw new Error(
      `Invalid ${labelName}: expected an integer duration like 30s, 5m, or 1h30m`
    );
  }
  const trimmed = str.trim();
  if (trimmed.endsWith(",")) {
    throw new Error(
      `Invalid ${labelName}: '${trimmed}' (expected an integer duration like 30s, 5m, or 1h30m)`
    );
  }

  const parts = trimmed.split(/\s+/);
  try {
    if (parts.length === 1) {
      const parsed = tryParseCompactDuration(parts[0]);
      if (parsed) {
        return parsed;
      }
    } else if (parts.length === 2) {
      const parsed = tryParseSplitDuration(parts[0], parts[1]);
      if (parsed) {
        return parsed;
      }
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^Invalid duration:\s*/i, "") : String(err);
    throw new Error(`Invalid ${labelName}: ${detail}`);
  }

  throw new Error(
    `Invalid ${labelName}: '${trimmed}' (expected an integer duration like 30s, 5m, or 1h30m)`
  );
}

/**
 * Formats a duration in seconds as a compact string (e.g. "0s", "45s", "2m", "1h30m", "1d2h").
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  const num = Number(sec);
  if (!Number.isFinite(num) || num <= 0) {
    return "0s";
  }
  let rem = Math.round(num);
  if (rem <= 0) {
    return "0s";
  }

  const d = Math.floor(rem / 86400);
  rem %= 86400;
  const h = Math.floor(rem / 3600);
  rem %= 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;

  let out = "";
  if (d > 0) out += `${d}d`;
  if (h > 0) out += `${h}h`;
  if (m > 0) out += `${m}m`;
  if (s > 0) out += `${s}s`;
  return out || "0s";
}

/**
 * Formats seconds as a Go duration string for `agy --print-timeout`.
 *
 * @param {number} sec
 * @returns {string}
 */
export function toGoDuration(sec) {
  const num = Number(sec);
  if (!Number.isFinite(num) || num <= 0) {
    return "0s";
  }
  return `${Math.max(0, Math.round(num))}s`;
}

/**
 * Formats a token count compactly (e.g. "0", "850", "12.4k", "1.2M").
 *
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) {
    return "0";
  }
  const rounded = Math.round(num);
  if (rounded < 1000) {
    return String(rounded);
  }
  if (rounded < 999950) {
    return `${(rounded / 1000).toFixed(1)}k`;
  }
  return `${(rounded / 1_000_000).toFixed(1)}M`;
}
