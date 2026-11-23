import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveProfileTask,
} from "./profile-parser.mjs";

export const VALID_LOOP_ID_RE = /^lp_[A-Za-z0-9_-]{4,64}$/;

const GLOBAL_INDEX_MAX_ENTRIES = 200;

const DEFAULT_USAGE_TOTALS = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0,
  duration_seconds: 0,
  num_turns: 0,
});

let atomicCounter = 0;
let lastInboxEpochMs = 0;
let sameMsInboxSeq = 0;

function nowUtcIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatUtcCompactTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeRunConfigSnapshot(raw) {
  if (!isPlainObject(raw)) {
    return null;
  }
  const clean = { ...raw };
  delete clean.settingsArg;
  delete clean.settings_arg;
  delete clean.settings;
  return clean;
}

function readJsonObjectSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUsageTotals(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const numOrZero = (val) =>
    typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : 0;
  return {
    input_tokens: numOrZero(src.input_tokens),
    output_tokens: numOrZero(src.output_tokens),
    thinking_tokens: numOrZero(src.thinking_tokens),
    cache_read_tokens: numOrZero(src.cache_read_tokens),
    total_tokens: numOrZero(src.total_tokens),
    duration_seconds: numOrZero(src.duration_seconds),
    num_turns: numOrZero(src.num_turns),
  };
}

function compareLoopsDesc(a, b) {
  const ta = a?.updated_at ? Date.parse(a.updated_at) : Number.NaN;
  const tb = b?.updated_at ? Date.parse(b.updated_at) : Number.NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && tb !== ta) {
    return tb - ta;
  }
  const sa = String(a?.updated_at || "");
  const sb = String(b?.updated_at || "");
  if (sb !== sa) {
    return sb < sa ? -1 : 1;
  }
  const la = String(a?.loop_id || "");
  const lb = String(b?.loop_id || "");
  return lb === la ? 0 : lb < la ? -1 : 1;
}

export function computeStaleFlag(state) {
  return Boolean(
    state &&
      (state.engine === "headless" || state.engine === "workflow") &&
      state.status === "running" &&
      Number.isInteger(state.pid) &&
      state.pid > 0 &&
      !isPidAlive(state.pid)
  );
}


/**
 * Validate loop_id format to prevent path traversal and invalid directory names.
 */
export function validateLoopId(loopId) {
  return typeof loopId === "string" && VALID_LOOP_ID_RE.test(loopId);
}

/**
 * Resolve home directory from env or OS fallback.
 */
export function resolveHome(env = process.env) {
  const fromEnv = env && typeof env.HOME === "string" ? env.HOME : "";
  return fromEnv || os.homedir();
}

/**
 * Resolve workspace state root directory, honoring AGY_LOOP_STATE_DIR override.
 */
export function resolveStateRoot(workspaceDir, env = process.env) {
  const override =
    env && typeof env.AGY_LOOP_STATE_DIR === "string"
      ? env.AGY_LOOP_STATE_DIR.trim()
      : "";
  if (override) {
    return override;
  }
  return path.join(path.resolve(workspaceDir || process.cwd()), ".agents", ".agy-loop");
}

/**
 * Ensure stateRoot, loops directory, and non-clobbering .gitignore exist.
 */
export function ensureStateRoot(stateRoot) {
  fs.mkdirSync(path.join(stateRoot, "loops"), { recursive: true });
  const gitignorePath = path.join(stateRoot, ".gitignore");
  try {
    fs.writeFileSync(gitignorePath, "*\n", { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }
  return stateRoot;
}

/**
 * Generate a collision-free UTC loop_id (`lp_YYYYMMDDTHHMMSSZ_<4hex>`).
 */
export function generateLoopId(stateRoot) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const ts = formatUtcCompactTimestamp();
    const hex = crypto.randomBytes(2).toString("hex");
    const candidate = `lp_${ts}_${hex}`;
    const candidateDir = path.join(stateRoot, "loops", candidate);
    try {
      fs.lstatSync(candidateDir);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return candidate;
      }
    }
  }
  throw new Error("Failed to generate unique loop_id after 32 attempts");
}

/**
 * Atomically write a JSON object with trailing newline via temp file + rename.
 */
export function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicCounter += 1;
  const tmpPath = `${filePath}.tmp.${process.pid}.${atomicCounter}`;
  const content = `${JSON.stringify(obj)}\n`;
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup failure
    }
    throw err;
  }
}

/**
 * Acquire an exclusive O_EXCL lock file synchronously, reclaim stale locks, and run `fn`.
 */
export function withFileLock(lockPath, fn, { staleMs = 10000, maxAttempts = 40 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const sleepSab = new Int32Array(new SharedArrayBuffer(4));
  const safeStaleMs =
    Number.isFinite(Number(staleMs)) && Number(staleMs) >= 0 ? Number(staleMs) : 10000;
  const attempts =
    Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 40;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }

      let reclaimed = false;
      try {
        const stat = fs.statSync(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        let lockInfo = null;
        try {
          lockInfo = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        } catch {
          lockInfo = null;
        }
        const holderPid = Number.isInteger(lockInfo?.pid) ? lockInfo.pid : null;
        const deadHolder = holderPid !== null && holderPid > 0 && !isPidAlive(holderPid);
        const timedOut = ageMs > safeStaleMs;
        if (deadHolder || timedOut) {
          try {
            fs.unlinkSync(lockPath);
            reclaimed = true;
          } catch (unlinkErr) {
            if (unlinkErr && unlinkErr.code === "ENOENT") {
              reclaimed = true;
            }
          }
        }
      } catch (statErr) {
        if (statErr && statErr.code === "ENOENT") {
          reclaimed = true;
        }
      }

      if (reclaimed) {
        continue;
      }

      if (attempt + 1 < attempts) {
        const waitMs = 15 + Math.floor(Math.random() * 35);
        Atomics.wait(sleepSab, 0, 0, waitMs);
      }
      continue;
    }

    try {
      const lockPayload = `${JSON.stringify({ pid: process.pid, acquired_at: nowUtcIso() })}\n`;
      const buf = Buffer.from(lockPayload, "utf8");
      try {
        let offset = 0;
        while (offset < buf.length) {
          offset += fs.writeSync(fd, buf, offset, buf.length - offset);
        }
      } finally {
        fs.closeSync(fd);
      }
      return fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore lock cleanup failure if already unlinked
      }
    }
  }

  const timeoutErr = new Error(`Timed out acquiring lock: ${lockPath}`);
  timeoutErr.code = "ELOCKTIMEOUT";
  throw timeoutErr;
}

/**
 * Validate loopId and return its directory path inside stateRoot.
 */
export function getLoopDir(stateRoot, loopId) {
  if (!validateLoopId(loopId)) {
    throw new Error(`Invalid loop_id: ${String(loopId)}`);
  }
  return path.join(stateRoot, "loops", loopId);
}

/**
 * Initialize a new v1.1-compatible + headless-extended loop state and init event.
 */
export function createLoopState(stateRoot, fields = {}) {
  ensureStateRoot(stateRoot);

  let loopId = fields.loop_id;
  if (loopId === undefined || loopId === null || loopId === "") {
    loopId = generateLoopId(stateRoot);
  } else if (!validateLoopId(loopId)) {
    throw new Error(`Invalid loop_id: ${String(loopId)}`);
  }

  const now = nowUtcIso();
  const once = Boolean(fields.once ?? false);
  const stateMode = fields.state_mode ?? "fresh";
  const model = fields.model ?? null;
  const inlinePrompt =
    typeof fields.inline_prompt === "string"
      ? fields.inline_prompt
      : typeof fields.prompt === "string"
        ? fields.prompt
        : "";

  const state = {
    schema_version: 1,
    loop_id: loopId,
    status: fields.status ?? "running",
    workspace_dir: fields.workspace_dir
      ? path.resolve(fields.workspace_dir)
      : process.cwd(),
    task_source: fields.task_source ?? "loop_md_or_default",
    inline_prompt: inlinePrompt,
    pacing: fields.pacing ?? "dynamic",
    once,
    interval_sec: fields.interval_sec ?? null,
    interval_label: fields.interval_label ?? null,
    cron_expr: fields.cron_expr ?? null,
    use_cron: Boolean(fields.use_cron ?? false),
    exact_timing: Boolean(fields.exact_timing ?? false),
    is_daemon: Boolean(fields.is_daemon ?? false),
    state_mode: stateMode,
    workspace: fields.workspace ?? "inherit",
    model,
    delegate: fields.delegate ?? "loop-worker",
    iteration: Number.isInteger(fields.iteration) ? fields.iteration : 1,
    max_iterations: Number.isInteger(fields.max_iterations)
      ? fields.max_iterations
      : once
        ? 1
        : 20,
    consecutive_errors: Number.isInteger(fields.consecutive_errors)
      ? fields.consecutive_errors
      : 0,
    task_id: fields.task_id ?? null,
    worker_id: fields.worker_id ?? null,
    worktree_branch: fields.worktree_branch ?? null,
    last_status: fields.last_status ?? null,
    last_delay_sec: fields.last_delay_sec ?? null,
    last_summary: fields.last_summary ?? null,
    next_hint: fields.next_hint ?? "None",
    stop_requested: Boolean(fields.stop_requested ?? false),
    stop_mode: fields.stop_mode ?? null,
    created_at: fields.created_at ?? now,
    updated_at: fields.updated_at ?? now,

    // Additive v1.2 headless fields (safely ignored by v1.1 loop-helper.sh)
    engine: fields.engine ?? "headless",
    transport:
      fields.transport ?? (stateMode === "stateful" ? "stream-json" : "json"),
    pid: fields.pid ?? null,
    conversation_id: fields.conversation_id ?? null,
    effort: fields.effort ?? null,
    mode: fields.mode ?? null,
    fallback_model: fields.fallback_model ?? null,
    active_model: fields.active_model ?? model,
    verifier_model: fields.verifier_model ?? null,
    sandbox: Boolean(fields.sandbox ?? false),
    add_dirs: Array.isArray(fields.add_dirs) ? [...fields.add_dirs] : [],
    worktree_path: fields.worktree_path ?? null,
    worktree_base_sha: fields.worktree_base_sha ?? null,
    worktree_head_sha: fields.worktree_head_sha ?? null,
    probe_cmd: fields.probe_cmd ?? null,
    turn_timeout_sec: fields.turn_timeout_sec ?? null,
    max_duration_sec: fields.max_duration_sec ?? null,
    max_tokens: fields.max_tokens ?? null,
    started_at: fields.started_at ?? now,
    finished_at: fields.finished_at ?? null,
    exit_reason: fields.exit_reason ?? null,
    usage_totals: fields.usage_totals
      ? normalizeUsageTotals(fields.usage_totals)
      : { ...DEFAULT_USAGE_TOTALS },
    denied_actions_count: Number.isInteger(fields.denied_actions_count)
      ? fields.denied_actions_count
      : 0,

    // Additive v1.3 checkpoint, two-stage verification, targets, and resume fields
    in_flight_iteration: Number.isInteger(fields.in_flight_iteration)
      ? fields.in_flight_iteration
      : null,
    in_flight_snapshot_hash:
      typeof fields.in_flight_snapshot_hash === "string"
        ? fields.in_flight_snapshot_hash
        : null,
    verify_cmd: fields.verify_cmd ?? null,
    verify_timeout_sec: fields.verify_timeout_sec ?? null,
    targets: Array.isArray(fields.targets) ? [...fields.targets] : [],
    resumed_from_iteration: Number.isInteger(fields.resumed_from_iteration)
      ? fields.resumed_from_iteration
      : null,
    resume_count: Number.isInteger(fields.resume_count) ? fields.resume_count : 0,
    elapsed_sec:
      typeof fields.elapsed_sec === "number" &&
      Number.isFinite(fields.elapsed_sec) &&
      fields.elapsed_sec >= 0
        ? fields.elapsed_sec
        : 0,
    run_config_snapshot: sanitizeRunConfigSnapshot(fields.run_config_snapshot),

    // Additive v2.0 multi-profile and singleton lease fields
    profile_name:
      typeof fields.profile_name === "string" && fields.profile_name.trim()
        ? fields.profile_name.trim()
        : null,
    profile_path:
      typeof fields.profile_path === "string" && fields.profile_path.trim()
        ? fields.profile_path.trim()
        : null,
    singleton:
      fields.singleton === "profile" ||
      fields.singleton === "workspace" ||
      fields.singleton === "none"
        ? fields.singleton
        : "none",
    lock_scope_key:
      typeof fields.lock_scope_key === "string" && fields.lock_scope_key.trim()
        ? fields.lock_scope_key.trim()
        : null,
    relay_count:
      Number.isInteger(fields.relay_count) && fields.relay_count >= 0
        ? fields.relay_count
        : 0,
  };

  const loopDir = getLoopDir(stateRoot, loopId);
  fs.mkdirSync(loopDir, { recursive: true });
  writeJsonAtomic(path.join(loopDir, "state.json"), state);
  appendEvent(stateRoot, loopId, {
    ts: state.updated_at,
    event: "init",
    loop_id: state.loop_id,
    iteration: state.iteration,
    status: state.status,
    last_status: state.last_status,
    consecutive_errors: state.consecutive_errors,
  });

  return state;
}

/**
 * Read and parse state.json for loopId, returning null if missing or corrupt.
 */
export function readLoopState(stateRoot, loopId) {
  const loopDir = getLoopDir(stateRoot, loopId);
  return readJsonObjectSafe(path.join(loopDir, "state.json"));
}

/**
 * Patch existing loop state atomically, refreshing updated_at and optionally appending an event.
 */
export function updateLoopState(stateRoot, loopId, patch, eventRecord = null) {
  const loopDir = getLoopDir(stateRoot, loopId);
  const statePath = path.join(loopDir, "state.json");
  const existing = readLoopState(stateRoot, loopId);
  if (!existing) {
    throw new Error(`Invalid or missing state.json for ${loopId}`);
  }

  const safePatch = isPlainObject(patch) ? patch : {};
  const nextState = {
    ...existing,
    ...safePatch,
    loop_id: existing.loop_id || loopId,
    updated_at: nowUtcIso(),
  };

  writeJsonAtomic(statePath, nextState);

  if (eventRecord !== null && eventRecord !== undefined) {
    const baseEvent =
      typeof eventRecord === "string"
        ? { event: eventRecord }
        : isPlainObject(eventRecord)
          ? eventRecord
          : {};
    const enriched = {
      ...baseEvent,
      ts: baseEvent.ts ?? nextState.updated_at,
      loop_id: baseEvent.loop_id ?? nextState.loop_id,
      iteration: baseEvent.iteration ?? nextState.iteration,
      status: baseEvent.status ?? nextState.status,
    };
    appendEvent(stateRoot, loopId, enriched);
  }

  return nextState;
}

/**
 * Append a single compact JSON event line to events.jsonl.
 */
export function appendEvent(stateRoot, loopId, eventObj) {
  const loopDir = getLoopDir(stateRoot, loopId);
  fs.mkdirSync(loopDir, { recursive: true });
  const payload = isPlainObject(eventObj) ? eventObj : { event: String(eventObj) };
  const record = {
    ...payload,
    ts: payload.ts ?? nowUtcIso(),
    loop_id: payload.loop_id ?? loopId,
  };
  fs.appendFileSync(
    path.join(loopDir, "events.jsonl"),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
  return record;
}

/**
 * Read and parse valid JSONL records from events.jsonl, skipping blank or corrupt lines.
 */
export function readEvents(stateRoot, loopId) {
  const loopDir = getLoopDir(stateRoot, loopId);
  const eventsPath = path.join(loopDir, "events.jsonl");
  let raw;
  try {
    raw = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed)) {
        events.push(parsed);
      }
    } catch {
      // Ignore partial or corrupt JSONL lines
    }
  }
  return events;
}

const VALID_INBOX_TYPES = new Set(["nudge", "wake", "stop"]);
const CLAIMED_RETENTION_LIMIT = 100;

function getInboxDir(stateRoot, loopId) {
  return path.join(getLoopDir(stateRoot, loopId), "inbox");
}

function listInboxFilenames(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.name.endsWith(".json")) {
      continue;
    }
    if (entry.isDirectory()) {
      continue;
    }
    if (!entry.isFile()) {
      try {
        if (!fs.statSync(path.join(dirPath, entry.name)).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
    }
    files.push(entry.name);
  }
  files.sort();
  return files;
}

function pruneClaimedInbox(claimedDir, limit = CLAIMED_RETENTION_LIMIT) {
  const files = listInboxFilenames(claimedDir);
  if (files.length <= limit) {
    return;
  }
  const toDelete = files.slice(0, files.length - limit);
  for (const name of toDelete) {
    try {
      fs.unlinkSync(path.join(claimedDir, name));
    } catch {
      // Ignore concurrent cleanup failures
    }
  }
}

/**
 * Atomically enqueue a control message (`nudge`, `wake`, or `stop`) into `<loopDir>/inbox/`.
 */
export function enqueueInboxMessage(stateRoot, loopId, payload) {
  if (!isPlainObject(payload) || !VALID_INBOX_TYPES.has(payload.type)) {
    throw new Error(`Invalid inbox message type: ${String(payload?.type)}`);
  }

  const inboxDir = getInboxDir(stateRoot, loopId);
  fs.mkdirSync(inboxDir, { recursive: true });

  const createdAt =
    typeof payload.created_at === "string" && payload.created_at.trim()
      ? payload.created_at.trim()
      : nowUtcIso();

  let record;
  if (payload.type === "nudge") {
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!message) {
      throw new Error("Nudge inbox message requires a non-empty 'message'");
    }
    record = {
      type: "nudge",
      message,
      wake: Boolean(payload.wake),
      created_at: createdAt,
    };
  } else if (payload.type === "wake") {
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    const sourcePid =
      Number.isInteger(payload.source_pid) && payload.source_pid > 0
        ? payload.source_pid
        : null;
    record = {
      type: "wake",
      ...(reason ? { reason } : {}),
      ...(sourcePid !== null ? { source_pid: sourcePid } : {}),
      created_at: createdAt,
    };
  } else {
    const mode = payload.mode ?? "immediate";
    if (mode !== "immediate" && mode !== "after_current") {
      throw new Error(`Invalid stop mode: ${String(mode)}`);
    }
    record = {
      type: "stop",
      mode,
      created_at: createdAt,
    };
  }

  atomicCounter += 1;
  const tmpPath = path.join(inboxDir, `.tmp.${process.pid}.${atomicCounter}`);
  const epochMs = Date.now();
  if (epochMs === lastInboxEpochMs) {
    sameMsInboxSeq = (sameMsInboxSeq + 1) & 0xff;
  } else {
    lastInboxEpochMs = epochMs;
    sameMsInboxSeq = 0;
  }
  const randByte = crypto.randomBytes(1)[0];
  const hex = (((sameMsInboxSeq & 0xff) << 8) | randByte).toString(16).padStart(4, "0");
  const filename = `${epochMs}_${process.pid}_${hex}.json`;
  const finalPath = path.join(inboxDir, filename);

  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(record)}\n`, "utf8");
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup failure
    }
    throw err;
  }

  return { ...record, file: finalPath, filename };
}

/**
 * Read-only scan of pending `<loopDir>/inbox/*.json` flags without consuming messages.
 */
export function peekInboxFlags(stateRoot, loopId) {
  const inboxDir = getInboxDir(stateRoot, loopId);
  const files = listInboxFilenames(inboxDir);

  let stop = false;
  let stopMode = null;
  let wake = false;
  let nudgeCount = 0;

  for (const name of files) {
    const msg = readJsonObjectSafe(path.join(inboxDir, name));
    if (!msg || typeof msg.type !== "string") {
      continue;
    }
    if (msg.type === "stop") {
      stop = true;
      if (msg.mode === "after_current") {
        if (stopMode !== "immediate") {
          stopMode = "after_current";
        }
      } else {
        stopMode = "immediate";
      }
    } else if (msg.type === "wake") {
      wake = true;
    } else if (msg.type === "nudge") {
      nudgeCount += 1;
      if (msg.wake) {
        wake = true;
      }
    }
  }

  return { stop, stopMode, wake, nudgeCount };
}

/**
 * Synchronously claim all pending `<loopDir>/inbox/*.json` messages in chronological order.
 */
export function claimInboxMessages(stateRoot, loopId) {
  const inboxDir = getInboxDir(stateRoot, loopId);
  const files = listInboxFilenames(inboxDir);
  if (files.length === 0) {
    return [];
  }

  const claimedDir = path.join(inboxDir, "claimed");
  fs.mkdirSync(claimedDir, { recursive: true });

  const messages = [];
  for (const name of files) {
    const src = path.join(inboxDir, name);
    const dest = path.join(claimedDir, name);
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        continue;
      }
      throw err;
    }
    const parsed = readJsonObjectSafe(dest);
    if (parsed && VALID_INBOX_TYPES.has(parsed.type)) {
      messages.push(parsed);
    }
  }

  pruneClaimedInbox(claimedDir, CLAIMED_RETENTION_LIMIT);
  return messages;
}

/**
 * Atomically write control.json and enqueue a stop inbox entry (`immediate` or `after_current`).
 */
export function writeControlStop(stateRoot, loopId, mode = "immediate") {
  if (mode !== "immediate" && mode !== "after_current") {
    throw new Error(`Invalid stop mode: ${String(mode)}`);
  }
  const loopDir = getLoopDir(stateRoot, loopId);
  const control = {
    stop_requested: true,
    mode,
    requested_at: nowUtcIso(),
  };
  writeJsonAtomic(path.join(loopDir, "control.json"), control);
  enqueueInboxMessage(stateRoot, loopId, { type: "stop", mode });
  return control;
}

/**
 * Remove control.json and claim/discard stale `stop` entries from inbox for resume.
 */
export function clearControlStop(stateRoot, loopId) {
  const loopDir = getLoopDir(stateRoot, loopId);
  fs.rmSync(path.join(loopDir, "control.json"), { force: true });

  const inboxDir = getInboxDir(stateRoot, loopId);
  const files = listInboxFilenames(inboxDir);
  if (files.length === 0) {
    return 0;
  }

  const claimedDir = path.join(inboxDir, "claimed");
  let discarded = 0;
  for (const name of files) {
    const src = path.join(inboxDir, name);
    const parsed = readJsonObjectSafe(src);
    if (parsed?.type !== "stop") {
      continue;
    }
    fs.mkdirSync(claimedDir, { recursive: true });
    try {
      fs.renameSync(src, path.join(claimedDir, name));
      discarded += 1;
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (discarded > 0) {
    pruneClaimedInbox(claimedDir, CLAIMED_RETENTION_LIMIT);
  }
  return discarded;
}

/**
 * Read parsed control.json for loopId, or null if absent/corrupt.
 */
export function readControl(stateRoot, loopId) {
  const loopDir = getLoopDir(stateRoot, loopId);
  return readJsonObjectSafe(path.join(loopDir, "control.json"));
}

/**
 * Check control.json, state.json, and pending inbox stop messages to determine stop request state and mode.
 */
export function isStopRequested(stateRoot, loopId) {
  const control = readControl(stateRoot, loopId);
  const state = readLoopState(stateRoot, loopId);
  const inboxFlags = peekInboxFlags(stateRoot, loopId);

  const ctrlRequested = Boolean(control?.stop_requested);
  const stateRequested = Boolean(state?.stop_requested);
  const inboxRequested = Boolean(inboxFlags.stop);

  if (!ctrlRequested && !stateRequested && !inboxRequested) {
    return { requested: false, mode: null };
  }

  const ctrlMode =
    control?.mode === "immediate" || control?.mode === "after_current"
      ? control.mode
      : null;
  const stateMode =
    state?.stop_mode === "immediate" || state?.stop_mode === "after_current"
      ? state.stop_mode
      : null;
  const inboxMode =
    inboxFlags.stopMode === "immediate" || inboxFlags.stopMode === "after_current"
      ? inboxFlags.stopMode
      : null;

  let mode = "immediate";
  if (
    ctrlMode === "immediate" ||
    stateMode === "immediate" ||
    inboxMode === "immediate" ||
    state?.status === "stopped"
  ) {
    mode = "immediate";
  } else if (ctrlMode || stateMode || inboxMode) {
    mode = ctrlMode || stateMode || inboxMode;
  }

  return { requested: true, mode };
}

/**
 * Probe whether a positive integer PID is alive (treating EPERM as alive).
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/**
 * Scan valid loop state files under stateRoot, attaching stale & state_dir, filtered and sorted.
 */
export function listLoops(stateRoot, { includeAll = false } = {}) {
  const loopsDir = path.join(stateRoot, "loops");
  let entries;
  try {
    entries = fs.readdirSync(loopsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!validateLoopId(entry.name)) {
      continue;
    }
    const parsed = readJsonObjectSafe(path.join(loopsDir, entry.name, "state.json"));
    if (!parsed || typeof parsed.status !== "string" || !parsed.status) {
      continue;
    }
    const record = {
      ...parsed,
      loop_id: parsed.loop_id || entry.name,
      stale: computeStaleFlag(parsed),
      state_dir: stateRoot,
    };
    if (!includeAll && record.status !== "running") {
      continue;
    }
    results.push(record);
  }

  results.sort(compareLoopsDesc);
  return results;
}

/**
 * Resolve a loop by "latest", exact loop_id, or unique prefix/suffix match.
 */
export function resolveLoopByIdOrPrefix(stateRoot, query, { includeAll = true } = {}) {
  if (typeof query !== "string" || !query.trim()) {
    return { ok: false, error: "Missing loop_id or query." };
  }
  const q = query.trim();
  const loops = listLoops(stateRoot, { includeAll });

  if (loops.length === 0) {
    return { ok: false, error: `No loops found in ${stateRoot}.` };
  }

  if (q === "latest") {
    return { ok: true, loop: loops[0] };
  }

  const exact = loops.find((item) => item.loop_id === q);
  if (exact) {
    return { ok: true, loop: exact };
  }

  const matches = loops.filter(
    (item) => item.loop_id.startsWith(q) || item.loop_id.endsWith(q)
  );
  if (matches.length === 1) {
    return { ok: true, loop: matches[0] };
  }
  if (matches.length > 1) {
    const preview = matches
      .slice(0, 5)
      .map((item) => item.loop_id)
      .join(", ");
    return {
      ok: false,
      error: `Ambiguous loop query "${q}" matches ${matches.length} loops: ${preview}`,
    };
  }

  return { ok: false, error: `Loop not found: ${q}` };
}

/**
 * Resolve loop.md / profile task with exact v1.1 precedence (or `--profile`/`--file`),
 * 0-byte skipping on default candidates, optional YAML frontmatter parsing,
 * and UTF-8-safe 25k truncation on the Markdown body.
 */
export function resolveLoopMdTask(workspaceDir, homeDir = resolveHome(), opts = {}) {
  const resolved = resolveProfileTask({
    workspaceDir,
    homeDir,
    profile: opts?.profile ?? null,
    file: opts?.file ?? null,
  });
  return {
    source: resolved.source,
    path: resolved.path,
    truncated: resolved.truncated,
    prompt: resolved.prompt,
    profileName: resolved.profileName,
    scope: resolved.scope,
    hasFrontmatter: resolved.hasFrontmatter,
    frontmatter: resolved.frontmatter,
  };
}

/**
 * Resolve global index file path, returning null when AGY_LOOP_STATE_DIR isolates tests.
 */
export function resolveIndexPath(homeDir, env = process.env) {
  const explicit =
    env && typeof env.AGY_LOOP_INDEX_PATH === "string"
      ? env.AGY_LOOP_INDEX_PATH.trim()
      : "";
  if (explicit) {
    return explicit;
  }
  const stateOverride =
    env && typeof env.AGY_LOOP_STATE_DIR === "string"
      ? env.AGY_LOOP_STATE_DIR.trim()
      : "";
  if (stateOverride) {
    return null;
  }
  const resolvedHome = homeDir || resolveHome(env);
  return path.join(
    resolvedHome,
    ".gemini",
    "antigravity-cli",
    "plugin_data",
    "agy-loop",
    "index.json"
  );
}

/**
 * Read global cross-workspace index entries safely (returning [] on absence/error).
 */
export function readGlobalIndex({ homeDir, env = process.env } = {}) {
  const indexPath = resolveIndexPath(homeDir, env);
  if (!indexPath) {
    return [];
  }
  try {
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : isPlainObject(parsed) && Array.isArray(parsed.entries)
        ? parsed.entries
        : [];
    return list.filter((item) => isPlainObject(item) && validateLoopId(item.loop_id));
  } catch {
    return [];
  }
}

/**
 * Best-effort locked atomic upsert into global index, retaining up to 200 recent entries.
 */
export function upsertGlobalIndex(state, stateRoot, { homeDir, env = process.env } = {}) {
  try {
    const indexPath = resolveIndexPath(homeDir, env);
    if (!indexPath || !isPlainObject(state) || !validateLoopId(state.loop_id)) {
      return false;
    }

    return withFileLock(`${indexPath}.lock`, () => {
      const existing = readGlobalIndex({ homeDir, env });
      const filtered = existing.filter((item) => item.loop_id !== state.loop_id);
      const entry = {
        ...state,
        state_dir: stateRoot || state.state_dir || null,
      };
      const next = [entry, ...filtered];
      next.sort(compareLoopsDesc);
      writeJsonAtomic(indexPath, next.slice(0, GLOBAL_INDEX_MAX_ENTRIES));
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * List global loops from index, refreshing live state.json from each state_dir when readable.
 */
export function listGlobalLoops({ includeAll = false, homeDir, env = process.env } = {}) {
  const entries = readGlobalIndex({ homeDir, env });
  const byId = new Map();

  for (const entry of entries) {
    let record = entry;
    const stateDir = typeof entry.state_dir === "string" ? entry.state_dir : null;
    if (stateDir) {
      const live = readLoopState(stateDir, entry.loop_id);
      if (live) {
        record = live;
      }
    }
    const enriched = {
      ...record,
      loop_id: record.loop_id || entry.loop_id,
      stale: computeStaleFlag(record),
      state_dir: stateDir,
    };
    if (!includeAll && enriched.status !== "running") {
      continue;
    }
    if (!byId.has(enriched.loop_id)) {
      byId.set(enriched.loop_id, enriched);
    }
  }

  const results = Array.from(byId.values());
  results.sort(compareLoopsDesc);
  return results;
}

/**
 * Resolve daemon registry JSON path, honoring `AGY_LOOP_DAEMON_REGISTRY_PATH`
 * and isolating to `<AGY_LOOP_STATE_DIR>/daemons.json` when `AGY_LOOP_STATE_DIR` is set.
 */
export function resolveDaemonRegistryPath(homeDir, env = process.env) {
  const explicit =
    env && typeof env.AGY_LOOP_DAEMON_REGISTRY_PATH === "string"
      ? env.AGY_LOOP_DAEMON_REGISTRY_PATH.trim()
      : "";
  if (explicit) {
    return explicit;
  }
  const stateOverride =
    env && typeof env.AGY_LOOP_STATE_DIR === "string"
      ? env.AGY_LOOP_STATE_DIR.trim()
      : "";
  if (stateOverride) {
    return path.join(stateOverride, "daemons.json");
  }
  const resolvedHome = homeDir || resolveHome(env);
  return path.join(
    resolvedHome,
    ".gemini",
    "antigravity-cli",
    "plugin_data",
    "agy-loop",
    "daemons.json"
  );
}

/**
 * Read daemon registry entries safely, returning `[]` on absence or corrupt JSON.
 */
export function readDaemonRegistry({ homeDir, env = process.env } = {}) {
  const registryPath = resolveDaemonRegistryPath(homeDir, env);
  if (!registryPath) {
    return [];
  }
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : isPlainObject(parsed) && Array.isArray(parsed.entries)
        ? parsed.entries
        : [];
    return list.filter(
      (item) => isPlainObject(item) && typeof item.slug === "string" && item.slug.trim() !== ""
    );
  } catch {
    return [];
  }
}

/**
 * Locked atomic upsert of a daemon registry entry keyed by `(slug, mode)`.
 */
export function upsertDaemonEntry(entry, { homeDir, env = process.env } = {}) {
  if (!isPlainObject(entry) || typeof entry.slug !== "string" || !entry.slug.trim()) {
    throw new Error("upsertDaemonEntry requires an object with a non-empty 'slug'");
  }
  const registryPath = resolveDaemonRegistryPath(homeDir, env);
  if (!registryPath) {
    return false;
  }

  return withFileLock(`${registryPath}.lock`, () => {
    const existing = readDaemonRegistry({ homeDir, env });
    const targetSlug = entry.slug.trim();
    const targetMode = entry.mode || null;
    const targetPlatform = entry.platform || null;
    const filtered = existing.filter(
      (item) =>
        !(
          item.slug === targetSlug &&
          (item.mode || null) === targetMode &&
          (item.platform || null) === targetPlatform
        )
    );
    const now = nowUtcIso();
    const record = {
      ...entry,
      slug: targetSlug,
      installed_at: entry.installed_at || now,
      updated_at: now,
    };
    const next = [record, ...filtered];
    next.sort(
      (a, b) =>
        String(a.slug).localeCompare(String(b.slug)) ||
        String(a.mode || "").localeCompare(String(b.mode || "")) ||
        String(a.platform || "").localeCompare(String(b.platform || ""))
    );
    writeJsonAtomic(registryPath, next);
    return true;
  });
}

/**
 * Locked atomic removal of daemon registry entries matching `slug` (and optional `mode`/`platform`).
 */
export function removeDaemonEntry(
  slug,
  { mode = null, platform = null, homeDir, env = process.env } = {}
) {
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error("removeDaemonEntry requires a non-empty 'slug'");
  }
  const registryPath = resolveDaemonRegistryPath(homeDir, env);
  if (!registryPath) {
    return false;
  }

  return withFileLock(`${registryPath}.lock`, () => {
    const existing = readDaemonRegistry({ homeDir, env });
    const targetSlug = slug.trim();
    const next = existing.filter((item) => {
      if (item.slug !== targetSlug) {
        return true;
      }
      if (mode !== null && mode !== undefined && (item.mode || null) !== mode) {
        return true;
      }
      if (platform !== null && platform !== undefined && (item.platform || null) !== platform) {
        return true;
      }
      return false;
    });
    if (next.length === existing.length) {
      return false;
    }
    writeJsonAtomic(registryPath, next);
    return true;
  });
}
