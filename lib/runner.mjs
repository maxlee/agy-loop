/**
 * Headless loop runner state machine for `agy-loop run`.
 * Orchestrates `fresh` (json) and `--stateful` (stream-json) turns,
 * retries, fallback models, independent verification, probes, budgets, and worktrees.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { formatDuration, formatTokens } from "./duration.mjs";
import {
  EMPTY_USAGE,
  addUsageTotals,
  checkBudgets,
  classifyTurnFailure,
  computeUsageDelta,
  normalizeUsage,
} from "./error-policy.mjs";
import {
  forceTerminateChild,
  runJsonTurn,
  schedulePipeCloseFallback,
} from "./json-client.mjs";
import { fetchModelCatalog, resolveModelSlug } from "./models.mjs";
import {
  acquireLeaseLock,
  computeLockScope,
  markLeaseDraining,
  releaseLeaseLock,
  startLeaseHeartbeat,
  unmarkLeaseDraining,
} from "./lease-lock.mjs";
import { mergeProfileWithCli, resolveProfileTask } from "./profile-parser.mjs";
import {
  buildVerifierPrompt,
  buildWorkerPrompt,
  extractIterationOutcome,
  extractVerifierOutcome,
  writeSchemaFiles,
} from "./schemas.mjs";
import {
  appendEvent,
  claimInboxMessages,
  clearControlStop,
  createLoopState,
  ensureStateRoot,
  generateLoopId,
  getLoopDir,
  isPidAlive,
  isStopRequested,
  peekInboxFlags,
  readEvents,
  resolveHome,
  resolveLoopByIdOrPrefix,
  resolveStateRoot,
  updateLoopState,
  upsertGlobalIndex,
} from "./state-store.mjs";
import { StreamSession } from "./stream-client.mjs";
import {
  createHeadlessWorktree,
  finalizeHeadlessWorktree,
  inspectHeadlessWorktree,
  runGit,
} from "./worktree.mjs";

export const EXIT_CODES = Object.freeze({
  DONE: 0,
  ERROR: 1,
  USAGE: 2,
  BLOCKED: 3,
  MAX_REACHED: 4,
  LOCK_CONFLICT: 5,
  STOPPED: 130,
});

const MAX_PROBE_TAIL_BYTES = 4096;
const MAX_PROBE_CAPTURE_BYTES = 65536;

function writeOut(stream, text) {
  if (stream && typeof stream.write === "function") {
    stream.write(text);
  }
}

function emitStartupError({ config, exitCode, error, stdout, stderr }) {
  if (config?.json) {
    writeOut(
      stdout,
      `${JSON.stringify({ ok: false, exit_code: exitCode, error }, null, 2)}\n`
    );
  }
  writeOut(stderr, `Error: ${error}\n`);
  return { exitCode, state: null, worktreeResult: null };
}

function probeAgyBinary(agyBin, env) {
  const res = spawnSync(agyBin, ["--version"], {
    encoding: "utf8",
    env,
    timeout: 15000,
  });

  if (res.error) {
    if (res.error.code === "ENOENT" || res.error.code === "EACCES") {
      return {
        ok: false,
        error: `Antigravity CLI ('${agyBin}') was not found in PATH. Install Antigravity CLI or add it to PATH, then try again.`,
      };
    }
    return {
      ok: false,
      error: `Failed to execute '${agyBin} --version': ${res.error.message}`,
    };
  }

  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || `exited with status ${res.status}`).trim();
    return { ok: false, error: `'${agyBin} --version' failed: ${detail}` };
  }

  return { ok: true, version: (res.stdout || res.stderr || "").trim() };
}

function resolveConfiguredModels(config, { agyBin, env }) {
  const needsResolution =
    Boolean(config.model) ||
    Boolean(config.fallbackModel) ||
    Boolean(config.verifierModel);

  if (!needsResolution) {
    return {
      ok: true,
      primaryModel: null,
      fallbackModel: null,
      verifierModel: null,
    };
  }

  const catalogRes = fetchModelCatalog({ agyBin, env });
  const catalog = catalogRes.ok ? catalogRes.models : [];

  const resolveOne = (requested, flagName) => {
    if (!requested) {
      return { ok: true, slug: null };
    }
    const resolved = resolveModelSlug(requested, catalog);
    if (!resolved.ok) {
      return { ok: false, error: `Invalid ${flagName}: ${resolved.error}` };
    }
    return { ok: true, slug: resolved.slug };
  };

  const primary = resolveOne(config.model, "--model");
  if (!primary.ok) return primary;

  const fallback = resolveOne(config.fallbackModel, "--fallback-model");
  if (!fallback.ok) return fallback;

  const verifier = resolveOne(config.verifierModel, "--verifier-model");
  if (!verifier.ok) return verifier;

  return {
    ok: true,
    primaryModel: primary.slug,
    fallbackModel: fallback.slug,
    verifierModel: verifier.slug,
  };
}

function waitChunkInterruptible(ms, signal, sleepFn) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  if (signal?.aborted) {
    return Promise.resolve();
  }

  if (typeof sleepFn === "function") {
    if (!signal) {
      return Promise.resolve().then(() => sleepFn(ms));
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => sleepFn(ms))
        .then(
          () => {
            if (!done) {
              done = true;
              signal.removeEventListener("abort", onAbort);
              resolve();
            }
          },
          (err) => {
            if (!done) {
              done = true;
              signal.removeEventListener("abort", onAbort);
              reject(err);
            }
          }
        );
    });
  }

  return new Promise((resolve) => {
    let timer = null;
    const onAbort = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      timer = null;
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
  });
}

/**
 * Sleeps for up to `sec` seconds in `pollMs` slices, waking early if `signal`
 * aborts, `isStopRequested(stateRoot, loopId)` is active, or `wake` arrives in inbox.
 *
 * @param {number} sec
 * @param {object} [opts]
 * @returns {Promise<{ interrupted: boolean, reason: "signal" | "stop_requested" | "wake_requested" | null }>}
 */
export async function sleepInterruptible(
  sec,
  {
    stateRoot = null,
    loopId = null,
    signal = null,
    pollMs = 500,
    sleepFn = null,
    stopOnAfterCurrent = true,
    wakeOnInbox = true,
  } = {}
) {
  const totalMs = Math.max(0, Math.round(Number(sec || 0) * 1000));
  const stepMs = Math.max(1, Math.round(Number(pollMs) || 500));

  const checkInterrupted = () => {
    if (signal?.aborted) {
      return { interrupted: true, reason: "signal" };
    }
    if (stateRoot && loopId) {
      const stopState = isStopRequested(stateRoot, loopId);
      if (
        stopState.requested &&
        (stopOnAfterCurrent || stopState.mode === "immediate")
      ) {
        return { interrupted: true, reason: "stop_requested" };
      }
      if (wakeOnInbox) {
        const inboxFlags = peekInboxFlags(stateRoot, loopId);
        if (inboxFlags.wake) {
          return { interrupted: true, reason: "wake_requested" };
        }
      }
    }
    return null;
  };

  const pre = checkInterrupted();
  if (pre) {
    return pre;
  }
  if (totalMs <= 0) {
    return { interrupted: false, reason: null };
  }

  if (typeof sleepFn === "function") {
    let remainingMs = totalMs;
    while (remainingMs > 0) {
      const chunkMs = Math.min(remainingMs, stepMs);
      await waitChunkInterruptible(chunkMs, signal, sleepFn);
      remainingMs -= chunkMs;
      const hit = checkInterrupted();
      if (hit) {
        return hit;
      }
    }
    return { interrupted: false, reason: null };
  }

  const deadlineMs = Date.now() + totalMs;
  while (true) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      return checkInterrupted() || { interrupted: false, reason: null };
    }
    const chunkMs = Math.min(remainingMs, stepMs);
    await waitChunkInterruptible(chunkMs, signal, null);
    const hit = checkInterrupted();
    if (hit) {
      return hit;
    }
  }
}

function capUtf8Tail(text, maxBytes = MAX_PROBE_TAIL_BYTES) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  let start = buf.length - maxBytes;
  // Advance past UTF-8 continuation bytes (10xxxxxx) so slicing never splits a codepoint.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

function runProbeCommand(cmd, { cwd, env, timeoutSec = 60, signal = null }) {
  if (signal?.aborted) {
    return Promise.resolve({
      exitCode: 130,
      timedOut: false,
      aborted: true,
      outputTail: "",
    });
  }

  const shellBin = process.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgs = process.platform === "win32" ? ["/c", cmd] : ["-c", cmd];
  const timeoutMs =
    Number.isFinite(Number(timeoutSec)) && Number(timeoutSec) > 0
      ? Math.round(Number(timeoutSec) * 1000)
      : 60000;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shellBin, shellArgs, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: 1,
        timedOut: false,
        aborted: false,
        outputTail: capUtf8Tail(err?.message || String(err)),
      });
      return;
    }

    let chunks = [];
    let totalBytes = 0;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let timer = null;
    let cancelKill = () => {};
    let cancelPipe = () => {};

    const pushChunk = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      totalBytes += buf.length;
      if (totalBytes > MAX_PROBE_CAPTURE_BYTES * 2) {
        const merged = Buffer.concat(chunks);
        chunks = [merged.subarray(-MAX_PROBE_CAPTURE_BYTES)];
        totalBytes = chunks[0].length;
      }
    };

    child.stdout?.on("data", pushChunk);
    child.stderr?.on("data", pushChunk);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      cancelKill();
      cancelPipe();

      const combined = Buffer.concat(chunks).toString("utf8");
      resolve({
        exitCode: aborted ? 130 : timedOut ? 124 : typeof code === "number" ? code : 1,
        timedOut,
        aborted,
        outputTail: capUtf8Tail(combined, MAX_PROBE_TAIL_BYTES),
      });
    };

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      cancelKill();
      cancelKill = forceTerminateChild(child, { graceMs: 2000 });
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled || aborted || timedOut) return;
      timedOut = true;
      cancelKill();
      cancelKill = forceTerminateChild(child, { graceMs: 2000 });
    }, timeoutMs);
    timer.unref?.();

    child.on("exit", () => {
      if (!settled && (aborted || timedOut)) {
        cancelPipe = schedulePipeCloseFallback(child, 500);
      }
    });

    child.on("error", (err) => {
      pushChunk(Buffer.from(err?.message || String(err)));
      if (child.pid === undefined) {
        finish(1);
      }
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

function gatherVerifierGitContext({ execCwd, worktreeInfo, worktreeBaseSha, env }) {
  if (worktreeInfo) {
    try {
      const info = inspectHeadlessWorktree({
        worktreePath: execCwd,
        baseSha: worktreeBaseSha,
        env,
      });
      return { gitStatus: info.gitStatus, diffStat: info.diffStat };
    } catch {
      return { gitStatus: "", diffStat: "" };
    }
  }

  let gitStatus = "";
  let diffStat = "";
  try {
    const st = runGit(["status", "-sb"], { cwd: execCwd, env });
    if (st.ok) gitStatus = st.stdout.trim();
    const df = runGit(["diff", "--stat"], { cwd: execCwd, env });
    if (df.ok) diffStat = df.stdout.trim();
  } catch {
    // Non-git workspace or git unavailable.
  }
  return { gitStatus, diffStat };
}

function summarizeDeniedActions(deniedActions) {
  return deniedActions.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      return (
        item.tool_name ||
        item.tool ||
        item.action ||
        item.name ||
        JSON.stringify(item)
      );
    }
    return String(item);
  });
}

function formatActionableSeedHint(nextHint, lastSummary, rotatedSession) {
  if (!rotatedSession) {
    return nextHint || "None";
  }
  const hasHint = typeof nextHint === "string" && nextHint.trim() && nextHint !== "None";
  if (hasHint && lastSummary) {
    return `${nextHint} (Prior session rotated; last summary: ${lastSummary})`;
  }
  if (lastSummary) {
    return `Prior session rotated; last summary: ${lastSummary}`;
  }
  return nextHint || "None";
}

function buildFinalJsonPayload({ state, stateRoot, exitCode, worktreeInfo, worktreeResult }) {
  return {
    ok: exitCode === EXIT_CODES.DONE,
    exit_code: exitCode,
    loop_id: state.loop_id,
    status: state.status,
    exit_reason: state.exit_reason,
    iterations: state.iteration,
    max_iterations: state.max_iterations,
    last_status: state.last_status,
    last_summary: state.last_summary,
    active_model: state.active_model,
    conversation_id: state.conversation_id,
    usage_totals: state.usage_totals,
    denied_actions_count: state.denied_actions_count,
    profile_name: state.profile_name ?? null,
    singleton: state.singleton ?? "none",
    lock_scope_key: state.lock_scope_key ?? null,
    relay_count: state.relay_count ?? 0,
    worktree: worktreeInfo
      ? {
          branch: worktreeInfo.branch,
          path: worktreeInfo.worktreePath,
          base_sha: worktreeInfo.baseSha,
          head_sha: worktreeResult?.headSha ?? state.worktree_head_sha ?? null,
          ahead_count: worktreeResult?.aheadCount ?? null,
          dirty: worktreeResult?.dirty ?? null,
          preserved: worktreeResult?.preserved ?? true,
          removed: worktreeResult?.removed ?? false,
          merge_hint: worktreeResult?.mergeHint ?? null,
          cleanup_hint: worktreeResult?.cleanupHint ?? null,
        }
      : null,
    state_dir: stateRoot,
  };
}

function resolveRunFilePaths(workspaceDir, addDirs, settingsArg) {
  const resolvedAddDirs = Array.isArray(addDirs)
    ? addDirs
        .map((dir) => (typeof dir === "string" ? dir.trim() : ""))
        .filter(Boolean)
        .map((dir) => path.resolve(workspaceDir, dir))
    : [];

  let resolvedSettingsArg = null;
  if (typeof settingsArg === "string") {
    const trimmed = settingsArg.trim();
    if (trimmed.length > 0) {
      resolvedSettingsArg = trimmed.startsWith("{")
        ? trimmed
        : path.resolve(workspaceDir, trimmed);
    }
  } else if (settingsArg && typeof settingsArg === "object") {
    resolvedSettingsArg = settingsArg;
  }

  return { resolvedAddDirs, resolvedSettingsArg };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildRunConfigSnapshot(
  config,
  { workspaceDir, resolvedAddDirs, activeModel, fallbackModel, verifierModel }
) {
  return {
    pacing: config.pacing ?? "dynamic",
    once: Boolean(config.once),
    intervalSec: config.intervalSec ?? null,
    intervalLabel: config.intervalLabel ?? null,
    stateMode: config.stateMode ?? "fresh",
    resetEvery: config.resetEvery ?? null,
    maxIterations: config.maxIterations,
    maxDurationSec: config.maxDurationSec ?? null,
    maxTokens: config.maxTokens ?? null,
    maxRetries: config.maxRetries ?? 3,
    maxErrors: config.maxErrors ?? 3,
    model: activeModel ?? config.model ?? null,
    effort: config.effort ?? null,
    fallbackModel: fallbackModel ?? config.fallbackModel ?? null,
    verifierModel: verifierModel ?? config.verifierModel ?? null,
    mode: config.mode ?? null,
    sandbox: Boolean(config.sandbox),
    dangerouslySkipPermissions: Boolean(config.dangerouslySkipPermissions),
    allowSlashCommands: Boolean(config.allowSlashCommands),
    addDirs: Array.isArray(resolvedAddDirs) ? [...resolvedAddDirs] : [],
    worktree: Boolean(config.worktree),
    keepWorktree: Boolean(config.keepWorktree),
    workspace: config.workspace ?? (config.worktree ? "branch" : "inherit"),
    turnTimeoutSec: config.turnTimeoutSec ?? 600,
    failOnDenied: Boolean(config.failOnDenied),
    verifyCmd: config.verifyCmd ?? null,
    verifyTimeoutSec: config.verifyTimeoutSec ?? 60,
    probeCmd: config.probeCmd ?? null,
    probeTimeoutSec: config.probeTimeoutSec ?? 60,
    probeUntilPass: Boolean(config.probeUntilPass),
    taskSource: config.taskSource ?? "loop_md_or_default",
    prompt: typeof config.prompt === "string" ? config.prompt : "",
    cwd: workspaceDir,
    profile: config.profile ?? null,
    profileFile: config.profileFile ?? null,
    profileName: config.profileName ?? null,
    profilePath: config.profilePath ?? null,
    singleton: config.singleton ?? "none",
    onConflict: config.onConflict ?? null,
    trustProfileCommands: Boolean(config.trustProfileCommands),
    relayOnWake: Boolean(config.relayOnWake),
    cron: config.cron ?? null,
    timezone: config.timezone ?? null,
    targets: Array.isArray(config.targets) ? [...config.targets] : [],
  };
}

function createIterationSnapshot({
  iteration,
  taskPrompt,
  nextHint,
  probeOutput,
  nudges,
  activeModel,
  createdAtMs,
}) {
  const frozenNudges = Object.freeze(
    nudges.map((n) =>
      Object.freeze({
        message: n.message,
        created_at: n.created_at ?? null,
        wake: Boolean(n.wake),
      })
    )
  );
  const snapshotHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        iteration,
        taskPrompt,
        nextHint,
        probeOutput,
        nudges: frozenNudges,
        activeModel,
      })
    )
    .digest("hex")
    .slice(0, 12);
  return Object.freeze({
    iteration,
    taskPrompt,
    nextHint,
    probeOutput,
    nudges: frozenNudges,
    activeModel,
    createdAtMs,
    snapshotHash,
  });
}

async function runPreIteration({
  stateRoot,
  loopId,
  iteration,
  config,
  workspaceDir,
  execCwd,
  homeDir,
  env,
  ac,
  nowMs,
  getElapsedSec,
  usageTotals,
  consecutiveErrors,
  nextHint,
  activeModel,
  warnedTruncated,
  lastStatus,
  pendingRelayNudges = [],
  stderr,
}) {
  if (ac.signal.aborted) {
    return {
      proceed: false,
      finalStatus: "stopped",
      exitReason: "signal",
      exitCode: EXIT_CODES.STOPPED,
      warnedTruncated,
    };
  }

  const claimed = claimInboxMessages(stateRoot, loopId);
  if (claimed.length > 0) {
    appendEvent(stateRoot, loopId, {
      event: "inbox_claim",
      iteration,
      count: claimed.length,
      types: claimed.map((m) => m.type),
      messages: claimed,
    });
  }

  const preStop = isStopRequested(stateRoot, loopId);
  if (claimed.some((m) => m.type === "stop") || preStop.requested) {
    return {
      proceed: false,
      finalStatus: "stopped",
      exitReason: "stop_requested",
      exitCode: EXIT_CODES.STOPPED,
      warnedTruncated,
    };
  }

  const claimedNudges = claimed
    .filter((m) => m.type === "nudge" && typeof m.message === "string" && m.message.trim())
    .map((m) => ({
      message: m.message.trim(),
      created_at: m.created_at ?? null,
      wake: Boolean(m.wake),
    }));
  const nudges = [...pendingRelayNudges, ...claimedNudges];
  if (pendingRelayNudges.length > 0) {
    pendingRelayNudges.length = 0;
  }

  const elapsedSec = getElapsedSec();
  const budget = checkBudgets({
    iteration,
    maxIterations: config.maxIterations,
    elapsedSec,
    maxDurationSec: config.maxDurationSec,
    usageTotals,
    maxTokens: config.maxTokens,
    consecutiveErrors,
    maxErrors: config.maxErrors,
  });
  if (budget.exceeded) {
    let exitCode;
    if (budget.status === "circuit_broken") {
      exitCode = EXIT_CODES.ERROR;
    } else if (
      budget.exitReason === "max_iterations" &&
      config.once &&
      lastStatus === "CONTINUE"
    ) {
      exitCode = EXIT_CODES.DONE;
    } else {
      exitCode = EXIT_CODES.MAX_REACHED;
    }
    return {
      proceed: false,
      finalStatus: budget.status,
      exitReason: budget.exitReason,
      exitCode,
      warnedTruncated,
    };
  }

  let taskPrompt = config.prompt;
  let nextWarnedTruncated = warnedTruncated;
  if (
    config.taskSource === "loop_md_or_default" ||
    config.profile ||
    config.profileFile
  ) {
    const md = resolveProfileTask({
      workspaceDir,
      homeDir,
      profile: config.profile ?? null,
      file: config.profileFile ?? null,
    });
    taskPrompt = md.prompt;
    if (md.truncated && !nextWarnedTruncated) {
      nextWarnedTruncated = true;
      writeOut(
        stderr,
        `Warning: ${md.source} exceeded 25,000 bytes and was truncated.\n`
      );
    }
  }

  let probeOutput = null;
  if (config.probeCmd) {
    const probeRes = await runProbeCommand(config.probeCmd, {
      cwd: execCwd,
      env,
      timeoutSec: config.probeTimeoutSec,
      signal: ac.signal,
    });
    if (probeRes.aborted) {
      return {
        proceed: false,
        finalStatus: "stopped",
        exitReason: "signal",
        exitCode: EXIT_CODES.STOPPED,
        warnedTruncated: nextWarnedTruncated,
      };
    }
    if (config.probeUntilPass && probeRes.exitCode === 0 && !probeRes.timedOut) {
      return {
        proceed: false,
        probePassed: true,
        warnedTruncated: nextWarnedTruncated,
      };
    }
    const probeHeader = probeRes.timedOut
      ? `[probe timed out after ${config.probeTimeoutSec}s]`
      : `[probe exited ${probeRes.exitCode}]`;
    probeOutput = probeRes.outputTail
      ? capUtf8Tail(`${probeHeader}\n${probeRes.outputTail}`, MAX_PROBE_TAIL_BYTES)
      : probeHeader;
  }

  const snapshot = createIterationSnapshot({
    iteration,
    taskPrompt,
    nextHint,
    probeOutput,
    nudges,
    activeModel,
    createdAtMs: nowMs(),
  });

  return {
    proceed: true,
    snapshot,
    warnedTruncated: nextWarnedTruncated,
  };
}

async function runTwoStageGate({
  config,
  verifierModel,
  stateRoot,
  loopId,
  iteration,
  snapshot,
  iterData,
  execCwd,
  worktreeInfo,
  resolvedSettingsArg,
  resolvedAddDirs,
  ac,
  agyBin,
  env,
  isolateSessionEnv,
  outerTimeoutMs,
  getElapsedSec,
  usageTotals,
  verifierSchemaPath,
}) {
  let nextUsageTotals = usageTotals;
  let verifyCmdSummary = null;
  let stickyBudgetTerminal = null;
  let verifierTerminalOverride = null;

  // Stage 1: Deterministic 0-token `--verify-cmd`.
  if (iterData.loop_status === "DONE" && config.verifyCmd) {
    if (config.maxDurationSec != null && getElapsedSec() >= config.maxDurationSec) {
      appendEvent(stateRoot, loopId, {
        event: "verify_cmd",
        iteration,
        cmd: config.verifyCmd,
        passed: null,
        skipped_due_to_budget: true,
        reason: "max_duration",
      });
      iterData.loop_status = "CONTINUE";
      iterData.summary = `${iterData.summary} (unverified: max_duration)`;
      stickyBudgetTerminal = {
        finalStatus: "max_reached",
        exitReason: "max_duration",
        exitCode: EXIT_CODES.MAX_REACHED,
      };
      return {
        aborted: false,
        stickyBudgetTerminal,
        verifierTerminalOverride,
        usageTotals: nextUsageTotals,
      };
    }

    const verifyTimeoutSec = config.verifyTimeoutSec ?? 60;
    const verifyRes = await runProbeCommand(config.verifyCmd, {
      cwd: execCwd,
      env,
      timeoutSec: verifyTimeoutSec,
      signal: ac.signal,
    });
    if (verifyRes.aborted) {
      return {
        aborted: true,
        stickyBudgetTerminal: null,
        verifierTerminalOverride: null,
        usageTotals: nextUsageTotals,
      };
    }

    const passed = !verifyRes.timedOut && verifyRes.exitCode === 0;
    const outputTail = capUtf8Tail(verifyRes.outputTail || "", MAX_PROBE_TAIL_BYTES);
    appendEvent(stateRoot, loopId, {
      event: "verify_cmd",
      iteration,
      cmd: config.verifyCmd,
      passed,
      exit_code: verifyRes.exitCode,
      timed_out: Boolean(verifyRes.timedOut),
      output_tail: outputTail,
    });

    if (passed) {
      verifyCmdSummary = `Passed (exit 0): ${config.verifyCmd}${outputTail ? `\n${outputTail}` : ""}`;
    } else {
      const failDetail = verifyRes.timedOut
        ? `verify_cmd timed out after ${verifyTimeoutSec}s`
        : `verify_cmd exited ${verifyRes.exitCode}`;
      const tailSnippet = outputTail ? `\n${outputTail}` : "";

      const durHit = config.maxDurationSec != null && getElapsedSec() >= config.maxDurationSec;
      const tokHit =
        config.maxTokens != null && nextUsageTotals.total_tokens >= config.maxTokens;
      if (durHit || tokHit) {
        const reasonKey = durHit ? "max_duration" : "max_tokens";
        iterData.loop_status = "CONTINUE";
        iterData.summary = `${iterData.summary} (verify_cmd failed; ${reasonKey})`;
        iterData.next_hint = `Stage 1 verify_cmd failed (${failDetail})${tailSnippet}`;
        stickyBudgetTerminal = {
          finalStatus: "max_reached",
          exitReason: reasonKey,
          exitCode: EXIT_CODES.MAX_REACHED,
        };
      } else if (iteration < config.maxIterations) {
        iterData.loop_status = "CONTINUE";
        iterData.next_hint = `Stage 1 verify_cmd failed (${failDetail}); fix and re-verify.${tailSnippet}`;
        iterData.summary = `${iterData.summary} (verify_cmd failed)`;
        iterData.next_delay_sec = Math.max(
          10,
          Math.min(60, iterData.next_delay_sec || 30)
        );
      } else {
        iterData.loop_status = "BLOCKED";
        iterData.next_delay_sec = 0;
        iterData.next_hint = `Stage 1 verify_cmd failed (${failDetail})${tailSnippet}`;
        iterData.summary = `${iterData.summary} (verify_cmd failed)`;
        verifierTerminalOverride = {
          finalStatus: "blocked",
          exitReason: "verify_cmd_failed",
          exitCode: EXIT_CODES.BLOCKED,
        };
      }
      return {
        aborted: false,
        stickyBudgetTerminal,
        verifierTerminalOverride,
        usageTotals: nextUsageTotals,
      };
    }
  }

  // Stage 2: Independent read-only LLM verifier gate (with sticky hard-budget guard).
  if (iterData.loop_status === "DONE" && verifierModel) {
    const durHit = config.maxDurationSec != null && getElapsedSec() >= config.maxDurationSec;
    const tokHit =
      config.maxTokens != null && nextUsageTotals.total_tokens >= config.maxTokens;
    if (durHit || tokHit) {
      const reasonKey = durHit ? "max_duration" : "max_tokens";
      appendEvent(stateRoot, loopId, {
        event: "verifier",
        iteration,
        model: verifierModel,
        valid: false,
        passed: null,
        skipped_due_to_budget: true,
        unverified_due_to_budget: true,
        summary: `Verifier skipped due to ${reasonKey} budget exhaustion`,
        issues: [],
        usage_delta: { ...EMPTY_USAGE },
      });
      iterData.loop_status = "CONTINUE";
      iterData.summary = `${iterData.summary} (unverified: ${reasonKey})`;
      stickyBudgetTerminal = {
        finalStatus: "max_reached",
        exitReason: reasonKey,
        exitCode: EXIT_CODES.MAX_REACHED,
      };
      return {
        aborted: false,
        stickyBudgetTerminal,
        verifierTerminalOverride,
        usageTotals: nextUsageTotals,
      };
    }

    const { gitStatus, diffStat } = gatherVerifierGitContext({
      execCwd,
      worktreeInfo,
      worktreeBaseSha: worktreeInfo?.baseSha ?? null,
      env,
    });
    const verifierPrompt = buildVerifierPrompt({
      iteration,
      taskPrompt: snapshot.taskPrompt,
      workerSummary: iterData.summary,
      verifyCmdSummary,
      gitStatus,
      diffStat,
    });
    const verifierTurn = await runJsonTurn({
      prompt: verifierPrompt,
      cwd: execCwd,
      schemaPath: verifierSchemaPath,
      turnTimeoutSec: config.turnTimeoutSec,
      model: verifierModel,
      effort: config.effort,
      mode: "auto",
      sandbox: true,
      dangerouslySkipPermissions: false,
      allowSlashCommands: false,
      settingsArg: resolvedSettingsArg,
      addDirs: resolvedAddDirs,
      signal: ac.signal,
      agyBin,
      env,
      isolateSessionEnv,
      outerTimeoutMs,
    });

    nextUsageTotals = addUsageTotals(nextUsageTotals, verifierTurn.usageDelta);

    if (verifierTurn.aborted) {
      return {
        aborted: true,
        stickyBudgetTerminal: null,
        verifierTerminalOverride: null,
        usageTotals: nextUsageTotals,
      };
    }

    const verifierOutcome =
      verifierTurn.exitCode === 0 &&
      !verifierTurn.timedOut &&
      verifierTurn.result?.status !== "ERROR"
        ? extractVerifierOutcome(verifierTurn.result)
        : {
            valid: false,
            reason: verifierTurn.timedOut
              ? `Verifier timed out after ${config.turnTimeoutSec}s`
              : verifierTurn.result?.error
                ? String(verifierTurn.result.error)
                : `Verifier exited with code ${verifierTurn.exitCode}`,
          };

    appendEvent(stateRoot, loopId, {
      event: "verifier",
      iteration,
      model: verifierModel,
      valid: verifierOutcome.valid,
      passed: verifierOutcome.valid ? verifierOutcome.data.passed : null,
      summary: verifierOutcome.valid
        ? verifierOutcome.data.summary
        : verifierOutcome.reason,
      issues: verifierOutcome.valid ? verifierOutcome.data.issues : [],
      usage_delta: verifierTurn.usageDelta,
    });

    if (verifierOutcome.valid && verifierOutcome.data.passed === false) {
      const issues =
        verifierOutcome.data.issues.length > 0
          ? verifierOutcome.data.issues
          : [verifierOutcome.data.summary];
      if (iteration < config.maxIterations) {
        iterData.loop_status = "CONTINUE";
        iterData.next_hint = `Verifier rejected DONE: ${issues.join("; ")}`;
        iterData.summary = `${iterData.summary} (verifier rejected)`;
        iterData.next_delay_sec = Math.max(
          10,
          Math.min(60, iterData.next_delay_sec || 30)
        );
      } else {
        iterData.loop_status = "BLOCKED";
        iterData.next_delay_sec = 0;
        iterData.next_hint = `Verifier rejected DONE: ${issues.join("; ")}`;
        iterData.summary = `${iterData.summary} (verifier rejected)`;
        verifierTerminalOverride = {
          finalStatus: "blocked",
          exitReason: "verifier_rejected",
          exitCode: EXIT_CODES.BLOCKED,
        };
      }
    } else if (!verifierOutcome.valid) {
      if (iteration < config.maxIterations) {
        iterData.loop_status = "CONTINUE";
        iterData.next_hint = `Verifier error (${verifierOutcome.reason}); re-verify and confirm completion.`;
        iterData.summary = `${iterData.summary} (verifier error)`;
        iterData.next_delay_sec = Math.max(
          10,
          Math.min(60, iterData.next_delay_sec || 30)
        );
      } else {
        iterData.loop_status = "BLOCKED";
        iterData.next_delay_sec = 0;
        iterData.next_hint = `Verifier error: ${verifierOutcome.reason}`;
        iterData.summary = `${iterData.summary} (verifier error)`;
        verifierTerminalOverride = {
          finalStatus: "blocked",
          exitReason: "verifier_error",
          exitCode: EXIT_CODES.ERROR,
        };
      }
    }
  }

  return {
    aborted: false,
    stickyBudgetTerminal,
    verifierTerminalOverride,
    usageTotals: nextUsageTotals,
  };
}

/**
 * Executes the headless loop state machine for `agy-loop run`.
 *
 * @param {object} config Parsed configuration from `parseRunArgs`
 * @param {object} [ioOpts] Injectable I/O, environment, clock, and signal hooks
 * @returns {Promise<{ exitCode: number, state: object | null, worktreeResult: object | null }>}
 */
export async function runHeadlessLoop(config, ioOpts = {}) {
  return executeHeadlessLoop(config, ioOpts, ioOpts.resumeContext ?? null);
}

async function executeHeadlessLoop(rawConfig, ioOpts = {}, resumeContext = null) {
  const stdout = ioOpts.stdout ?? process.stdout;
  const stderr = ioOpts.stderr ?? process.stderr;
  const env = ioOpts.env ?? process.env;
  const agyBin = ioOpts.agyBin ?? "agy";
  const sleepFn = ioOpts.sleepFn ?? null;
  const rng = ioOpts.rng ?? Math.random;
  const externalSignal = ioOpts.signal ?? null;
  const isolateSessionEnv = Boolean(ioOpts.isolateSessionEnv);
  const outerTimeoutMs = ioOpts.outerTimeoutMs ?? null;
  const pollMs = ioOpts.pollMs ?? 500;
  const nowMs = ioOpts.nowMs ?? Date.now;
  const registerSignals = ioOpts.registerSignals !== false;

  const workspaceDir = path.resolve(rawConfig.cwd || process.cwd());
  let wsStat;
  try {
    wsStat = fs.statSync(workspaceDir);
  } catch {
    wsStat = null;
  }
  if (!wsStat || !wsStat.isDirectory()) {
    return emitStartupError({
      config: rawConfig,
      exitCode: EXIT_CODES.USAGE,
      error: `Workspace directory does not exist or is not a directory: ${workspaceDir}`,
      stdout,
      stderr,
    });
  }

  const homeDir = resolveHome(env);
  const stateRoot = resolveStateRoot(workspaceDir, env);
  const isResume = Boolean(resumeContext);

  let config = {
    ...rawConfig,
    singleton: rawConfig.singleton || "none",
  };

  if (!isResume) {
    if (
      rawConfig.taskSource === "loop_md_or_default" ||
      rawConfig.profile ||
      rawConfig.profileFile
    ) {
      let profileResult;
      try {
        profileResult = resolveProfileTask({
          workspaceDir,
          homeDir,
          profile: rawConfig.profile ?? null,
          file: rawConfig.profileFile ?? null,
        });
      } catch (err) {
        return emitStartupError({
          config: rawConfig,
          exitCode: EXIT_CODES.USAGE,
          error: err instanceof Error ? err.message : String(err),
          stdout,
          stderr,
        });
      }

      const merged = mergeProfileWithCli(rawConfig, profileResult, {
        explicitFlags:
          rawConfig.explicitFlags instanceof Set ? rawConfig.explicitFlags : new Set(),
        trustProfileCommands: Boolean(rawConfig.trustProfileCommands),
      });
      if (!merged.ok) {
        return emitStartupError({
          config: rawConfig,
          exitCode: merged.exitCode || EXIT_CODES.USAGE,
          error: merged.error,
          stdout,
          stderr,
        });
      }
      config = merged.config;
    }
  } else if (rawConfig.profile || rawConfig.profileFile) {
    try {
      resolveProfileTask({
        workspaceDir,
        homeDir,
        profile: rawConfig.profile ?? null,
        file: rawConfig.profileFile ?? null,
      });
    } catch (err) {
      return emitStartupError({
        config: rawConfig,
        exitCode: EXIT_CODES.USAGE,
        error: err instanceof Error ? err.message : String(err),
        stdout,
        stderr,
      });
    }
  }

  const agyProbe = probeAgyBinary(agyBin, env);
  if (!agyProbe.ok) {
    return emitStartupError({
      config,
      exitCode: EXIT_CODES.ERROR,
      error: agyProbe.error,
      stdout,
      stderr,
    });
  }

  const modelCheck = resolveConfiguredModels(config, { agyBin, env });
  if (!modelCheck.ok) {
    return emitStartupError({
      config,
      exitCode: EXIT_CODES.USAGE,
      error: modelCheck.error,
      stdout,
      stderr,
    });
  }

  const loopId = isResume ? resumeContext.loopId : generateLoopId(stateRoot);
  const lockScope = config.singleton || "none";
  let lockScopeKey = null;
  try {
    lockScopeKey = computeLockScope({
      singleton: lockScope,
      workspaceDir,
      profileName: config.profileName ?? null,
    });
  } catch (err) {
    return emitStartupError({
      config,
      exitCode: EXIT_CODES.USAGE,
      error: err instanceof Error ? err.message : String(err),
      stdout,
      stderr,
    });
  }

  let lockHandle = null;
  let stopHeartbeat = () => {};
  if (lockScopeKey) {
    const lockRes = await acquireLeaseLock({
      stateRoot,
      scope: lockScope,
      scopeKey: lockScopeKey,
      loopId,
      pid: process.pid,
      engine: "headless",
      profileName: config.profileName ?? null,
      workspaceDir,
      leaseTtlMs: ioOpts.leaseTtlMs ?? 60000,
      onConflict: config.onConflict || "fail",
      drainWaitMs: ioOpts.drainWaitMs ?? 3000,
    });

    if (!lockRes.acquired) {
      const activeLoopId = lockRes.holder?.loop_id ?? null;
      if (lockRes.action === "coalesced") {
        if (config.json) {
          writeOut(
            stdout,
            `${JSON.stringify(
              {
                ok: true,
                exit_code: EXIT_CODES.DONE,
                coalesced: true,
                active_loop_id: activeLoopId,
                scope: lockScope,
                scope_key: lockScopeKey,
              },
              null,
              2
            )}\n`
          );
        } else if (!config.quiet) {
          writeOut(
            stdout,
            `Coalesced into active loop ${activeLoopId || "(unknown)"} (scope=${lockScope}, key=${lockScopeKey}; wake queued)\n`
          );
        }
        return {
          exitCode: EXIT_CODES.DONE,
          state: null,
          worktreeResult: null,
          coalesced: true,
        };
      }

      if (lockRes.action === "skipped") {
        if (config.json) {
          writeOut(
            stdout,
            `${JSON.stringify(
              {
                ok: true,
                exit_code: EXIT_CODES.DONE,
                skipped: true,
                active_loop_id: activeLoopId,
                scope: lockScope,
                scope_key: lockScopeKey,
              },
              null,
              2
            )}\n`
          );
        } else if (!config.quiet) {
          writeOut(
            stdout,
            `Skipped: active loop ${activeLoopId || "(unknown)"} already holds lock (scope=${lockScope}, key=${lockScopeKey})\n`
          );
        }
        return {
          exitCode: EXIT_CODES.DONE,
          state: null,
          worktreeResult: null,
          skipped: true,
        };
      }

      const holder = lockRes.holder || null;
      const holderDesc = holder
        ? `loop_id=${holder.loop_id || "unknown"}, pid=${holder.pid ?? "unknown"}, profile=${holder.profile || "default"}`
        : "unknown holder";
      const conflictMsg =
        lockRes.error ||
        `Lock conflict (${lockScope} scope ${lockScopeKey}): active loop already running (${holderDesc}). Use --on-conflict wake|skip or --singleton none.`;
      if (config.json) {
        writeOut(
          stdout,
          `${JSON.stringify(
            {
              ok: false,
              exit_code: EXIT_CODES.LOCK_CONFLICT,
              error: conflictMsg,
              conflict: true,
              scope: lockScope,
              scope_key: lockScopeKey,
              holder: holder
                ? {
                    loop_id: holder.loop_id ?? null,
                    pid: holder.pid ?? null,
                    profile: holder.profile ?? null,
                    engine: holder.engine ?? null,
                    workspace_dir: holder.workspace_dir ?? null,
                  }
                : null,
            },
            null,
            2
          )}\n`
        );
      }
      writeOut(stderr, `Error: ${conflictMsg}\n`);
      return { exitCode: EXIT_CODES.LOCK_CONFLICT, state: null, worktreeResult: null };
    }

    lockHandle = lockRes.handle;
    stopHeartbeat = startLeaseHeartbeat(lockHandle);
  }

  try {
    ensureStateRoot(stateRoot);
    const loopDir = getLoopDir(stateRoot, loopId);
    const { iterSchemaPath, verifierSchemaPath } = writeSchemaFiles(loopDir);

    let worktreeInfo = isResume ? resumeContext.worktreeInfo : null;
    if (!isResume && config.worktree) {
      try {
        worktreeInfo = createHeadlessWorktree({ workspaceDir, stateRoot, loopId, env });
      } catch (err) {
        try {
          fs.rmSync(loopDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup failure for aborted initialization.
        }
        const msg = err instanceof Error ? err.message : String(err);
        const isUsagePrecondition =
          /not a git repository|unborn HEAD/i.test(msg);
        return emitStartupError({
          config,
          exitCode: isUsagePrecondition ? EXIT_CODES.USAGE : EXIT_CODES.ERROR,
          error: msg,
          stdout,
          stderr,
        });
      }
    }

    const execCwd = worktreeInfo ? worktreeInfo.worktreePath : workspaceDir;
    const worktreeBranch = worktreeInfo ? worktreeInfo.branch : null;
    const { resolvedAddDirs, resolvedSettingsArg } = resolveRunFilePaths(
      workspaceDir,
      config.addDirs,
      config.settingsArg
    );
    const startMs = nowMs();
    const priorElapsedSec = isResume ? resumeContext.priorElapsedSec || 0 : 0;
    let lastRecordedElapsedSec = priorElapsedSec;
    const getElapsedSec = () => {
      const active = priorElapsedSec + Math.max(0, (nowMs() - startMs) / 1000);
      const rounded = Number(active.toFixed(6));
      lastRecordedElapsedSec = rounded;
      return rounded;
    };
    const getElapsedSecSafe = () => {
      try {
        return getElapsedSec();
      } catch {
        return lastRecordedElapsedSec;
      }
    };
    const startedAtIso = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z");

    let activeModel = modelCheck.primaryModel;
    const fallbackModel = modelCheck.fallbackModel;
    const verifierModel = modelCheck.verifierModel;
    let alreadyOnFallback = isResume
      ? Boolean(resumeContext.alreadyOnFallback)
      : false;

    let iteration = isResume ? resumeContext.resumeIteration : 1;
    let consecutiveErrors = 0;
    let usageTotals = isResume
      ? normalizeUsage(resumeContext.usageTotals)
      : { ...EMPTY_USAGE };
    let deniedActionsCount = isResume ? resumeContext.deniedActionsCount || 0 : 0;
    let savedConversationId = isResume ? resumeContext.savedConversationId || null : null;
    let streamSession = null;
    let lastStatus = isResume ? resumeContext.lastStatus ?? null : null;
    let lastDelaySec = isResume ? resumeContext.lastDelaySec ?? null : null;
    let lastSummary = isResume ? resumeContext.lastSummary ?? null : null;
    let nextHint = isResume ? resumeContext.nextHint || "None" : "None";
    let finalStatus = "error";
    let exitReason = "unhandled_exception";
    let exitCode = EXIT_CODES.ERROR;
    let terminalEventLogged = false;
    let warnedTruncated = false;
    let relayCount = isResume ? resumeContext.relayCount || 0 : 0;
    const pendingRelayNudges = [];

    const runConfigSnapshot = buildRunConfigSnapshot(config, {
      workspaceDir,
      resolvedAddDirs,
      activeModel,
      fallbackModel,
      verifierModel,
    });

    let currentState;
    if (isResume) {
      clearControlStop(stateRoot, loopId);
      if (resumeContext.orphanInFlightIteration != null) {
        appendEvent(stateRoot, loopId, {
          event: "iteration_end",
          iteration: resumeContext.orphanInFlightIteration,
          snapshot_hash: resumeContext.orphanSnapshotHash ?? null,
          outcome: "interrupted",
          duration_ms: 0,
          usage_delta: { ...EMPTY_USAGE },
        });
      }
      currentState = updateLoopState(
        stateRoot,
        loopId,
        {
          status: "running",
          pid: process.pid,
          iteration,
          max_iterations: config.maxIterations,
          consecutive_errors: 0,
          model: activeModel,
          active_model: activeModel,
          effort: config.effort ?? null,
          fallback_model: fallbackModel,
          verifier_model: verifierModel,
          max_duration_sec: config.maxDurationSec ?? null,
          max_tokens: config.maxTokens ?? null,
          verify_cmd: config.verifyCmd ?? null,
          verify_timeout_sec: config.verifyTimeoutSec ?? 60,
          stop_requested: false,
          stop_mode: null,
          finished_at: null,
          exit_reason: null,
          in_flight_iteration: null,
          in_flight_snapshot_hash: null,
          resumed_from_iteration: resumeContext.resumedFromIteration,
          resume_count: resumeContext.resumeCount,
          elapsed_sec: priorElapsedSec,
          profile_name: config.profileName ?? resumeContext.profileName ?? null,
          profile_path: config.profilePath ?? resumeContext.profilePath ?? null,
          singleton: lockScope,
          lock_scope_key: lockScopeKey,
          relay_count: relayCount,
          run_config_snapshot: runConfigSnapshot,
        },
        {
          event: "resume",
          iteration,
          resumed_from_iteration: resumeContext.resumedFromIteration,
          previous_status: resumeContext.previousStatus,
          previous_exit_reason: resumeContext.previousExitReason,
          resume_count: resumeContext.resumeCount,
          model: activeModel,
          max_iterations: config.maxIterations,
          max_tokens: config.maxTokens ?? null,
          max_duration_sec: config.maxDurationSec ?? null,
        }
      );
    } else {
      currentState = createLoopState(stateRoot, {
        loop_id: loopId,
        status: "running",
        workspace_dir: workspaceDir,
        task_source: config.taskSource,
        inline_prompt: config.taskSource === "inline" ? config.prompt || "" : "",
        pacing: config.pacing,
        once: config.once,
        interval_sec: config.intervalSec,
        interval_label: config.intervalLabel,
        cron_expr: config.cron ?? null,
        state_mode: config.stateMode,
        workspace: config.workspace,
        model: activeModel,
        iteration,
        max_iterations: config.maxIterations,
        engine: "headless",
        transport: config.stateMode === "stateful" ? "stream-json" : "json",
        pid: process.pid,
        active_model: activeModel,
        fallback_model: fallbackModel,
        verifier_model: verifierModel,
        effort: config.effort ?? null,
        mode: config.mode ?? null,
        sandbox: Boolean(config.sandbox),
        add_dirs: resolvedAddDirs,
        worktree_branch: worktreeBranch,
        worktree_path: worktreeInfo?.worktreePath ?? null,
        worktree_base_sha: worktreeInfo?.baseSha ?? null,
        probe_cmd: config.probeCmd ?? null,
        verify_cmd: config.verifyCmd ?? null,
        verify_timeout_sec: config.verifyTimeoutSec ?? 60,
        turn_timeout_sec: config.turnTimeoutSec ?? 600,
        max_duration_sec: config.maxDurationSec ?? null,
        max_tokens: config.maxTokens ?? null,
        started_at: startedAtIso,
        usage_totals: { ...EMPTY_USAGE },
        denied_actions_count: 0,
        in_flight_iteration: null,
        in_flight_snapshot_hash: null,
        targets: Array.isArray(config.targets) ? [...config.targets] : [],
        resumed_from_iteration: null,
        resume_count: 0,
        elapsed_sec: 0,
        profile_name: config.profileName ?? null,
        profile_path: config.profilePath ?? null,
        singleton: lockScope,
        lock_scope_key: lockScopeKey,
        relay_count: 0,
        run_config_snapshot: runConfigSnapshot,
      });
    }
    upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

    const ac = new AbortController();
    const onExternalAbort = () => ac.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        ac.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const onSigInt = () => ac.abort(new Error("SIGINT"));
    const onSigTerm = () => ac.abort(new Error("SIGTERM"));
    if (registerSignals) {
      process.on("SIGINT", onSigInt);
      process.on("SIGTERM", onSigTerm);
    }

    const closeStreamSession = async () => {
      if (!streamSession) return;
      const sess = streamSession;
      streamSession = null;
      try {
        await sess.close();
      } catch {
        // Ignore child shutdown errors during cleanup.
      }
    };

    let worktreeResult = null;

    const tryTerminalWakeRelay = () => {
      // Close the Gate 4 active->draining race window BEFORE checking inbox wake flags.
      if (lockHandle) {
        try {
          markLeaseDraining(lockHandle);
        } catch {
          // Ignore draining write errors before terminal transition.
        }
      }
      const relayEligible =
        !config.once &&
        !ac.signal.aborted &&
        !isStopRequested(stateRoot, loopId).requested &&
        (Boolean(config.relayOnWake) || Boolean(lockHandle));
      if (!relayEligible) {
        return "done";
      }
      const relayBudget = checkBudgets({
        iteration: iteration + 1,
        maxIterations: config.maxIterations,
        elapsedSec: getElapsedSec(),
        maxDurationSec: config.maxDurationSec,
        usageTotals,
        maxTokens: config.maxTokens,
        consecutiveErrors,
        maxErrors: config.maxErrors,
      });
      if (relayBudget.exceeded) {
        return "done";
      }
      if (!peekInboxFlags(stateRoot, loopId).wake) {
        return "done";
      }
      const relayClaimed = claimInboxMessages(stateRoot, loopId);
      if (relayClaimed.length === 0) {
        return "done";
      }

      let hasStop = false;
      let sawWake = false;
      let wakeReason = "wake_requested";
      for (const m of relayClaimed) {
        const msgType = typeof m?.type === "string" ? m.type.trim().toLowerCase() : "";
        if (msgType === "stop") {
          hasStop = true;
        } else if (msgType === "wake") {
          sawWake = true;
          if (typeof m.reason === "string" && m.reason.trim()) {
            wakeReason = m.reason.trim();
          }
        } else if (msgType === "nudge") {
          if (m.wake === true) {
            sawWake = true;
          }
          if (typeof m.message === "string" && m.message.trim()) {
            pendingRelayNudges.push({
              message: m.message.trim(),
              created_at: m.created_at ?? null,
              wake: Boolean(m.wake),
            });
          }
        }
      }

      if (hasStop) {
        return "stop";
      }
      if (!sawWake) {
        return "done";
      }

      if (lockHandle) {
        try {
          unmarkLeaseDraining(lockHandle);
        } catch {
          // Ignore unmark draining failure; heartbeat timer remains active.
        }
      }

      const prevIter = iteration;
      relayCount += 1;
      iteration += 1;
      finalStatus = "error";
      exitReason = "unhandled_exception";
      exitCode = EXIT_CODES.ERROR;
      terminalEventLogged = false;
      nextHint =
        "New wake trigger arrived as previous iteration finished DONE; re-check workspace and handle any new work.";
      currentState = updateLoopState(
        stateRoot,
        loopId,
        {
          status: "running",
          iteration,
          relay_count: relayCount,
          exit_reason: null,
          next_hint: nextHint,
        },
        {
          event: "relay",
          iteration: prevIter,
          next_iteration: iteration,
          relay_count: relayCount,
          reason: wakeReason,
          claimed_count: relayClaimed.length,
        }
      );
      upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
      if (!config.quiet && !config.json) {
        writeOut(
          stdout,
          `[${loopId}] Relaying wake trigger (#${relayCount}) into iteration #${iteration}/${config.maxIterations}\n`
        );
      }
      return "relayed";
    };

    try {
      // Delayed one-shot mode (`agy-loop run in 20m ...` / `--once 5m ...`).
      if (!isResume && config.once && config.intervalSec != null && config.intervalSec > 0) {
        let waitSec = config.intervalSec;
        if (config.maxDurationSec != null) {
          waitSec = Math.max(0, Math.min(waitSec, config.maxDurationSec - getElapsedSec()));
        }
        if (!config.quiet && !config.json && waitSec > 0) {
          writeOut(
            stdout,
            `[${loopId}] Delayed one-shot: waiting ${formatDuration(waitSec)} before execution...\n`
          );
        }
        const delayedSleep = await sleepInterruptible(waitSec, {
          stateRoot,
          loopId,
          signal: ac.signal,
          pollMs,
          sleepFn,
        });
        if (delayedSleep.interrupted && delayedSleep.reason !== "wake_requested") {
          finalStatus = "stopped";
          exitReason =
            delayedSleep.reason === "stop_requested" ? "stop_requested" : "signal";
          exitCode = EXIT_CODES.STOPPED;
        }
      }

      if (ac.signal.aborted && exitCode !== EXIT_CODES.STOPPED) {
        finalStatus = "stopped";
        exitReason = "signal";
        exitCode = EXIT_CODES.STOPPED;
      } else if (!ac.signal.aborted && exitCode !== EXIT_CODES.STOPPED) {
        while (true) {
          // 1-4. preIteration: claim inbox, check stop & budgets, hot-reload loop.md, --probe, freeze snapshot.
          const pre = await runPreIteration({
            stateRoot,
            loopId,
            iteration,
            config,
            workspaceDir,
            execCwd,
            homeDir,
            env,
            ac,
            nowMs,
            getElapsedSec,
            usageTotals,
            consecutiveErrors,
            nextHint,
            activeModel,
            warnedTruncated,
            lastStatus,
            pendingRelayNudges,
            stderr,
          });
        warnedTruncated = pre.warnedTruncated;

        if (!pre.proceed) {
          if (pre.probePassed) {
            lastStatus = "DONE";
            lastDelaySec = 0;
            lastSummary = "Probe passed (0 LLM tokens)";
            nextHint = "None";
            finalStatus = "done";
            exitReason = "probe_passed";
            exitCode = EXIT_CODES.DONE;
            terminalEventLogged = true;

            currentState = updateLoopState(
              stateRoot,
              loopId,
              {
                iteration,
                status: "done",
                last_status: "DONE",
                last_delay_sec: 0,
                last_summary: lastSummary,
                next_hint: "None",
              },
              {
                event: "probe_skip",
                last_status: "DONE",
                summary: lastSummary,
                probe_exit_code: 0,
                usage_delta: { ...EMPTY_USAGE },
              }
            );
            upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
            if (!config.quiet && !config.json) {
              writeOut(
                stdout,
                `[${loopId}] #${iteration}/${config.maxIterations} DONE (probe passed, 0 tok)\n`
              );
            }
            const relayOutcome = tryTerminalWakeRelay();
            if (relayOutcome === "relayed") {
              continue;
            }
            if (relayOutcome === "stop") {
              finalStatus = "stopped";
              exitReason = "stop_requested";
              exitCode = EXIT_CODES.STOPPED;
              terminalEventLogged = false;
            }
          } else {
            finalStatus = pre.finalStatus;
            exitReason = pre.exitReason;
            exitCode = pre.exitCode;
          }
          break;
        }

        const { snapshot } = pre;

        // 5. Mark in_flight_iteration + iteration_start, wrap turn body in per-iteration try/finally.
        const iterStartMs = nowMs();
        const iterStartUsage = { ...usageTotals };
        let iterOutcomeTag = "error";
        let loopAction = "continue"; // "break" | "continue"
        let wakeRequested = false;
        let nextIterDelaySec = 120;

        currentState = updateLoopState(
          stateRoot,
          loopId,
          {
            in_flight_iteration: iteration,
            in_flight_snapshot_hash: snapshot.snapshotHash,
          },
          {
            event: "iteration_start",
            iteration,
            snapshot_hash: snapshot.snapshotHash,
            model: activeModel,
            nudge_count: snapshot.nudges.length,
          }
        );
        upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

        try {
          // Handle `--reset-every` session rotation & dispatch turn with retries/fallback.
          let rotatedSession = false;
          if (
            config.stateMode === "stateful" &&
            config.resetEvery != null &&
            iteration > 1 &&
            (iteration - 1) % config.resetEvery === 0
          ) {
            await closeStreamSession();
            savedConversationId = null;
            rotatedSession = true;
            appendEvent(stateRoot, loopId, {
              event: "session_reset",
              iteration,
              reason: "reset_every",
            });
          }

          const effectiveNextHint = formatActionableSeedHint(
            snapshot.nextHint,
            lastSummary,
            rotatedSession
          );

          let retryAttempt = 1;
          let turnRes = null;
          let abortedDuringTurn = false;
          let fatalFailure = null;
          let blockedFailure = null;

          while (true) {
            if (ac.signal.aborted) {
              abortedDuringTurn = true;
              break;
            }
            if (retryAttempt > 1) {
              const retryStop = isStopRequested(stateRoot, loopId);
              if (retryStop.requested && retryStop.mode === "immediate") {
                abortedDuringTurn = true;
                break;
              }
            }

            const workerPrompt = buildWorkerPrompt({
              iteration,
              maxIterations: config.maxIterations,
              stateMode: config.stateMode,
              workspaceMode: config.workspace,
              pacing: config.pacing,
              nextHint: effectiveNextHint,
              taskPrompt: snapshot.taskPrompt,
              probeOutput: snapshot.probeOutput,
              worktreeBranch,
              nudges: snapshot.nudges,
            });

            if (config.stateMode === "fresh") {
              turnRes = await runJsonTurn({
                prompt: workerPrompt,
                cwd: execCwd,
                schemaPath: iterSchemaPath,
                turnTimeoutSec: config.turnTimeoutSec,
                model: activeModel,
                effort: config.effort,
                mode: config.mode,
                sandbox: config.sandbox,
                dangerouslySkipPermissions: config.dangerouslySkipPermissions,
                allowSlashCommands: config.allowSlashCommands,
                settingsArg: resolvedSettingsArg,
                addDirs: resolvedAddDirs,
                signal: ac.signal,
                agyBin,
                env,
                isolateSessionEnv,
                outerTimeoutMs,
              });
            } else {
              if (!streamSession || !streamSession.alive) {
                streamSession = new StreamSession({
                  agyBin,
                  cwd: execCwd,
                  env,
                  schemaPath: iterSchemaPath,
                  turnTimeoutSec: config.turnTimeoutSec,
                  model: activeModel,
                  effort: config.effort,
                  mode: config.mode,
                  sandbox: config.sandbox,
                  dangerouslySkipPermissions: config.dangerouslySkipPermissions,
                  allowSlashCommands: config.allowSlashCommands,
                  settingsArg: resolvedSettingsArg,
                  addDirs: resolvedAddDirs,
                  conversationId: savedConversationId,
                  isolateSessionEnv,
                  outerTimeoutMs,
                });
              }
              turnRes = await streamSession.sendTurn(workerPrompt, {
                signal: ac.signal,
              });
            }

            usageTotals = addUsageTotals(usageTotals, turnRes.usageDelta);
            const nextConvId =
              turnRes.result?.conversation_id ||
              streamSession?.conversationId ||
              savedConversationId;
            if (nextConvId) {
              savedConversationId = nextConvId;
            }

            if (turnRes.aborted) {
              abortedDuringTurn = true;
              break;
            }

            const isTurnFailure =
              turnRes.exitCode !== 0 ||
              turnRes.crashed ||
              Boolean(turnRes.timedOut) ||
              turnRes.result?.status === "ERROR" ||
              turnRes.result?.finished_reason === "print_timeout";

            if (!isTurnFailure) {
              break;
            }

            // Stream sessions exit on error/timeout or need respawn on fallback model change.
            await closeStreamSession();

            const decision = classifyTurnFailure({
              exitCode: turnRes.exitCode,
              timedOut: Boolean(turnRes.timedOut),
              result: turnRes.result,
              agyError: turnRes.agyError,
              rawStderr: turnRes.rawStderr,
              activeModel,
              fallbackModel,
              alreadyOnFallback,
              attempt: retryAttempt,
              maxRetries: config.maxRetries,
              rng,
            });

            if (decision.action === "fatal_config") {
              fatalFailure = decision;
              break;
            }

            if (decision.action === "switch_fallback") {
              const fromModel = activeModel;
              activeModel = decision.nextModel;
              alreadyOnFallback = true;
              currentState = updateLoopState(
                stateRoot,
                loopId,
                {
                  active_model: activeModel,
                  conversation_id: savedConversationId,
                  usage_totals: usageTotals,
                },
                {
                  event: "fallback",
                  from_model: fromModel,
                  to_model: activeModel,
                  delay_sec: decision.delaySec,
                  reason: decision.reason,
                }
              );
              upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
              if (!config.quiet && !config.json) {
                writeOut(
                  stderr,
                  `[${loopId}] #${iteration} switching to fallback model '${activeModel}' in ${decision.delaySec}s (${decision.reason})\n`
                );
              }
              const fbSleep = await sleepInterruptible(decision.delaySec, {
                stateRoot,
                loopId,
                signal: ac.signal,
                pollMs,
                sleepFn,
                stopOnAfterCurrent: false,
                wakeOnInbox: false,
              });
              if (fbSleep.interrupted) {
                abortedDuringTurn = true;
                break;
              }
              continue;
            }

            if (decision.action === "retry") {
              const currentAttempt = retryAttempt;
              retryAttempt += 1;
              appendEvent(stateRoot, loopId, {
                event: "retry",
                iteration,
                attempt: currentAttempt,
                max_retries: config.maxRetries,
                delay_sec: decision.delaySec,
                model: activeModel,
                reason: decision.reason,
              });
              if (!config.quiet && !config.json) {
                writeOut(
                  stderr,
                  `[${loopId}] #${iteration} turn failed (${decision.reason}); retry ${currentAttempt}/${config.maxRetries} in ${decision.delaySec}s\n`
                );
              }
              const retrySleep = await sleepInterruptible(decision.delaySec, {
                stateRoot,
                loopId,
                signal: ac.signal,
                pollMs,
                sleepFn,
                stopOnAfterCurrent: false,
                wakeOnInbox: false,
              });
              if (retrySleep.interrupted) {
                abortedDuringTurn = true;
                break;
              }
              continue;
            }

            blockedFailure = decision;
            break;
          }

          if (abortedDuringTurn) {
            finalStatus = "stopped";
            exitReason = isStopRequested(stateRoot, loopId).requested
              ? "stop_requested"
              : "signal";
            exitCode = EXIT_CODES.STOPPED;
            iterOutcomeTag = "stopped";
            loopAction = "break";
          } else if (fatalFailure) {
            finalStatus = "blocked";
            exitReason = "fatal_config";
            exitCode = fatalFailure.exitCode;
            lastSummary = fatalFailure.reason;
            terminalEventLogged = true;
            iterOutcomeTag = "fatal_config";
            loopAction = "break";
            currentState = updateLoopState(
              stateRoot,
              loopId,
              {
                iteration,
                status: "blocked",
                active_model: activeModel,
                conversation_id: savedConversationId,
                usage_totals: usageTotals,
                denied_actions_count: deniedActionsCount,
                last_summary: lastSummary,
                exit_reason: exitReason,
              },
              {
                event: "error",
                reason: fatalFailure.reason,
                exit_code: fatalFailure.exitCode,
                fatal: true,
              }
            );
            upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
            writeOut(
              stderr,
              `Error: Fatal agy invocation/config failure (exit ${fatalFailure.exitCode}): ${fatalFailure.reason}\n`
            );
          } else if (blockedFailure) {
            finalStatus = "blocked";
            exitReason = "turn_blocked";
            exitCode = EXIT_CODES.BLOCKED;
            lastSummary = blockedFailure.reason;
            terminalEventLogged = true;
            iterOutcomeTag = "blocked";
            loopAction = "break";
            currentState = updateLoopState(
              stateRoot,
              loopId,
              {
                iteration,
                status: "blocked",
                active_model: activeModel,
                conversation_id: savedConversationId,
                usage_totals: usageTotals,
                denied_actions_count: deniedActionsCount,
                last_summary: lastSummary,
                exit_reason: exitReason,
              },
              {
                event: "error",
                reason: blockedFailure.reason,
                blocked: true,
              }
            );
            upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
            if (!config.quiet && !config.json) {
              writeOut(
                stdout,
                `[${loopId}] #${iteration}/${config.maxIterations} BLOCKED: ${lastSummary}\n`
              );
            }
          } else {
            // 6. Inspect soft-denied headless actions.
            const deniedActions = Array.isArray(turnRes.result?.denied_actions)
              ? turnRes.result.denied_actions
              : [];
            let deniedBlocked = false;
            if (deniedActions.length > 0) {
              deniedActionsCount += deniedActions.length;
              const actionNames = summarizeDeniedActions(deniedActions);
              writeOut(
                stderr,
                `Warning: ${deniedActions.length} action(s) soft-denied in headless mode (${actionNames.join(", ")}). Remedy: pass --mode auto, --settings <path|json>, or --dangerously-skip-permissions.\n`
              );
              appendEvent(stateRoot, loopId, {
                event: "denied",
                iteration,
                count: deniedActions.length,
                actions: actionNames,
                denied_actions: deniedActions,
              });
              if (config.failOnDenied) {
                deniedBlocked = true;
                finalStatus = "blocked";
                exitReason = "denied_actions";
                exitCode = EXIT_CODES.BLOCKED;
                lastStatus = "BLOCKED";
                lastDelaySec = 0;
                lastSummary = `Blocked by ${deniedActions.length} denied action(s): ${actionNames.join(", ")}`;
                terminalEventLogged = true;
                iterOutcomeTag = "denied_blocked";
                loopAction = "break";
                currentState = updateLoopState(
                  stateRoot,
                  loopId,
                  {
                    iteration,
                    status: "blocked",
                    active_model: activeModel,
                    conversation_id: savedConversationId,
                    usage_totals: usageTotals,
                    denied_actions_count: deniedActionsCount,
                    last_status: "BLOCKED",
                    last_delay_sec: 0,
                    last_summary: lastSummary,
                    exit_reason: exitReason,
                  },
                  {
                    event: "error",
                    reason: lastSummary,
                    denied_actions_count: deniedActions.length,
                  }
                );
                upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
              }
            }

            if (!deniedBlocked) {
              // 7. Extract and validate iteration outcome.
              const outcome = extractIterationOutcome(
                turnRes.result,
                iteration,
                turnRes.sawFinishTool
              );

              if (!outcome.valid) {
                consecutiveErrors += 1;
                lastSummary = outcome.reason;
                iterOutcomeTag = "invalid_outcome";
                const nextIsCircuitBroken = consecutiveErrors >= config.maxErrors;
                const nextIsMax =
                  !nextIsCircuitBroken && iteration >= config.maxIterations;
                const errStateStatus = nextIsCircuitBroken
                  ? "circuit_broken"
                  : nextIsMax
                    ? config.once
                      ? "circuit_broken"
                      : "max_reached"
                    : "running";

                currentState = updateLoopState(
                  stateRoot,
                  loopId,
                  {
                    iteration,
                    status: errStateStatus,
                    consecutive_errors: consecutiveErrors,
                    active_model: activeModel,
                    conversation_id: savedConversationId,
                    usage_totals: usageTotals,
                    denied_actions_count: deniedActionsCount,
                    last_summary: outcome.reason,
                  },
                  {
                    event: "error",
                    reason: outcome.reason,
                    stale: Boolean(outcome.stale),
                    consecutive_errors: consecutiveErrors,
                    usage_delta: turnRes.usageDelta,
                  }
                );
                upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

                if (!config.quiet && !config.json) {
                  writeOut(
                    stderr,
                    `[${loopId}] #${iteration}/${config.maxIterations} invalid output (${consecutiveErrors}/${config.maxErrors}): ${outcome.reason}\n`
                  );
                }

                if (nextIsCircuitBroken) {
                  finalStatus = "circuit_broken";
                  exitReason = "consecutive_errors";
                  exitCode = EXIT_CODES.ERROR;
                  terminalEventLogged = true;
                  loopAction = "break";
                } else if (iteration >= config.maxIterations) {
                  finalStatus = config.once ? "circuit_broken" : "max_reached";
                  exitReason = config.once ? "invalid_outcome" : "max_iterations";
                  exitCode = config.once ? EXIT_CODES.ERROR : EXIT_CODES.MAX_REACHED;
                  terminalEventLogged = true;
                  loopAction = "break";
                } else {
                  const postErrBudget = checkBudgets({
                    iteration: iteration + 1,
                    maxIterations: config.maxIterations,
                    elapsedSec: getElapsedSec(),
                    maxDurationSec: config.maxDurationSec,
                    usageTotals,
                    maxTokens: config.maxTokens,
                    consecutiveErrors,
                    maxErrors: config.maxErrors,
                  });
                  if (postErrBudget.exceeded) {
                    finalStatus = postErrBudget.status;
                    exitReason = postErrBudget.exitReason;
                    exitCode =
                      postErrBudget.status === "circuit_broken"
                        ? EXIT_CODES.ERROR
                        : EXIT_CODES.MAX_REACHED;
                    loopAction = "break";
                  } else {
                    const errDelay = Math.min(30, config.intervalSec || 10);
                    nextHint = `Previous turn failed outcome contract (${outcome.reason}); return valid JSON matching schema with iteration=${iteration + 1}.`;
                    iteration += 1;
                    currentState = updateLoopState(stateRoot, loopId, {
                      iteration,
                      next_hint: nextHint,
                    });
                    upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

                    const postInboxErr = peekInboxFlags(stateRoot, loopId);
                    if (postInboxErr.wake) {
                      wakeRequested = true;
                      loopAction = "continue";
                    } else {
                      nextIterDelaySec = errDelay;
                      loopAction = "sleep_continue";
                    }
                  }
                }
              } else {
                consecutiveErrors = 0;
                const iterData = { ...outcome.data };

                // 8. Two-stage `turn-stopping` gate (`--verify-cmd` + `--verifier-model`) with sticky budget guard.
                const gate = await runTwoStageGate({
                  config,
                  verifierModel,
                  stateRoot,
                  loopId,
                  iteration,
                  snapshot,
                  iterData,
                  execCwd,
                  worktreeInfo,
                  resolvedSettingsArg,
                  resolvedAddDirs,
                  ac,
                  agyBin,
                  env,
                  isolateSessionEnv,
                  outerTimeoutMs,
                  getElapsedSec,
                  usageTotals,
                  verifierSchemaPath,
                });
                usageTotals = gate.usageTotals;

                if (gate.aborted) {
                  finalStatus = "stopped";
                  exitReason = "signal";
                  exitCode = EXIT_CODES.STOPPED;
                  iterOutcomeTag = "stopped";
                  loopAction = "break";
                } else {
                  const { stickyBudgetTerminal, verifierTerminalOverride } = gate;

                  // 9. Persist iteration state + event + progress output.
                  lastStatus = iterData.loop_status;
                  lastDelaySec = iterData.next_delay_sec;
                  lastSummary = iterData.summary;
                  nextHint = iterData.next_hint;
                  iterOutcomeTag = stickyBudgetTerminal
                    ? "max_reached"
                    : iterData.loop_status;

                  const persistedStatus = stickyBudgetTerminal
                    ? stickyBudgetTerminal.finalStatus
                    : iterData.loop_status === "DONE"
                      ? "done"
                      : iterData.loop_status === "BLOCKED"
                        ? "blocked"
                        : "running";

                  currentState = updateLoopState(
                    stateRoot,
                    loopId,
                    {
                      iteration,
                      status: persistedStatus,
                      consecutive_errors: consecutiveErrors,
                      active_model: activeModel,
                      conversation_id: savedConversationId,
                      last_status: lastStatus,
                      last_delay_sec: lastDelaySec,
                      last_summary: lastSummary,
                      next_hint: nextHint,
                      usage_totals: usageTotals,
                      denied_actions_count: deniedActionsCount,
                      elapsed_sec: getElapsedSecSafe(),
                    },
                    {
                      event: "iteration",
                      outcome_source: outcome.source,
                      last_status: lastStatus,
                      next_delay_sec: lastDelaySec,
                      summary: lastSummary,
                      next_hint: nextHint,
                      changed_files: iterData.changed_files || [],
                      model: activeModel,
                      usage_delta: turnRes.usageDelta,
                      denied_actions_count: deniedActions.length,
                    }
                  );
                  upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

                  if (!config.quiet && !config.json) {
                    const tokBadge =
                      turnRes.usageDelta.total_tokens > 0
                        ? ` (${formatTokens(turnRes.usageDelta.total_tokens)} tok)`
                        : "";
                    writeOut(
                      stdout,
                      `[${loopId}] #${iteration}/${config.maxIterations} ${lastStatus}${tokBadge}: ${lastSummary}\n`
                    );
                  }

                  // 10. Evaluate terminal states vs inter-iteration sleep.
                  if (stickyBudgetTerminal) {
                    finalStatus = stickyBudgetTerminal.finalStatus;
                    exitReason = stickyBudgetTerminal.exitReason;
                    exitCode = stickyBudgetTerminal.exitCode;
                    loopAction = "break";
                  } else if (iterData.loop_status === "DONE") {
                    const relayOutcome = tryTerminalWakeRelay();
                    if (relayOutcome === "relayed") {
                      wakeRequested = true;
                      loopAction = "continue";
                    } else if (relayOutcome === "stop") {
                      finalStatus = "stopped";
                      exitReason = "stop_requested";
                      exitCode = EXIT_CODES.STOPPED;
                      terminalEventLogged = false;
                      loopAction = "break";
                    } else {
                      finalStatus = "done";
                      exitReason = "done";
                      exitCode = EXIT_CODES.DONE;
                      terminalEventLogged = true;
                      loopAction = "break";
                    }
                  } else if (iterData.loop_status === "BLOCKED") {
                    finalStatus = verifierTerminalOverride?.finalStatus || "blocked";
                    exitReason =
                      verifierTerminalOverride?.exitReason || "worker_blocked";
                    exitCode =
                      verifierTerminalOverride?.exitCode ?? EXIT_CODES.BLOCKED;
                    terminalEventLogged = true;
                    loopAction = "break";
                  } else {
                    const postStop = isStopRequested(stateRoot, loopId);
                    if (ac.signal.aborted || postStop.requested) {
                      finalStatus = "stopped";
                      exitReason = ac.signal.aborted ? "signal" : "stop_requested";
                      exitCode = EXIT_CODES.STOPPED;
                      loopAction = "break";
                    } else {
                      const postElapsedSec = getElapsedSec();
                      if (
                        config.maxDurationSec != null &&
                        postElapsedSec >= config.maxDurationSec
                      ) {
                        finalStatus = "max_reached";
                        exitReason = "max_duration";
                        exitCode = EXIT_CODES.MAX_REACHED;
                        loopAction = "break";
                      } else if (
                        config.maxTokens != null &&
                        usageTotals.total_tokens >= config.maxTokens
                      ) {
                        finalStatus = "max_reached";
                        exitReason = "max_tokens";
                        exitCode = EXIT_CODES.MAX_REACHED;
                        loopAction = "break";
                      } else if (iteration >= config.maxIterations) {
                        finalStatus = "max_reached";
                        exitReason = "max_iterations";
                        exitCode =
                          config.once && lastStatus === "CONTINUE"
                            ? EXIT_CODES.DONE
                            : EXIT_CODES.MAX_REACHED;
                        loopAction = "break";
                      } else {
                        let delaySec =
                          config.pacing === "fixed"
                            ? config.intervalSec ?? 60
                            : Math.min(
                                86400,
                                Math.max(10, iterData.next_delay_sec || 120)
                              );

                        if (config.maxDurationSec != null) {
                          const remainingDuration = Math.max(
                            0.05,
                            config.maxDurationSec - postElapsedSec
                          );
                          delaySec = Math.min(delaySec, remainingDuration);
                        }

                        iteration += 1;
                        currentState = updateLoopState(stateRoot, loopId, {
                          iteration,
                        });
                        upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

                        const postInbox = peekInboxFlags(stateRoot, loopId);
                        if (postInbox.wake) {
                          wakeRequested = true;
                          loopAction = "continue";
                        } else {
                          nextIterDelaySec = delaySec;
                          loopAction = "sleep_continue";
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        } finally {
          const iterDurationMs = Math.max(0, Math.round(nowMs() - iterStartMs));
          const iterUsageDelta = computeUsageDelta(usageTotals, iterStartUsage).delta;
          try {
            currentState = updateLoopState(
              stateRoot,
              loopId,
              {
                in_flight_iteration: null,
                in_flight_snapshot_hash: null,
                elapsed_sec: getElapsedSecSafe(),
              },
              {
                event: "iteration_end",
                iteration: snapshot.iteration,
                snapshot_hash: snapshot.snapshotHash,
                outcome: iterOutcomeTag,
                duration_ms: iterDurationMs,
                usage_delta: iterUsageDelta,
              }
            );
            upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
          } catch {
            currentState = {
              ...currentState,
              in_flight_iteration: null,
              in_flight_snapshot_hash: null,
            };
          }
        }

        if (loopAction === "break") {
          break;
        }
        if (wakeRequested || loopAction === "continue") {
          continue;
        }

        const iterSleep = await sleepInterruptible(nextIterDelaySec, {
          stateRoot,
          loopId,
          signal: ac.signal,
          pollMs,
          sleepFn,
        });
        if (iterSleep.interrupted && iterSleep.reason !== "wake_requested") {
          finalStatus = "stopped";
          exitReason =
            iterSleep.reason === "stop_requested" ? "stop_requested" : "signal";
          exitCode = EXIT_CODES.STOPPED;
          break;
        }
      }
    }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      finalStatus = "error";
      exitReason = "unhandled_exception";
      exitCode = EXIT_CODES.ERROR;
      lastSummary = errMsg;
      terminalEventLogged = false;
      writeOut(stderr, `Error: Unhandled runner exception (${loopId}): ${errMsg}\n`);
    } finally {
      if (registerSignals) {
        process.off("SIGINT", onSigInt);
        process.off("SIGTERM", onSigTerm);
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }

      stopHeartbeat();
      if (lockHandle) {
        try {
          markLeaseDraining(lockHandle);
        } catch {
          // Ignore draining errors during finalization
        }
      }

      await closeStreamSession();

      if (worktreeInfo) {
        try {
          worktreeResult = finalizeHeadlessWorktree({
            workspaceDir,
            worktreePath: worktreeInfo.worktreePath,
            branch: worktreeInfo.branch,
            baseSha: worktreeInfo.baseSha,
            keepWorktree: Boolean(config.keepWorktree),
            env,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          writeOut(stderr, `Warning: Failed to finalize worktree: ${msg}\n`);
        }
      }

      const finishedAtIso = new Date(nowMs()).toISOString().replace(/\.\d{3}Z$/, "Z");
      const stopState = isStopRequested(stateRoot, loopId);
      const finalPatch = {
        status: finalStatus,
        finished_at: finishedAtIso,
        exit_reason: exitReason,
        active_model: activeModel,
        conversation_id: savedConversationId,
        usage_totals: usageTotals,
        denied_actions_count: deniedActionsCount,
        worktree_head_sha: worktreeResult?.headSha ?? currentState.worktree_head_sha ?? null,
        in_flight_iteration: null,
        in_flight_snapshot_hash: null,
        last_status: lastStatus,
        last_delay_sec: lastDelaySec,
        last_summary: lastSummary,
        next_hint: nextHint,
        elapsed_sec: getElapsedSecSafe(),
        relay_count: relayCount,
      };
      if (finalStatus === "stopped") {
        finalPatch.stop_requested = true;
        finalPatch.stop_mode = stopState.mode || currentState.stop_mode || "immediate";
      }

      const terminalEvent = terminalEventLogged
        ? null
        : {
            event: finalStatus === "stopped" ? "stop" : "finish",
            exit_reason: exitReason,
            exit_code: exitCode,
          };

      try {
        currentState = updateLoopState(stateRoot, loopId, finalPatch, terminalEvent);
        upsertGlobalIndex(currentState, stateRoot, { homeDir, env });
      } catch {
        // Preserve in-memory final snapshot if state directory became unwritable.
        currentState = { ...currentState, ...finalPatch };
      }

      if (lockHandle) {
        const handleToRelease = lockHandle;
        lockHandle = null;
        try {
          releaseLeaseLock(handleToRelease);
        } catch {
          // Ignore release failure if lock was already removed
        }
      }

      if (config.json) {
        const payload = buildFinalJsonPayload({
          state: currentState,
          stateRoot,
          exitCode,
          worktreeInfo,
          worktreeResult,
        });
        writeOut(stdout, `${JSON.stringify(payload, null, 2)}\n`);
      } else if (!config.quiet) {
        if (worktreeResult?.preserved) {
          writeOut(
            stdout,
            `==> Preserved worktree branch '${worktreeInfo.branch}' (${worktreeResult.aheadCount} commit(s), dirty=${worktreeResult.dirty}):\n` +
              `    Merge:   ${worktreeResult.mergeHint}\n` +
              `    Cleanup: ${worktreeResult.cleanupHint}\n`
          );
        }
        writeOut(
          stdout,
          `==> agy-loop ${loopId} finished: status=${currentState.status} (${exitReason}), iter=${currentState.iteration}/${currentState.max_iterations}, tokens=${formatTokens(usageTotals.total_tokens)}, exit=${exitCode}\n`
        );
      }
    }

    return { exitCode, state: currentState, worktreeResult };
  } finally {
    stopHeartbeat();
    if (lockHandle) {
      try {
        markLeaseDraining(lockHandle);
      } catch {
        // Ignore draining errors during early return
      }
      try {
        releaseLeaseLock(lockHandle);
      } catch {
        // Ignore release errors during early return
      }
    }
  }
}

function computePriorElapsedSec(prev) {
  if (
    typeof prev?.elapsed_sec === "number" &&
    Number.isFinite(prev.elapsed_sec) &&
    prev.elapsed_sec >= 0
  ) {
    return prev.elapsed_sec;
  }
  const usageDur =
    typeof prev?.usage_totals?.duration_seconds === "number" &&
    Number.isFinite(prev.usage_totals.duration_seconds) &&
    prev.usage_totals.duration_seconds > 0
      ? prev.usage_totals.duration_seconds
      : 0;
  let wallDur = 0;
  const startedMs = prev?.started_at ? Date.parse(prev.started_at) : Number.NaN;
  const endedIso = prev?.finished_at || prev?.updated_at;
  const endedMs = endedIso ? Date.parse(endedIso) : Number.NaN;
  if (!Number.isNaN(startedMs) && !Number.isNaN(endedMs) && endedMs >= startedMs) {
    wallDur = (endedMs - startedMs) / 1000;
  }
  return Math.max(usageDur, wallDur);
}

const COMPLETED_ITERATION_END_OUTCOMES = new Set([
  "DONE",
  "CONTINUE",
  "BLOCKED",
  "max_reached",
  "invalid_outcome",
  "denied_blocked",
]);

function determineResumeIteration(prev, events) {
  if (Number.isInteger(prev.in_flight_iteration) && prev.in_flight_iteration >= 1) {
    return prev.in_flight_iteration;
  }
  const hasIterEvents = events.some(
    (ev) => ev.event === "iteration" || ev.event === "iteration_end" || ev.event === "error"
  );
  if (!hasIterEvents) {
    return prev.last_status ? (prev.iteration || 1) + 1 : prev.iteration || 1;
  }
  if (prev.status === "blocked" && !prev.last_status) {
    return prev.iteration || 1;
  }
  const prevIterCompleted = events.some(
    (ev) =>
      ev.iteration === prev.iteration &&
      (ev.event === "iteration" ||
        (ev.event === "iteration_end" &&
          COMPLETED_ITERATION_END_OUTCOMES.has(ev.outcome)))
  );
  return prevIterCompleted ? (prev.iteration || 1) + 1 : prev.iteration || 1;
}

/**
 * Resumes an eligible non-running or stale headless loop from persisted `state.json` & `events.jsonl`.
 *
 * @param {string} loopQuery `loop_id`, prefix/suffix, or `"latest"`
 * @param {object} [overrides] Explicit budget/model/output overrides (`maxIterations`, `maxTokens`, `maxDurationSec`, `model`, `settingsArg`, `cwd`, `json`, `quiet`)
 * @param {object} [ioOpts] Injectable I/O, environment, clock, and signal hooks
 * @returns {Promise<{ exitCode: number, state: object | null, worktreeResult: object | null }>}
 */
export async function resumeHeadlessLoop(loopQuery, overrides = {}, ioOpts = {}) {
  const stdout = ioOpts.stdout ?? process.stdout;
  const stderr = ioOpts.stderr ?? process.stderr;
  const env = ioOpts.env ?? process.env;
  const json = Boolean(overrides.json);
  const workspaceDir = path.resolve(overrides.cwd || ioOpts.cwd || process.cwd());

  const failResume = (exitCode, error) =>
    emitStartupError({ config: { json }, exitCode, error, stdout, stderr });

  let wsStat;
  try {
    wsStat = fs.statSync(workspaceDir);
  } catch {
    wsStat = null;
  }
  if (!wsStat || !wsStat.isDirectory()) {
    return failResume(
      EXIT_CODES.USAGE,
      `Workspace directory does not exist or is not a directory: ${workspaceDir}`
    );
  }

  const stateRoot = resolveStateRoot(workspaceDir, env);
  const resolved = resolveLoopByIdOrPrefix(stateRoot, loopQuery, { includeAll: true });
  if (!resolved.ok) {
    return failResume(EXIT_CODES.USAGE, resolved.error);
  }

  const prev = resolved.loop;
  if (prev.engine !== "headless") {
    return failResume(
      EXIT_CODES.USAGE,
      `Loop ${prev.loop_id} uses engine '${prev.engine || "interactive"}'; only headless loops can be resumed via 'agy-loop resume'.`
    );
  }

  if (prev.status === "done") {
    return failResume(
      EXIT_CODES.USAGE,
      `Loop ${prev.loop_id} already finished with status 'done' and cannot be resumed.`
    );
  }

  if (prev.status === "running") {
    const alive = Number.isInteger(prev.pid) && prev.pid > 0 && isPidAlive(prev.pid);
    if (alive) {
      return failResume(
        EXIT_CODES.ERROR,
        `Loop ${prev.loop_id} is currently running (pid=${prev.pid}); stop it before resuming.`
      );
    }
  } else if (
    !["stopped", "max_reached", "blocked", "circuit_broken", "error"].includes(prev.status)
  ) {
    return failResume(
      EXIT_CODES.USAGE,
      `Loop ${prev.loop_id} has unsupported status '${prev.status}' for resume.`
    );
  }

  let worktreeInfo = null;
  if (prev.worktree_path) {
    let wtStat = null;
    try {
      wtStat = fs.statSync(prev.worktree_path);
    } catch {
      wtStat = null;
    }
    if (!wtStat || !wtStat.isDirectory()) {
      return failResume(
        EXIT_CODES.USAGE,
        `Cannot resume ${prev.loop_id}: existing worktree directory is missing at ${prev.worktree_path}`
      );
    }
    worktreeInfo = {
      worktreePath: prev.worktree_path,
      branch: prev.worktree_branch ?? `agy-loop/${prev.loop_id}`,
      baseSha: prev.worktree_base_sha ?? null,
      repoRoot: prev.workspace_dir || workspaceDir,
    };
  }

  const events = readEvents(stateRoot, prev.loop_id);
  const resumeIteration = determineResumeIteration(prev, events);
  const priorElapsedSec = computePriorElapsedSec(prev);
  const usedTokens = prev.usage_totals?.total_tokens ?? 0;

  if (prev.status === "max_reached") {
    const reason = prev.exit_reason;
    if (reason === "max_tokens") {
      const minTok = Math.max(usedTokens, prev.max_tokens ?? 0);
      if (overrides.maxTokens == null || overrides.maxTokens <= minTok) {
        return failResume(
          EXIT_CODES.USAGE,
          `Loop ${prev.loop_id} reached max_tokens (${usedTokens}/${prev.max_tokens ?? usedTokens}). Pass a higher '--max-tokens <N>' (> ${minTok}) to resume.`
        );
      }
    } else if (reason === "max_duration") {
      const minDur = Math.max(prev.max_duration_sec ?? 0, priorElapsedSec);
      if (overrides.maxDurationSec == null || overrides.maxDurationSec <= minDur) {
        return failResume(
          EXIT_CODES.USAGE,
          `Loop ${prev.loop_id} reached max_duration (${minDur}s). Pass a higher '--max-duration <dur>' (> ${formatDuration(Math.ceil(minDur))}) to resume.`
        );
      }
    } else {
      const prevMaxIter = prev.max_iterations ?? prev.iteration ?? 1;
      if (overrides.maxIterations == null || overrides.maxIterations <= prevMaxIter) {
        return failResume(
          EXIT_CODES.USAGE,
          `Loop ${prev.loop_id} reached max_iterations (${prevMaxIter}). Pass a higher '--max <N>' (> ${prevMaxIter}) to resume.`
        );
      }
    }
  }

  const snap = isPlainObject(prev.run_config_snapshot) ? prev.run_config_snapshot : {};
  const mergedMaxIterations =
    overrides.maxIterations != null
      ? overrides.maxIterations
      : snap.maxIterations ?? prev.max_iterations ?? 20;

  if (resumeIteration > mergedMaxIterations) {
    return failResume(
      EXIT_CODES.USAGE,
      `Cannot resume ${prev.loop_id} at iteration ${resumeIteration} with max_iterations=${mergedMaxIterations}; pass '--max <N>' (>= ${resumeIteration}).`
    );
  }

  const prevActiveModel = prev.active_model ?? prev.model ?? snap.model ?? null;
  const fallbackModel = snap.fallbackModel ?? prev.fallback_model ?? null;
  const effectiveModel =
    overrides.model !== undefined && overrides.model !== null
      ? overrides.model
      : prevActiveModel;

  const mergedConfig = {
    pacing: snap.pacing ?? prev.pacing ?? "dynamic",
    once: overrides.maxIterations != null && overrides.maxIterations > 1
      ? false
      : Boolean(snap.once ?? prev.once),
    intervalSec: snap.intervalSec ?? prev.interval_sec ?? null,
    intervalLabel: snap.intervalLabel ?? prev.interval_label ?? null,
    stateMode: snap.stateMode ?? prev.state_mode ?? "fresh",
    resetEvery: snap.resetEvery ?? null,
    maxIterations: mergedMaxIterations,
    maxDurationSec:
      overrides.maxDurationSec != null
        ? overrides.maxDurationSec
        : snap.maxDurationSec ?? prev.max_duration_sec ?? null,
    maxTokens:
      overrides.maxTokens != null
        ? overrides.maxTokens
        : snap.maxTokens ?? prev.max_tokens ?? null,
    maxRetries: snap.maxRetries ?? 3,
    maxErrors: snap.maxErrors ?? 3,
    model: effectiveModel,
    effort: snap.effort ?? prev.effort ?? null,
    fallbackModel,
    verifierModel: snap.verifierModel ?? prev.verifier_model ?? null,
    mode: snap.mode ?? prev.mode ?? null,
    sandbox: Boolean(snap.sandbox ?? prev.sandbox),
    dangerouslySkipPermissions: Boolean(snap.dangerouslySkipPermissions),
    allowSlashCommands: Boolean(snap.allowSlashCommands),
    settingsArg: overrides.settingsArg ?? null,
    addDirs: Array.isArray(snap.addDirs)
      ? snap.addDirs
      : Array.isArray(prev.add_dirs)
        ? prev.add_dirs
        : [],
    worktree: Boolean(worktreeInfo || snap.worktree),
    keepWorktree: Boolean(snap.keepWorktree),
    workspace:
      snap.workspace ?? prev.workspace ?? (worktreeInfo ? "branch" : "inherit"),
    turnTimeoutSec: snap.turnTimeoutSec ?? prev.turn_timeout_sec ?? 600,
    failOnDenied: Boolean(snap.failOnDenied),
    verifyCmd: snap.verifyCmd ?? prev.verify_cmd ?? null,
    verifyTimeoutSec: snap.verifyTimeoutSec ?? prev.verify_timeout_sec ?? 60,
    probeCmd: snap.probeCmd ?? prev.probe_cmd ?? null,
    probeTimeoutSec: snap.probeTimeoutSec ?? 60,
    probeUntilPass: Boolean(snap.probeUntilPass),
    taskSource: snap.taskSource ?? prev.task_source ?? "loop_md_or_default",
    prompt:
      typeof snap.prompt === "string"
        ? snap.prompt
        : typeof prev.inline_prompt === "string"
          ? prev.inline_prompt
          : "",
    cwd: prev.workspace_dir || snap.cwd || workspaceDir,
    profile: overrides.profile ?? snap.profile ?? null,
    profileFile: overrides.profileFile ?? snap.profileFile ?? null,
    profileName: snap.profileName ?? prev.profile_name ?? null,
    profilePath: snap.profilePath ?? prev.profile_path ?? null,
    singleton: overrides.singleton ?? snap.singleton ?? prev.singleton ?? "none",
    onConflict: overrides.onConflict ?? snap.onConflict ?? null,
    trustProfileCommands:
      overrides.trustProfileCommands !== undefined
        ? Boolean(overrides.trustProfileCommands)
        : Boolean(snap.trustProfileCommands),
    relayOnWake:
      overrides.relayOnWake !== undefined
        ? Boolean(overrides.relayOnWake)
        : Boolean(snap.relayOnWake),
    cron: snap.cron ?? prev.cron_expr ?? null,
    timezone: snap.timezone ?? null,
    targets: Array.isArray(snap.targets)
      ? snap.targets
      : Array.isArray(prev.targets)
        ? prev.targets
        : [],
    json,
    quiet: Boolean(overrides.quiet),
  };

  const resumeContext = {
    loopId: prev.loop_id,
    worktreeInfo,
    resumeIteration,
    orphanInFlightIteration:
      Number.isInteger(prev.in_flight_iteration) && prev.in_flight_iteration >= 1
        ? prev.in_flight_iteration
        : null,
    orphanSnapshotHash: prev.in_flight_snapshot_hash ?? null,
    savedConversationId: prev.conversation_id ?? null,
    usageTotals: prev.usage_totals ?? { ...EMPTY_USAGE },
    deniedActionsCount: prev.denied_actions_count ?? 0,
    lastStatus: prev.last_status ?? null,
    lastDelaySec: prev.last_delay_sec ?? null,
    lastSummary: prev.last_summary ?? null,
    nextHint: prev.next_hint || "None",
    resumedFromIteration: prev.iteration ?? resumeIteration,
    previousStatus: prev.status,
    previousExitReason: prev.exit_reason ?? null,
    resumeCount: (Number.isInteger(prev.resume_count) ? prev.resume_count : 0) + 1,
    alreadyOnFallback:
      overrides.model == null &&
      Boolean(fallbackModel && prevActiveModel && prevActiveModel === fallbackModel),
    priorElapsedSec,
    profileName: snap.profileName ?? prev.profile_name ?? null,
    profilePath: snap.profilePath ?? prev.profile_path ?? null,
    relayCount: Number.isInteger(prev.relay_count) ? prev.relay_count : 0,
  };

  return executeHeadlessLoop(mergedConfig, ioOpts, resumeContext);
}
