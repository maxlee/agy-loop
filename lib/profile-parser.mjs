/**
 * Zero-dependency multi-profile discovery, strict YAML frontmatter v2 parser,
 * sidecar grant validator, and CLI/frontmatter merge helpers for agy-loop.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDurationStrict } from "./duration.mjs";

export const VALID_PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const LOOP_MD_MAX_BYTES = 25000;

export const BUILTIN_MAINTENANCE_PROMPT =
  "Execute one non-blocking branch maintenance pass: (1) check git status and run fast incremental tests or build checks for any modified/unfinished work; (2) if gh CLI is available and an open PR exists for the current branch, inspect PR check runs and unresolved review comments, applying minimal verified fixes if straightforward; (3) if everything is clean and green, report in one concise line and recommend an idle backoff.";

const VALID_ENGINES = new Set(["auto", "schedule", "workflow"]);
const VALID_STATE_MODES = new Set(["fresh", "stateful"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_MODES = new Set(["auto", "accept-edits", "plan"]);
const VALID_SINGLETONS = new Set(["profile", "workspace", "none"]);
const ALLOWED_GRANT_TYPES = new Set([
  "command",
  "read_file",
  "write_file",
  "mcp",
  "read_url",
  "execute_url",
]);

const MONTH_NAMES = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

const DOW_NAMES = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

const ALLOWED_FRONTMATTER_KEYS = Object.freeze([
  "name",
  "description",
  "engine",
  "interval",
  "cron",
  "timezone",
  "once",
  "max_iterations",
  "state_mode",
  "reset_every",
  "worker_model",
  "model",
  "effort",
  "fallback_model",
  "verify",
  "verifier_model",
  "verify_cmd",
  "verify_timeout",
  "probe_cmd",
  "probe_timeout",
  "probe_until_pass",
  "mode",
  "sandbox",
  "worktree",
  "keep_worktree",
  "fail_on_denied",
  "budget_tokens",
  "max_tokens",
  "max_duration",
  "max_retries",
  "max_errors",
  "turn_timeout",
  "targets",
  "singleton",
  "access_grants",
]);

const KEY_SYNONYM_HINTS = Object.freeze({
  tz: "timezone",
  max_iter: "max_iterations",
  max_iters: "max_iterations",
  max: "max_iterations",
  probe: "probe_cmd",
  verify_command: "verify_cmd",
  timeout: "turn_timeout",
  grants: "access_grants",
  permissions: "access_grants",
  work_tree: "worktree",
  keep_work_tree: "keep_worktree",
});

function resolveHomeLocal() {
  const fromEnv = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
  return fromEnv || os.homedir();
}

/**
 * Truncate a UTF-8 Buffer to at most `maxBytes` without splitting a multi-byte character.
 *
 * @param {Buffer} buf
 * @param {number} [maxBytes=25000]
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateUtf8Bytes(buf, maxBytes = LOOP_MD_MAX_BYTES) {
  const safeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ""), "utf8");
  if (safeBuf.length <= maxBytes) {
    return { text: safeBuf.toString("utf8"), truncated: false };
  }
  let end = maxBytes;
  if (end > 0 && safeBuf[end - 1] >= 0x80) {
    let cont = 0;
    while (cont < 3 && end - 1 - cont >= 0) {
      const b = safeBuf[end - 1 - cont];
      if (b >= 0x80 && b < 0xc0) {
        cont += 1;
      } else {
        break;
      }
    }
    const leadIdx = end - 1 - cont;
    if (leadIdx < 0) {
      end = 0;
    } else {
      const lb = safeBuf[leadIdx];
      let seqLen = 99;
      if (lb >= 0xf0 && lb <= 0xf7) seqLen = 4;
      else if (lb >= 0xe0) seqLen = 3;
      else if (lb >= 0xc0) seqLen = 2;
      if (cont + 1 < seqLen) {
        end = leadIdx;
      }
    }
  }
  return { text: safeBuf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Validate profile name against VALID_PROFILE_NAME_RE (blocks traversal, '..', slashes, whitespace).
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function validateProfileName(name) {
  return (
    typeof name === "string" &&
    VALID_PROFILE_NAME_RE.test(name) &&
    !name.includes("..")
  );
}

/**
 * Validate sidecar `access_grants`, rejecting wildcards (`(*)`, `/*`, `*:*`, root `/`, drive roots, and newlines)
 * and unknown prefixes.
 *
 * @param {unknown} grants
 * @returns {string[]}
 */
export function validateSidecarGrants(grants) {
  if (grants === undefined || grants === null) {
    return [];
  }
  if (!Array.isArray(grants)) {
    throw new Error("Invalid access_grants: expected an array of grant strings");
  }

  const normalized = [];
  for (let i = 0; i < grants.length; i += 1) {
    const raw = grants[i];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(`Invalid sidecar access grant at index ${i}: expected a non-empty string`);
    }
    if (/[\r\n\0]/.test(raw)) {
      throw new Error(
        `Invalid sidecar access grant at index ${i}: newline or NUL characters are not permitted`
      );
    }
    const trimmed = raw.trim();
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
    if (!match) {
      throw new Error(
        `Invalid sidecar access grant '${trimmed}': expected prefix(<scope>) with one of command, read_file, write_file, mcp, read_url, execute_url`
      );
    }

    const prefix = match[1];
    const inner = match[2].trim();

    if (!ALLOWED_GRANT_TYPES.has(prefix)) {
      if (prefix === "allow" || /^\*+$/.test(inner)) {
        throw new Error(
          `Rejected disallowed wildcard/prefix sidecar grant '${trimmed}': '${prefix}' is not permitted`
        );
      }
      throw new Error(
        `Invalid sidecar access grant prefix '${prefix}' in '${trimmed}': allowed prefixes are command(...), read_file(...), write_file(...), mcp(...), read_url(...), execute_url(...)`
      );
    }

    if (!inner) {
      throw new Error(`Invalid sidecar access grant '${trimmed}': grant scope cannot be empty`);
    }

    const isPosixRoot =
      inner.startsWith("/") && path.posix.normalize(inner.replace(/\/+/g, "/")) === "/";
    const isWinDriveRoot =
      /^[A-Za-z]:/.test(inner) &&
      /^[A-Za-z]:[\\/]?$/.test(path.win32.normalize(inner));

    if (
      /^\*+(?:\.\*)?$/.test(inner) ||
      /^\*+[:/\\]/.test(inner) ||
      /^\*(?:\s|$)/.test(inner) ||
      inner.includes("(*)") ||
      inner.includes("/*") ||
      inner.includes("\\*") ||
      isPosixRoot ||
      inner === "\\" ||
      isWinDriveRoot
    ) {
      throw new Error(
        `Rejected wildcard/root sidecar access grant '${trimmed}': wildcard grants like (*), /*, *:* or root '/' are strictly forbidden`
      );
    }

    normalized.push(`${prefix}(${inner})`);
  }

  return normalized;
}

function parseCronToken(token, min, max, namesMap) {
  const m = token.match(/^([^/]+)(?:\/(\d+))?$/);
  if (!m) {
    return false;
  }
  const base = m[1];
  const stepStr = m[2];
  if (stepStr !== undefined) {
    if (!/^[1-9]\d*$/.test(stepStr)) {
      return false;
    }
  }

  const parseAtom = (rawAtom) => {
    const lower = rawAtom.toLowerCase();
    if (namesMap && namesMap.has(lower)) {
      return namesMap.get(lower);
    }
    if (!/^\d+$/.test(rawAtom)) {
      return null;
    }
    const num = Number.parseInt(rawAtom, 10);
    if (num < min || num > max) {
      return null;
    }
    return num;
  };

  if (base === "*") {
    return true;
  }

  const rangeParts = base.split("-");
  if (rangeParts.length === 1) {
    return parseAtom(rangeParts[0]) !== null;
  }
  if (rangeParts.length === 2) {
    const start = parseAtom(rangeParts[0]);
    const end = parseAtom(rangeParts[1]);
    return start !== null && end !== null && start <= end;
  }
  return false;
}

/**
 * Validate a strict 5-field cron expression (`minute hour day month weekday`).
 *
 * @param {string} expr
 * @returns {string} normalized single-space-separated 5-field cron expression
 */
export function validateCronExpression(expr) {
  if (typeof expr !== "string" || !expr.trim()) {
    throw new Error("Invalid cron expression: expected a non-empty 5-field cron string");
  }
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression '${expr.trim()}': expected exactly 5 fields (minute hour day month weekday), got ${fields.length}`
    );
  }

  const specs = [
    { name: "minute", min: 0, max: 59, names: null },
    { name: "hour", min: 0, max: 23, names: null },
    { name: "day-of-month", min: 1, max: 31, names: null },
    { name: "month", min: 1, max: 12, names: MONTH_NAMES },
    { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES },
  ];

  for (let i = 0; i < 5; i += 1) {
    const field = fields[i];
    const spec = specs[i];
    const tokens = field.split(",");
    if (tokens.some((tok) => !tok)) {
      throw new Error(
        `Invalid cron expression '${expr.trim()}': empty list token in ${spec.name} field '${field}'`
      );
    }
    for (const tok of tokens) {
      if (!parseCronToken(tok, spec.min, spec.max, spec.names)) {
        throw new Error(
          `Invalid cron expression '${expr.trim()}': invalid ${spec.name} token '${tok}' (allowed ${spec.min}-${spec.max})`
        );
      }
    }
  }

  return fields.join(" ");
}

/**
 * Validate an IANA timezone name (e.g. `Asia/Shanghai`, `America/New_York`, `UTC`).
 * Rejects abbreviations like `PST` and raw offsets like `+08:00`.
 *
 * @param {string} tz
 * @returns {string}
 */
export function validateIanaTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) {
    throw new Error("Invalid timezone: expected a non-empty IANA timezone like 'Asia/Shanghai' or 'UTC'");
  }
  const trimmed = tz.trim();
  const ianaFormat = /^(?:UTC|[A-Z][A-Za-z_-]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*)$/;
  if (!ianaFormat.test(trimmed) || /^(?:UTC|GMT)[+-]/i.test(trimmed)) {
    throw new Error(
      `Invalid IANA timezone '${trimmed}': use a full IANA zone like 'Asia/Shanghai', 'America/New_York', or 'UTC' (abbreviations like PST and offsets like +08:00 are rejected)`
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw new Error(`Invalid IANA timezone '${trimmed}': unknown timezone identifier`);
  }
  return trimmed;
}

function damerauLevenshtein(a, b) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i += 1) dp[i][0] = i;
  for (let j = 0; j <= lb; j += 1) dp[0][j] = j;

  for (let i = 1; i <= la; i += 1) {
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, dp[i - 2][j - 2] + cost);
      }
      dp[i][j] = val;
    }
  }
  return dp[la][lb];
}

function suggestFrontmatterKey(unknownKey) {
  const lower = unknownKey.toLowerCase();
  if (KEY_SYNONYM_HINTS[lower]) {
    return KEY_SYNONYM_HINTS[lower];
  }
  let best = null;
  let bestDist = Infinity;
  for (const candidate of ALLOWED_FRONTMATTER_KEYS) {
    const dist = damerauLevenshtein(lower, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return bestDist <= 3 ? best : null;
}

function stripYamlComment(text) {
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inDouble) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
      return text.slice(0, i);
    }
  }
  return text;
}

function unescapeDoubleQuoted(raw, lineNo, sourceLabel) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (i + 1 >= raw.length) {
      throw new Error(`Trailing backslash in double-quoted string at line ${lineNo} (${sourceLabel})`);
    }
    const next = raw[i + 1];
    i += 1;
    switch (next) {
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "0":
        out += "\0";
        break;
      case "/":
        out += "/";
        break;
      default:
        out += next;
        break;
    }
  }
  return out;
}

function parseYamlScalar(rawStr, lineNo, sourceLabel) {
  const trimmed = rawStr.trim();
  if (!trimmed) {
    return { value: "", quoted: false, quoteStyle: null };
  }

  if (trimmed.startsWith('"')) {
    if (trimmed.length < 2 || !trimmed.endsWith('"')) {
      throw new Error(`Unclosed double-quoted string at line ${lineNo} (${sourceLabel})`);
    }
    // Verify no unescaped quote ended earlier with trailing garbage.
    let closedAt = -1;
    let esc = false;
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        closedAt = i;
        break;
      }
    }
    if (closedAt !== trimmed.length - 1) {
      throw new Error(`Unexpected trailing characters after quoted string at line ${lineNo} (${sourceLabel})`);
    }
    return {
      value: unescapeDoubleQuoted(trimmed.slice(1, -1), lineNo, sourceLabel),
      quoted: true,
      quoteStyle: '"',
    };
  }

  if (trimmed.startsWith("'")) {
    let closedAt = -1;
    let out = "";
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (ch === "'") {
        if (trimmed[i + 1] === "'") {
          out += "'";
          i += 1;
        } else {
          closedAt = i;
          break;
        }
      } else {
        out += ch;
      }
    }
    if (closedAt !== trimmed.length - 1) {
      throw new Error(`Invalid single-quoted string at line ${lineNo} (${sourceLabel})`);
    }
    return { value: out, quoted: true, quoteStyle: "'" };
  }

  if (trimmed.startsWith("{") || trimmed === "|" || trimmed === ">") {
    throw new Error(
      `Unsupported YAML construct '${trimmed[0]}' at line ${lineNo} (${sourceLabel}); only scalars and string lists are supported`
    );
  }

  return { value: trimmed, quoted: false, quoteStyle: null };
}

function parseInlineArray(rawStr, lineNo, sourceLabel) {
  const trimmed = rawStr.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Malformed inline YAML array at line ${lineNo} (${sourceLabel})`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inDouble) {
      current += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += inner[i + 1];
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === ",") {
      if (!current.trim()) {
        throw new Error(`Empty element in inline YAML array at line ${lineNo} (${sourceLabel})`);
      }
      tokens.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  if (inSingle || inDouble) {
    throw new Error(`Unclosed quote inside inline YAML array at line ${lineNo} (${sourceLabel})`);
  }
  if (!current.trim()) {
    throw new Error(`Trailing comma in inline YAML array at line ${lineNo} (${sourceLabel})`);
  }
  tokens.push(current.trim());

  return tokens.map((tok) => parseYamlScalar(tok, lineNo, sourceLabel));
}

function parseFrontmatterYamlSubset(yamlText, sourceLabel = "profile") {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const rawEntries = new Map();

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 2; // Line 1 is opening '---'
    const rawLine = lines[i];
    const withoutComment = stripYamlComment(rawLine);
    const trimmed = withoutComment.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (/^\s+/.test(rawLine)) {
      throw new Error(
        `Unexpected indentation at line ${lineNo} (${sourceLabel}): nested YAML mappings are not supported`
      );
    }

    if (trimmed.startsWith("-")) {
      throw new Error(
        `Unexpected YAML list item '-' without parent key at line ${lineNo} (${sourceLabel})`
      );
    }

    const kvMatch = withoutComment.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (!kvMatch) {
      throw new Error(`Invalid YAML frontmatter syntax at line ${lineNo} (${sourceLabel}): '${rawLine.trim()}'`);
    }

    const key = kvMatch[1];
    const valPart = kvMatch[2].trim();

    if (rawEntries.has(key)) {
      throw new Error(`Duplicate frontmatter key '${key}' at line ${lineNo} (${sourceLabel})`);
    }

    if (valPart === "") {
      // Block sequence (`- item`) or empty value.
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const subLineNo = j + 2;
        const subRaw = lines[j];
        const subNoComment = stripYamlComment(subRaw);
        const subTrimmed = subNoComment.trim();
        if (!subTrimmed) {
          j += 1;
          continue;
        }
        const itemMatch = subNoComment.match(/^\s*-\s*(.*)$/);
        if (!itemMatch) {
          break;
        }
        const itemRaw = itemMatch[1].trim();
        if (!itemRaw) {
          throw new Error(`Empty block list item under '${key}' at line ${subLineNo} (${sourceLabel})`);
        }
        items.push(parseYamlScalar(itemRaw, subLineNo, sourceLabel));
        j += 1;
      }

      if (items.length > 0) {
        rawEntries.set(key, { kind: "array", items, lineNo });
        i = j;
        continue;
      }

      // Empty scalar with no block list following.
      rawEntries.set(key, { kind: "empty", lineNo });
      i += 1;
      continue;
    }

    if (valPart.startsWith("[")) {
      const items = parseInlineArray(valPart, lineNo, sourceLabel);
      rawEntries.set(key, { kind: "array", items, lineNo });
      i += 1;
      continue;
    }

    const scalar = parseYamlScalar(valPart, lineNo, sourceLabel);
    rawEntries.set(key, { kind: "scalar", ...scalar, lineNo });
    i += 1;
  }

  return rawEntries;
}

function expectNonEmptyString(entry, key, sourceLabel) {
  if (entry.kind !== "scalar" || typeof entry.value !== "string" || !entry.value.trim()) {
    throw new Error(`Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): expected non-empty string`);
  }
  if (entry.value.includes("\0")) {
    throw new Error(`Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): NUL character is forbidden`);
  }
  return entry.value.trim();
}

function expectSingleLineString(entry, key, sourceLabel) {
  const val = expectNonEmptyString(entry, key, sourceLabel);
  if (/[\r\n\0]/.test(val)) {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): newline or NUL characters are not permitted`
    );
  }
  return val;
}

function expectBoolean(entry, key, sourceLabel) {
  if (entry.kind !== "scalar" || entry.quoted || (entry.value !== "true" && entry.value !== "false")) {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): expected boolean true or false`
    );
  }
  return entry.value === "true";
}

function expectInt(entry, key, minVal, sourceLabel) {
  if (entry.kind !== "scalar" || entry.quoted || !/^-?\d+$/.test(entry.value)) {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): expected integer >= ${minVal}`
    );
  }
  const num = Number.parseInt(entry.value, 10);
  if (!Number.isSafeInteger(num) || num < minVal) {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): value ${entry.value} must be an integer >= ${minVal}`
    );
  }
  return num;
}

function expectEnum(entry, key, allowedSet, sourceLabel) {
  const val = expectSingleLineString(entry, key, sourceLabel);
  if (!allowedSet.has(val)) {
    throw new Error(
      `Invalid frontmatter '${key}' value '${val}' at line ${entry.lineNo} (${sourceLabel}): expected one of ${Array.from(allowedSet).join(", ")}`
    );
  }
  return val;
}

function expectStringArray(entry, key, { nonEmptyArray = false } = {}, sourceLabel) {
  if (entry.kind === "empty") {
    if (nonEmptyArray) {
      throw new Error(
        `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): expected a non-empty array of strings`
      );
    }
    return [];
  }
  if (entry.kind !== "array") {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): expected a YAML array of strings`
    );
  }
  const values = [];
  for (const item of entry.items) {
    if (typeof item.value !== "string" || !item.value.trim() || item.value.includes("\0")) {
      throw new Error(
        `Invalid frontmatter '${key}' item at line ${entry.lineNo} (${sourceLabel}): expected non-empty string`
      );
    }
    values.push(item.value.trim());
  }
  if (nonEmptyArray && values.length === 0) {
    throw new Error(
      `Invalid frontmatter '${key}' at line ${entry.lineNo} (${sourceLabel}): array must not be empty`
    );
  }
  return values;
}

function validateFrontmatterSchema(rawEntries, sourceLabel = "profile") {
  const allowedSet = new Set(ALLOWED_FRONTMATTER_KEYS);
  const config = {};

  const hasWorkerModel = rawEntries.has("worker_model");
  const hasModelAlias = rawEntries.has("model");
  if (hasWorkerModel && hasModelAlias) {
    throw new Error(
      `Conflicting frontmatter keys in ${sourceLabel}: 'worker_model' and 'model' cannot both be set`
    );
  }

  const hasBudgetTokens = rawEntries.has("budget_tokens");
  const hasMaxTokensAlias = rawEntries.has("max_tokens");
  if (hasBudgetTokens && hasMaxTokensAlias) {
    throw new Error(
      `Conflicting frontmatter keys in ${sourceLabel}: 'budget_tokens' and 'max_tokens' cannot both be set`
    );
  }

  for (const [key, entry] of rawEntries.entries()) {
    if (!allowedSet.has(key)) {
      const suggestion = suggestFrontmatterKey(key);
      const hint = suggestion ? ` (did you mean '${suggestion}'?)` : "";
      throw new Error(
        `Unknown frontmatter key '${key}' at line ${entry.lineNo} in ${sourceLabel}${hint}`
      );
    }

    if (entry.kind === "empty" && key !== "targets" && key !== "access_grants") {
      throw new Error(
        `Empty value for frontmatter key '${key}' at line ${entry.lineNo} (${sourceLabel})`
      );
    }

    switch (key) {
      case "name": {
        const nameVal = expectSingleLineString(entry, key, sourceLabel);
        if (!validateProfileName(nameVal)) {
          throw new Error(
            `Invalid frontmatter 'name' value '${nameVal}' at line ${entry.lineNo} (${sourceLabel}): must match ${VALID_PROFILE_NAME_RE} without '..'`
          );
        }
        config.name = nameVal;
        break;
      }
      case "description":
      case "verify_cmd":
      case "probe_cmd":
        config[key] = expectNonEmptyString(entry, key, sourceLabel);
        break;
      case "fallback_model":
      case "verifier_model":
        config[key] = expectSingleLineString(entry, key, sourceLabel);
        break;
      case "worker_model":
      case "model":
        config.worker_model = expectSingleLineString(entry, key, sourceLabel);
        break;
      case "engine":
        config.engine = expectEnum(entry, key, VALID_ENGINES, sourceLabel);
        break;
      case "state_mode":
        config.state_mode = expectEnum(entry, key, VALID_STATE_MODES, sourceLabel);
        break;
      case "effort":
        config.effort = expectEnum(entry, key, VALID_EFFORTS, sourceLabel);
        break;
      case "mode":
        config.mode = expectEnum(entry, key, VALID_MODES, sourceLabel);
        break;
      case "singleton":
        config.singleton = expectEnum(entry, key, VALID_SINGLETONS, sourceLabel);
        break;
      case "interval": {
        const durStr = expectSingleLineString(entry, key, sourceLabel);
        const parsed = parseDurationStrict(durStr, "interval");
        config.interval_sec = parsed.seconds;
        config.interval_label = parsed.label;
        break;
      }
      case "verify_timeout": {
        const durStr = expectSingleLineString(entry, key, sourceLabel);
        config.verify_timeout_sec = parseDurationStrict(durStr, "verify_timeout").seconds;
        break;
      }
      case "probe_timeout": {
        const durStr = expectSingleLineString(entry, key, sourceLabel);
        config.probe_timeout_sec = parseDurationStrict(durStr, "probe_timeout").seconds;
        break;
      }
      case "max_duration": {
        const durStr = expectSingleLineString(entry, key, sourceLabel);
        config.max_duration_sec = parseDurationStrict(durStr, "max_duration").seconds;
        break;
      }
      case "turn_timeout": {
        const durStr = expectSingleLineString(entry, key, sourceLabel);
        config.turn_timeout_sec = parseDurationStrict(durStr, "turn_timeout").seconds;
        break;
      }
      case "cron":
        config.cron = validateCronExpression(expectSingleLineString(entry, key, sourceLabel));
        break;
      case "timezone":
        config.timezone = validateIanaTimezone(expectSingleLineString(entry, key, sourceLabel));
        break;
      case "once":
      case "verify":
      case "probe_until_pass":
      case "sandbox":
      case "worktree":
      case "keep_worktree":
      case "fail_on_denied":
        config[key] = expectBoolean(entry, key, sourceLabel);
        break;
      case "max_iterations":
      case "reset_every":
      case "max_errors":
        config[key] = expectInt(entry, key, 1, sourceLabel);
        break;
      case "budget_tokens":
      case "max_tokens":
        config.budget_tokens = expectInt(entry, key, 1, sourceLabel);
        break;
      case "max_retries":
        config.max_retries = expectInt(entry, key, 0, sourceLabel);
        break;
      case "targets":
        config.targets = expectStringArray(entry, key, { nonEmptyArray: true }, sourceLabel);
        break;
      case "access_grants": {
        const rawGrants = expectStringArray(entry, key, { nonEmptyArray: false }, sourceLabel);
        config.access_grants = validateSidecarGrants(rawGrants);
        break;
      }
      default:
        break;
    }
  }

  if (config.once && config.max_iterations !== undefined && config.max_iterations > 1) {
    throw new Error(
      `Conflicting frontmatter in ${sourceLabel}: 'once: true' cannot be combined with 'max_iterations: ${config.max_iterations}'`
    );
  }

  if (config.reset_every !== undefined && config.state_mode !== "stateful") {
    throw new Error(
      `Conflicting frontmatter in ${sourceLabel}: 'reset_every' requires 'state_mode: stateful'`
    );
  }

  if (config.probe_until_pass && !config.probe_cmd) {
    throw new Error(
      `Conflicting frontmatter in ${sourceLabel}: 'probe_until_pass: true' requires 'probe_cmd'`
    );
  }

  return config;
}

function locateFrontmatterDelimiters(buf) {
  let fmStart = -1;
  if (
    buf.length >= 4 &&
    buf[0] === 0x2d &&
    buf[1] === 0x2d &&
    buf[2] === 0x2d
  ) {
    if (buf[3] === 0x0a) {
      fmStart = 4;
    } else if (buf.length >= 5 && buf[3] === 0x0d && buf[4] === 0x0a) {
      fmStart = 5;
    }
  }
  if (fmStart < 0) {
    return null;
  }

  let pos = fmStart;
  while (pos <= buf.length) {
    let lineEnd = buf.indexOf(0x0a, pos);
    const hasNewline = lineEnd >= 0;
    if (!hasNewline) {
      lineEnd = buf.length;
    }

    let contentEnd = lineEnd;
    if (contentEnd > pos && buf[contentEnd - 1] === 0x0d) {
      contentEnd -= 1;
    }

    const lineStr = buf.subarray(pos, contentEnd).toString("utf8");
    if (/^---[ \t]*$/.test(lineStr)) {
      const bodyStartRaw = hasNewline ? lineEnd + 1 : buf.length;
      return {
        fmBuf: buf.subarray(fmStart, pos),
        bodyStartRaw,
      };
    }

    if (!hasNewline) {
      break;
    }
    pos = lineEnd + 1;
  }

  return { unclosed: true };
}

/**
 * Parse a profile/loop.md document with optional strict YAML frontmatter v2
 * and UTF-8-safe 25,000-byte truncation on the Markdown body only.
 *
 * @param {Buffer | string} rawBuf
 * @param {{ sourceLabel?: string, maxBodyBytes?: number }} [opts]
 * @returns {{ hasFrontmatter: boolean, config: object, body: string, bodyBytes: number, truncated: boolean }}
 */
export function parseProfileDocument(rawBuf, { sourceLabel = "profile", maxBodyBytes = LOOP_MD_MAX_BYTES } = {}) {
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf ?? ""), "utf8");
  const located = locateFrontmatterDelimiters(buf);

  if (!located) {
    const { text, truncated } = truncateUtf8Bytes(buf, maxBodyBytes);
    return {
      hasFrontmatter: false,
      config: {},
      body: text,
      bodyBytes: Buffer.byteLength(text, "utf8"),
      truncated,
    };
  }

  if (located.unclosed) {
    throw new Error(`Unclosed YAML frontmatter in ${sourceLabel}: missing closing '---' delimiter`);
  }

  const fmText = located.fmBuf.toString("utf8");
  const rawEntries = parseFrontmatterYamlSubset(fmText, sourceLabel);
  const config = validateFrontmatterSchema(rawEntries, sourceLabel);

  // Strip blank lines immediately separating closing '---' from Markdown body.
  let bodyStart = located.bodyStartRaw;
  while (bodyStart < buf.length && (buf[bodyStart] === 0x0a || buf[bodyStart] === 0x0d)) {
    bodyStart += 1;
  }

  const bodyBuf = buf.subarray(bodyStart);
  const { text, truncated } = truncateUtf8Bytes(bodyBuf, maxBodyBytes);

  return {
    hasFrontmatter: true,
    config,
    body: text,
    bodyBytes: Buffer.byteLength(text, "utf8"),
    truncated,
  };
}

function scanLoopsDirectory(dirPath, scope, sourcePrefix) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const items = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }

    const stem = entry.name.slice(0, -3);
    const source = `${sourcePrefix}/${entry.name}`;
    if (!validateProfileName(stem)) {
      items.push({
        name: stem,
        scope,
        source,
        path: fullPath,
        isDefault: false,
        ok: false,
        error: `Invalid profile filename '${entry.name}': stem must match ${VALID_PROFILE_NAME_RE}`,
        hasFrontmatter: false,
        config: {},
        bodyBytes: 0,
      });
      continue;
    }

    if (stat.size <= 0) {
      items.push({
        name: stem,
        scope,
        source,
        path: fullPath,
        isDefault: false,
        ok: false,
        error: "Profile file is empty (0 bytes)",
        hasFrontmatter: false,
        config: {},
        bodyBytes: 0,
      });
      continue;
    }

    try {
      const rawBuf = fs.readFileSync(fullPath);
      const parsed = parseProfileDocument(rawBuf, { sourceLabel: source });
      items.push({
        name: stem,
        scope,
        source,
        path: fullPath,
        isDefault: false,
        ok: true,
        error: null,
        hasFrontmatter: parsed.hasFrontmatter,
        config: parsed.config,
        bodyBytes: parsed.bodyBytes,
      });
    } catch (err) {
      items.push({
        name: stem,
        scope,
        source,
        path: fullPath,
        isDefault: false,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hasFrontmatter: true,
        config: {},
        bodyBytes: 0,
      });
    }
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * Scan default loop.md candidates plus workspace `.agents/loops/*.md` and global `~/.gemini/config/loops/*.md`.
 *
 * @param {string} workspaceDir
 * @param {string | null} [homeDir]
 * @returns {Array<object>}
 */
export function listProfiles(workspaceDir, homeDir = resolveHomeLocal()) {
  const ws = path.resolve(workspaceDir || process.cwd());
  const defaultCandidates = [
    {
      name: "default",
      scope: "workspace",
      source: ".agents/loop.md",
      path: path.join(ws, ".agents", "loop.md"),
    },
    {
      name: "default",
      scope: "workspace",
      source: "loop.md",
      path: path.join(ws, "loop.md"),
    },
  ];
  if (homeDir) {
    defaultCandidates.push({
      name: "default",
      scope: "global",
      source: "~/.gemini/config/loop.md",
      path: path.join(homeDir, ".gemini", "config", "loop.md"),
    });
  }

  const results = [];
  for (const cand of defaultCandidates) {
    let stat;
    try {
      stat = fs.statSync(cand.path);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    if (stat.size <= 0) {
      results.push({
        ...cand,
        isDefault: true,
        ok: false,
        error: "Profile file is empty (0 bytes)",
        hasFrontmatter: false,
        config: {},
        bodyBytes: 0,
      });
      continue;
    }
    try {
      const rawBuf = fs.readFileSync(cand.path);
      const parsed = parseProfileDocument(rawBuf, { sourceLabel: cand.source });
      results.push({
        ...cand,
        isDefault: true,
        ok: true,
        error: null,
        hasFrontmatter: parsed.hasFrontmatter,
        config: parsed.config,
        bodyBytes: parsed.bodyBytes,
      });
    } catch (err) {
      results.push({
        ...cand,
        isDefault: true,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hasFrontmatter: true,
        config: {},
        bodyBytes: 0,
      });
    }
  }

  results.push(
    ...scanLoopsDirectory(path.join(ws, ".agents", "loops"), "workspace", ".agents/loops")
  );
  if (homeDir) {
    results.push(
      ...scanLoopsDirectory(
        path.join(homeDir, ".gemini", "config", "loops"),
        "global",
        "~/.gemini/config/loops"
      )
    );
  }

  return results;
}

/**
 * Resolve task prompt and optional frontmatter metadata from `--profile`, `--file`,
 * or default v1 precedence (`.agents/loop.md` -> `loop.md` -> `~/.gemini/config/loop.md` -> builtin).
 *
 * @param {{ workspaceDir?: string, homeDir?: string | null, profile?: string | null, file?: string | null }} [opts]
 * @returns {{ source: string, path: string | null, profileName: string | null, scope: string, hasFrontmatter: boolean, frontmatter: object, truncated: boolean, prompt: string, explicitlySelected: boolean }}
 */
export function resolveProfileTask({
  workspaceDir,
  homeDir = resolveHomeLocal(),
  profile = null,
  file = null,
} = {}) {
  const ws = path.resolve(workspaceDir || process.cwd());
  const hasProfile = typeof profile === "string" && profile.trim() !== "";
  const hasFile = typeof file === "string" && file.trim() !== "";

  if (hasProfile && hasFile) {
    throw new Error("Conflicting profile options: cannot specify both '--profile' and '--file'");
  }

  if (hasFile) {
    const fileStr = file.trim();
    const resolvedPath = path.isAbsolute(fileStr)
      ? path.resolve(fileStr)
      : path.resolve(ws, fileStr);

    let stat;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      throw new Error(`Profile file not found: ${resolvedPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Profile path is not a regular file: ${resolvedPath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`Profile file is empty (0 bytes): ${resolvedPath}`);
    }

    const rawBuf = fs.readFileSync(resolvedPath);
    if (rawBuf.length === 0) {
      throw new Error(`Profile file is empty (0 bytes): ${resolvedPath}`);
    }

    const parsed = parseProfileDocument(rawBuf, { sourceLabel: fileStr });
    const stem = path.basename(resolvedPath, path.extname(resolvedPath));
    return {
      source: fileStr,
      path: resolvedPath,
      profileName: parsed.config.name || stem || null,
      scope: "file",
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: parsed.config,
      truncated: parsed.truncated,
      prompt: parsed.body,
      explicitlySelected: true,
    };
  }

  if (hasProfile) {
    const profileTrimmed = profile.trim();
    if (!validateProfileName(profileTrimmed)) {
      throw new Error(
        `Invalid profile name '${profileTrimmed}': must match ${VALID_PROFILE_NAME_RE} (no '/', '\\', '..', or whitespace)`
      );
    }

    const candidates = [
      {
        scope: "workspace",
        source: `.agents/loops/${profileTrimmed}.md`,
        path: path.join(ws, ".agents", "loops", `${profileTrimmed}.md`),
      },
    ];
    if (homeDir) {
      candidates.push({
        scope: "global",
        source: `~/.gemini/config/loops/${profileTrimmed}.md`,
        path: path.join(homeDir, ".gemini", "config", "loops", `${profileTrimmed}.md`),
      });
    }

    for (const cand of candidates) {
      let stat;
      try {
        stat = fs.statSync(cand.path);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Profile '${profileTrimmed}' at ${cand.path} is not a regular file`);
      }
      if (stat.size <= 0) {
        throw new Error(`Profile '${profileTrimmed}' at ${cand.path} is empty (0 bytes)`);
      }
      const rawBuf = fs.readFileSync(cand.path);
      if (rawBuf.length === 0) {
        throw new Error(`Profile '${profileTrimmed}' at ${cand.path} is empty (0 bytes)`);
      }
      const parsed = parseProfileDocument(rawBuf, { sourceLabel: cand.source });
      return {
        source: cand.source,
        path: cand.path,
        profileName: profileTrimmed,
        scope: cand.scope,
        hasFrontmatter: parsed.hasFrontmatter,
        frontmatter: parsed.config,
        truncated: parsed.truncated,
        prompt: parsed.body,
        explicitlySelected: true,
      };
    }

    const discovered = listProfiles(ws, homeDir)
      .filter((entry) => !entry.isDefault)
      .map((entry) => `${entry.name} (${entry.scope}${entry.ok ? "" : ", invalid"})`);
    const availableText = discovered.length > 0 ? discovered.join(", ") : "(none)";
    throw new Error(
      `Profile '${profileTrimmed}' not found in .agents/loops/ or ~/.gemini/config/loops/. Discovered profiles: ${availableText}`
    );
  }

  // Default v1 precedence: .agents/loop.md -> loop.md -> ~/.gemini/config/loop.md -> builtin
  const defaults = [
    {
      scope: "workspace",
      source: ".agents/loop.md",
      path: path.join(ws, ".agents", "loop.md"),
    },
    {
      scope: "workspace",
      source: "loop.md",
      path: path.join(ws, "loop.md"),
    },
  ];
  if (homeDir) {
    defaults.push({
      scope: "global",
      source: "~/.gemini/config/loop.md",
      path: path.join(homeDir, ".gemini", "config", "loop.md"),
    });
  }

  for (const cand of defaults) {
    let stat;
    try {
      stat = fs.statSync(cand.path);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) {
      continue;
    }
    let rawBuf;
    try {
      rawBuf = fs.readFileSync(cand.path);
    } catch {
      continue;
    }
    if (rawBuf.length === 0) {
      continue;
    }
    const parsed = parseProfileDocument(rawBuf, { sourceLabel: cand.source });
    return {
      source: cand.source,
      path: cand.path,
      profileName: parsed.config.name || null,
      scope: cand.scope,
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: parsed.config,
      truncated: parsed.truncated,
      prompt: parsed.body,
      explicitlySelected: false,
    };
  }

  return {
    source: "builtin",
    path: null,
    profileName: null,
    scope: "builtin",
    hasFrontmatter: false,
    frontmatter: {},
    truncated: false,
    prompt: BUILTIN_MAINTENANCE_PROMPT,
    explicitlySelected: false,
  };
}

function hasExplicitFlag(explicitFlags, ...keys) {
  if (!explicitFlags || typeof explicitFlags.has !== "function") {
    return false;
  }
  return keys.some((k) => explicitFlags.has(k));
}

/**
 * Merge CLI configuration with resolved profile frontmatter under `CLI > frontmatter > defaults`.
 * Enforces the security red line blocking untrusted frontmatter `probe_cmd` / `verify_cmd`
 * unless overridden by CLI or explicitly trusted via `trustProfileCommands`.
 *
 * @param {object} cliConfig
 * @param {object | null | undefined} profileResult
 * @param {{ explicitFlags?: Set<string>, trustProfileCommands?: boolean }} [opts]
 * @returns {object}
 */
export function mergeProfileWithCli(
  cliConfig = {},
  profileResult = null,
  { explicitFlags = new Set(), trustProfileCommands = false } = {}
) {
  const fm = profileResult?.frontmatter ?? profileResult?.config ?? {};
  const trusted = Boolean(trustProfileCommands || cliConfig?.trustProfileCommands);

  const cliSetProbe =
    hasExplicitFlag(explicitFlags, "probeCmd", "probe_cmd", "--probe") ||
    Boolean(cliConfig.probeCmd);
  const cliSetVerify =
    hasExplicitFlag(explicitFlags, "verifyCmd", "verify_cmd", "--verify-cmd") ||
    Boolean(cliConfig.verifyCmd);

  const blockedCmdKeys = [];
  if (typeof fm.probe_cmd === "string" && fm.probe_cmd && !cliSetProbe && !trusted) {
    blockedCmdKeys.push("probe_cmd");
  }
  if (typeof fm.verify_cmd === "string" && fm.verify_cmd && !cliSetVerify && !trusted) {
    blockedCmdKeys.push("verify_cmd");
  }
  if (blockedCmdKeys.length > 0) {
    return {
      ok: false,
      exitCode: 2,
      error: `Refusing to execute untrusted frontmatter command (${blockedCmdKeys.join(", ")}) from ${profileResult?.source || "profile"}: pass --trust-profile-commands or pass --probe/--verify-cmd explicitly.`,
    };
  }

  const merged = { ...cliConfig };

  const explicitOnce = hasExplicitFlag(explicitFlags, "once", "--once");
  const explicitMaxIter = hasExplicitFlag(
    explicitFlags,
    "maxIterations",
    "max_iterations",
    "max",
    "--max"
  );
  const explicitStateMode = hasExplicitFlag(
    explicitFlags,
    "stateMode",
    "state_mode",
    "--stateful",
    "--fresh"
  );

  const cliSetOnce = explicitOnce || Boolean(cliConfig.once);
  const cliSetMaxIter =
    explicitMaxIter ||
    (Number.isInteger(cliConfig.maxIterations) &&
      cliConfig.maxIterations !== (cliConfig.once ? 1 : 20));
  const cliSetStateMode = explicitStateMode || cliConfig.stateMode === "stateful";
  const cliSetResetEvery =
    hasExplicitFlag(explicitFlags, "resetEvery", "reset_every", "--reset-every") ||
    cliConfig.resetEvery != null;
  const cliSetInterval =
    hasExplicitFlag(explicitFlags, "interval", "intervalSec", "interval_sec", "pacing") ||
    cliConfig.intervalSec != null;
  const cliSetModel =
    hasExplicitFlag(explicitFlags, "model", "worker_model", "--model") ||
    Boolean(cliConfig.model);
  const cliSetEffort =
    hasExplicitFlag(explicitFlags, "effort", "--effort") || Boolean(cliConfig.effort);
  const cliSetFallback =
    hasExplicitFlag(explicitFlags, "fallbackModel", "fallback_model", "--fallback-model") ||
    Boolean(cliConfig.fallbackModel);
  const cliSetVerifier =
    hasExplicitFlag(explicitFlags, "verifierModel", "verifier_model", "--verifier-model") ||
    Boolean(cliConfig.verifierModel);
  const cliSetVerifyBool =
    hasExplicitFlag(explicitFlags, "verify", "--verify", "--no-verify") ||
    cliConfig.verify !== undefined;
  const cliSetMode =
    hasExplicitFlag(explicitFlags, "mode", "--mode") || Boolean(cliConfig.mode);
  const cliSetSandbox =
    hasExplicitFlag(explicitFlags, "sandbox", "--sandbox") || Boolean(cliConfig.sandbox);
  const cliSetWorktree =
    hasExplicitFlag(explicitFlags, "worktree", "--worktree") || Boolean(cliConfig.worktree);
  const cliSetKeepWorktree =
    hasExplicitFlag(explicitFlags, "keepWorktree", "keep_worktree", "--keep-worktree") ||
    Boolean(cliConfig.keepWorktree);
  const cliSetFailOnDenied =
    hasExplicitFlag(explicitFlags, "failOnDenied", "fail_on_denied", "--fail-on-denied") ||
    Boolean(cliConfig.failOnDenied);
  const cliSetProbeTimeout =
    hasExplicitFlag(explicitFlags, "probeTimeoutSec", "probe_timeout_sec", "probeTimeout", "--probe-timeout") ||
    (Number.isInteger(cliConfig.probeTimeoutSec) && cliConfig.probeTimeoutSec !== 60);
  const cliSetVerifyTimeout =
    hasExplicitFlag(explicitFlags, "verifyTimeoutSec", "verify_timeout_sec", "verifyTimeout", "--verify-timeout") ||
    (Number.isInteger(cliConfig.verifyTimeoutSec) && cliConfig.verifyTimeoutSec !== 60);
  const cliSetProbeUntilPass =
    hasExplicitFlag(explicitFlags, "probeUntilPass", "probe_until_pass", "--probe-until-pass") ||
    Boolean(cliConfig.probeUntilPass);
  const cliSetMaxTokens =
    hasExplicitFlag(explicitFlags, "maxTokens", "max_tokens", "budget_tokens", "--max-tokens") ||
    cliConfig.maxTokens != null;
  const cliSetMaxDuration =
    hasExplicitFlag(explicitFlags, "maxDurationSec", "max_duration_sec", "maxDuration", "--max-duration") ||
    cliConfig.maxDurationSec != null;
  const cliSetMaxRetries =
    hasExplicitFlag(explicitFlags, "maxRetries", "max_retries", "--max-retries") ||
    (Number.isInteger(cliConfig.maxRetries) && cliConfig.maxRetries !== 3);
  const cliSetMaxErrors =
    hasExplicitFlag(explicitFlags, "maxErrors", "max_errors", "--max-errors") ||
    (Number.isInteger(cliConfig.maxErrors) && cliConfig.maxErrors !== 3);
  const cliSetTurnTimeout =
    hasExplicitFlag(explicitFlags, "turnTimeoutSec", "turn_timeout_sec", "turnTimeout", "--turn-timeout") ||
    (Number.isInteger(cliConfig.turnTimeoutSec) && cliConfig.turnTimeoutSec !== 600);
  const cliSetTargets =
    hasExplicitFlag(explicitFlags, "targets", "--targets") ||
    (Array.isArray(cliConfig.targets) && cliConfig.targets.length > 0);
  const cliSetSingleton =
    hasExplicitFlag(explicitFlags, "singleton", "--singleton") ||
    Boolean(cliConfig.singleton);
  const cliSetCron =
    hasExplicitFlag(explicitFlags, "cron", "--cron") || Boolean(cliConfig.cron);
  const cliSetTimezone =
    hasExplicitFlag(explicitFlags, "timezone", "--tz", "--timezone") ||
    Boolean(cliConfig.timezone);

  if (!cliSetOnce && fm.once !== undefined) {
    if (cliSetMaxIter && Number.isInteger(cliConfig.maxIterations) && cliConfig.maxIterations > 1) {
      merged.once = false;
    } else {
      merged.once = Boolean(fm.once);
    }
  }
  if (!cliSetMaxIter) {
    if (cliSetOnce && merged.once) {
      merged.maxIterations = 1;
    } else if (fm.max_iterations !== undefined) {
      merged.maxIterations = fm.max_iterations;
    } else if (merged.once && !cliConfig.once) {
      merged.maxIterations = 1;
    }
  }
  if (!cliSetStateMode && fm.state_mode !== undefined) {
    merged.stateMode = fm.state_mode;
  }
  if (!cliSetResetEvery && fm.reset_every !== undefined) {
    if (merged.stateMode === "stateful") {
      merged.resetEvery = fm.reset_every;
    }
  } else if (cliSetStateMode && merged.stateMode !== "stateful" && !cliSetResetEvery) {
    merged.resetEvery = null;
  }
  if (!cliSetInterval && fm.interval_sec !== undefined) {
    merged.pacing = "fixed";
    merged.intervalSec = fm.interval_sec;
    merged.intervalLabel = fm.interval_label;
  }
  if (!cliSetCron && fm.cron !== undefined) {
    merged.cron = fm.cron;
  }
  if (!cliSetTimezone && fm.timezone !== undefined) {
    merged.timezone = fm.timezone;
  }
  if (!cliSetModel && fm.worker_model !== undefined) {
    merged.model = fm.worker_model;
  }
  if (!cliSetEffort && fm.effort !== undefined) {
    merged.effort = fm.effort;
  }
  if (!cliSetFallback && fm.fallback_model !== undefined) {
    merged.fallbackModel = fm.fallback_model;
  }
  if (!cliSetVerifier && fm.verifier_model !== undefined) {
    merged.verifierModel = fm.verifier_model;
  }
  if (!cliSetVerifyBool && fm.verify !== undefined) {
    merged.verify = Boolean(fm.verify);
  }
  if (!cliSetVerify && fm.verify_cmd !== undefined && trusted) {
    merged.verifyCmd = fm.verify_cmd;
  }
  if (!cliSetVerifyTimeout && fm.verify_timeout_sec !== undefined) {
    merged.verifyTimeoutSec = fm.verify_timeout_sec;
  }
  if (!cliSetProbe && fm.probe_cmd !== undefined && trusted) {
    merged.probeCmd = fm.probe_cmd;
  }
  if (!cliSetProbeTimeout && fm.probe_timeout_sec !== undefined) {
    merged.probeTimeoutSec = fm.probe_timeout_sec;
  }
  if (!cliSetProbeUntilPass && fm.probe_until_pass !== undefined) {
    merged.probeUntilPass = Boolean(fm.probe_until_pass);
  }
  if (!cliSetMode && fm.mode !== undefined) {
    merged.mode = fm.mode;
  }
  if (!cliSetSandbox && fm.sandbox !== undefined) {
    merged.sandbox = Boolean(fm.sandbox);
  }
  if (!cliSetWorktree && fm.worktree !== undefined) {
    merged.worktree = Boolean(fm.worktree);
  }
  if (!cliSetKeepWorktree && fm.keep_worktree !== undefined) {
    merged.keepWorktree = Boolean(fm.keep_worktree);
  }
  merged.workspace = merged.worktree ? "branch" : "inherit";

  if (!cliSetFailOnDenied && fm.fail_on_denied !== undefined) {
    merged.failOnDenied = Boolean(fm.fail_on_denied);
  }
  if (!cliSetMaxTokens && fm.budget_tokens !== undefined) {
    merged.maxTokens = fm.budget_tokens;
  }
  if (!cliSetMaxDuration && fm.max_duration_sec !== undefined) {
    merged.maxDurationSec = fm.max_duration_sec;
  }
  if (!cliSetMaxRetries && fm.max_retries !== undefined) {
    merged.maxRetries = fm.max_retries;
  }
  if (!cliSetMaxErrors && fm.max_errors !== undefined) {
    merged.maxErrors = fm.max_errors;
  }
  if (!cliSetTurnTimeout && fm.turn_timeout_sec !== undefined) {
    merged.turnTimeoutSec = fm.turn_timeout_sec;
  }
  if (!cliSetTargets && Array.isArray(fm.targets)) {
    merged.targets = [...fm.targets];
  }

  const profileOrFileSpecified = Boolean(
    cliConfig?.profile ||
      cliConfig?.file ||
      cliConfig?.profileFile ||
      profileResult?.explicitlySelected
  );

  if (cliSetSingleton) {
    merged.singleton = cliConfig.singleton;
  } else if (fm.singleton !== undefined) {
    merged.singleton = fm.singleton;
  } else if (profileOrFileSpecified) {
    merged.singleton = "profile";
  } else {
    merged.singleton = "none";
  }

  if (profileResult?.profileName && !merged.profileName) {
    merged.profileName = profileResult.profileName;
  }
  if (profileResult?.path && !merged.profilePath) {
    merged.profilePath = profileResult.path;
  }
  if ((!merged.prompt || !String(merged.prompt).trim()) && profileResult?.prompt) {
    merged.prompt = profileResult.prompt;
    if (!merged.taskSource) {
      merged.taskSource = "loop_md_or_default";
    }
  }
  if (Array.isArray(fm.access_grants) && !merged.accessGrants) {
    merged.accessGrants = [...fm.access_grants];
  }
  if (fm.engine && !merged.engine) {
    merged.engine = fm.engine;
  }

  // Post-merge consistency validation
  if (merged.once && Number.isInteger(merged.maxIterations) && merged.maxIterations > 1) {
    return {
      ok: false,
      exitCode: 2,
      error: `Conflicting configuration: once mode cannot use max_iterations=${merged.maxIterations} (> 1)`,
    };
  }
  if (merged.resetEvery != null && merged.stateMode !== "stateful") {
    return {
      ok: false,
      exitCode: 2,
      error: "Conflicting configuration: reset_every requires state_mode 'stateful'",
    };
  }
  if (merged.probeUntilPass && !merged.probeCmd) {
    return {
      ok: false,
      exitCode: 2,
      error: "Conflicting configuration: probe_until_pass requires probe_cmd (--probe)",
    };
  }

  return {
    ok: true,
    ...merged,
    config: { ...merged },
    profile: profileResult || null,
  };
}
