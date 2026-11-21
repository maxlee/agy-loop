/**
 * Headless loop runner state machine for `agy-loop run`.
 * Orchestrates `fresh` (json) and `--stateful` (stream-json) turns,
 * retries, fallback models, independent verification, probes, budgets, and worktrees.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { formatDuration, formatTokens } from "./duration.mjs";
import {
  EMPTY_USAGE,
  addUsageTotals,
  checkBudgets,
  classifyTurnFailure,
} from "./error-policy.mjs";
import {
  forceTerminateChild,
  runJsonTurn,
  schedulePipeCloseFallback,
} from "./json-client.mjs";
import { fetchModelCatalog, resolveModelSlug } from "./models.mjs";
import {
  buildVerifierPrompt,
  buildWorkerPrompt,
  extractIterationOutcome,
  extractVerifierOutcome,
  writeSchemaFiles,
} from "./schemas.mjs";
import {
  appendEvent,
  createLoopState,
  ensureStateRoot,
  generateLoopId,
  getLoopDir,
  isStopRequested,
  resolveHome,
  resolveLoopMdTask,
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
      return Promise.resolve(sleepFn(ms));
    }
    return new Promise((resolve) => {
      let done = false;
      const onAbort = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(sleepFn(ms)).then(
        () => {
          if (!done) {
            done = true;
            signal.removeEventListener("abort", onAbort);
            resolve();
          }
        },
        () => {
          if (!done) {
            done = true;
            signal.removeEventListener("abort", onAbort);
            resolve();
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
 * aborts or `isStopRequested(stateRoot, loopId)` is active.
 *
 * @param {number} sec
 * @param {object} [opts]
 * @returns {Promise<{ interrupted: boolean, reason: "signal" | "stop_requested" | null }>}
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

/**
 * Executes the headless loop state machine for `agy-loop run`.
 *
 * @param {object} config Parsed configuration from `parseRunArgs`
 * @param {object} [ioOpts] Injectable I/O, environment, clock, and signal hooks
 * @returns {Promise<{ exitCode: number, state: object | null, worktreeResult: object | null }>}
 */
export async function runHeadlessLoop(config, ioOpts = {}) {
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

  const workspaceDir = path.resolve(config.cwd || process.cwd());
  let wsStat;
  try {
    wsStat = fs.statSync(workspaceDir);
  } catch {
    wsStat = null;
  }
  if (!wsStat || !wsStat.isDirectory()) {
    return emitStartupError({
      config,
      exitCode: EXIT_CODES.USAGE,
      error: `Workspace directory does not exist or is not a directory: ${workspaceDir}`,
      stdout,
      stderr,
    });
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

  const homeDir = resolveHome(env);
  const stateRoot = resolveStateRoot(workspaceDir, env);
  ensureStateRoot(stateRoot);
  const loopId = generateLoopId(stateRoot);
  const loopDir = getLoopDir(stateRoot, loopId);
  const { iterSchemaPath, verifierSchemaPath } = writeSchemaFiles(loopDir);

  let worktreeInfo = null;
  if (config.worktree) {
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
  const startedAtIso = new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  let activeModel = modelCheck.primaryModel;
  const fallbackModel = modelCheck.fallbackModel;
  const verifierModel = modelCheck.verifierModel;
  let alreadyOnFallback = false;

  let iteration = 1;
  let consecutiveErrors = 0;
  let usageTotals = { ...EMPTY_USAGE };
  let deniedActionsCount = 0;
  let savedConversationId = null;
  let streamSession = null;
  let lastStatus = null;
  let lastDelaySec = null;
  let lastSummary = null;
  let nextHint = "None";
  let finalStatus = "done";
  let exitReason = "done";
  let exitCode = EXIT_CODES.DONE;
  let terminalEventLogged = false;
  let warnedTruncated = false;

  let currentState = createLoopState(stateRoot, {
    loop_id: loopId,
    status: "running",
    workspace_dir: workspaceDir,
    task_source: config.taskSource,
    inline_prompt: config.prompt || "",
    pacing: config.pacing,
    once: config.once,
    interval_sec: config.intervalSec,
    interval_label: config.intervalLabel,
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
    turn_timeout_sec: config.turnTimeoutSec ?? 600,
    max_duration_sec: config.maxDurationSec ?? null,
    max_tokens: config.maxTokens ?? null,
    started_at: startedAtIso,
    usage_totals: { ...EMPTY_USAGE },
    denied_actions_count: 0,
  });
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

  try {
    // Delayed one-shot mode (`agy-loop run in 20m ...` / `--once 5m ...`).
    if (config.once && config.intervalSec != null && config.intervalSec > 0) {
      if (!config.quiet && !config.json) {
        writeOut(
          stdout,
          `[${loopId}] Delayed one-shot: waiting ${formatDuration(config.intervalSec)} before execution...\n`
        );
      }
      const delayedSleep = await sleepInterruptible(config.intervalSec, {
        stateRoot,
        loopId,
        signal: ac.signal,
        pollMs,
        sleepFn,
      });
      if (delayedSleep.interrupted) {
        finalStatus = "stopped";
        exitReason =
          delayedSleep.reason === "stop_requested" ? "stop_requested" : "signal";
        exitCode = EXIT_CODES.STOPPED;
      }
    }

    if (!ac.signal.aborted && exitCode !== EXIT_CODES.STOPPED) {
      while (true) {
        // 1. Check abort signal & external stop request.
        if (ac.signal.aborted) {
          finalStatus = "stopped";
          exitReason = "signal";
          exitCode = EXIT_CODES.STOPPED;
          break;
        }
        const preStop = isStopRequested(stateRoot, loopId);
        if (preStop.requested) {
          finalStatus = "stopped";
          exitReason = "stop_requested";
          exitCode = EXIT_CODES.STOPPED;
          break;
        }

        // 2. Check budgets before launching iteration.
        const elapsedSec = Math.max(0, (nowMs() - startMs) / 1000);
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
          finalStatus = budget.status;
          exitReason = budget.exitReason;
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
          break;
        }

        // 3. Resolve task (live-reloading loop.md every iteration when omitted).
        let taskPrompt = config.prompt;
        if (config.taskSource === "loop_md_or_default") {
          const md = resolveLoopMdTask(workspaceDir, homeDir);
          taskPrompt = md.prompt;
          if (md.truncated && !warnedTruncated) {
            warnedTruncated = true;
            writeOut(
              stderr,
              `Warning: ${md.source} exceeded 25,000 bytes and was truncated.\n`
            );
          }
        }

        // 4. Optional shell pre-check `--probe`.
        let probeOutput = null;
        if (config.probeCmd) {
          const probeRes = await runProbeCommand(config.probeCmd, {
            cwd: execCwd,
            env,
            timeoutSec: config.probeTimeoutSec,
            signal: ac.signal,
          });
          if (probeRes.aborted) {
            finalStatus = "stopped";
            exitReason = "signal";
            exitCode = EXIT_CODES.STOPPED;
            break;
          }
          if (config.probeUntilPass && probeRes.exitCode === 0 && !probeRes.timedOut) {
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
            break;
          }
          const probeHeader = probeRes.timedOut
            ? `[probe timed out after ${config.probeTimeoutSec}s]`
            : `[probe exited ${probeRes.exitCode}]`;
          probeOutput = probeRes.outputTail
            ? capUtf8Tail(`${probeHeader}\n${probeRes.outputTail}`, MAX_PROBE_TAIL_BYTES)
            : probeHeader;
        }

        // 5. Handle `--reset-every` session rotation & dispatch turn with retries/fallback.
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
          nextHint,
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
            taskPrompt,
            probeOutput,
            worktreeBranch,
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
          break;
        }

        if (fatalFailure) {
          finalStatus = "blocked";
          exitReason = "fatal_config";
          exitCode = fatalFailure.exitCode;
          lastSummary = fatalFailure.reason;
          terminalEventLogged = true;
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
          break;
        }

        if (blockedFailure) {
          finalStatus = "blocked";
          exitReason = "turn_blocked";
          exitCode = EXIT_CODES.BLOCKED;
          lastSummary = blockedFailure.reason;
          terminalEventLogged = true;
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
          break;
        }

        // 6. Inspect soft-denied headless actions.
        const deniedActions = Array.isArray(turnRes.result?.denied_actions)
          ? turnRes.result.denied_actions
          : [];
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
            finalStatus = "blocked";
            exitReason = "denied_actions";
            exitCode = EXIT_CODES.BLOCKED;
            lastStatus = "BLOCKED";
            lastDelaySec = 0;
            lastSummary = `Blocked by ${deniedActions.length} denied action(s): ${actionNames.join(", ")}`;
            terminalEventLogged = true;
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
            break;
          }
        }

        // 7. Extract and validate iteration outcome.
        const outcome = extractIterationOutcome(
          turnRes.result,
          iteration,
          turnRes.sawFinishTool
        );

        if (!outcome.valid) {
          consecutiveErrors += 1;
          lastSummary = outcome.reason;
          const nextIsCircuitBroken = consecutiveErrors >= config.maxErrors;
          const nextIsMax = !nextIsCircuitBroken && iteration >= config.maxIterations;
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
            break;
          }

          if (iteration >= config.maxIterations) {
            finalStatus = config.once ? "circuit_broken" : "max_reached";
            exitReason = config.once ? "invalid_outcome" : "max_iterations";
            exitCode = config.once ? EXIT_CODES.ERROR : EXIT_CODES.MAX_REACHED;
            terminalEventLogged = true;
            break;
          }

          const postErrElapsed = Math.max(0, (nowMs() - startMs) / 1000);
          const postErrBudget = checkBudgets({
            iteration: iteration + 1,
            maxIterations: config.maxIterations,
            elapsedSec: postErrElapsed,
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
            break;
          }

          const errDelay = Math.min(30, config.intervalSec || 10);
          nextHint = `Previous turn failed outcome contract (${outcome.reason}); return valid JSON matching schema with iteration=${iteration + 1}.`;
          iteration += 1;
          currentState = updateLoopState(stateRoot, loopId, {
            iteration,
            next_hint: nextHint,
          });
          upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

          const errSleep = await sleepInterruptible(errDelay, {
            stateRoot,
            loopId,
            signal: ac.signal,
            pollMs,
            sleepFn,
          });
          if (errSleep.interrupted) {
            finalStatus = "stopped";
            exitReason =
              errSleep.reason === "stop_requested" ? "stop_requested" : "signal";
            exitCode = EXIT_CODES.STOPPED;
            break;
          }
          continue;
        }

        consecutiveErrors = 0;
        const iterData = { ...outcome.data };
        let verifierTerminalOverride = null;

        // 8. Independent read-only verifier gate on DONE (fail-closed).
        if (iterData.loop_status === "DONE" && verifierModel) {
          const { gitStatus, diffStat } = gatherVerifierGitContext({
            execCwd,
            worktreeInfo,
            worktreeBaseSha: worktreeInfo?.baseSha ?? null,
            env,
          });
          const verifierPrompt = buildVerifierPrompt({
            iteration,
            taskPrompt,
            workerSummary: iterData.summary,
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

          usageTotals = addUsageTotals(usageTotals, verifierTurn.usageDelta);

          if (verifierTurn.aborted) {
            finalStatus = "stopped";
            exitReason = "signal";
            exitCode = EXIT_CODES.STOPPED;
            break;
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

        // 9. Persist iteration state + event + progress output.
        lastStatus = iterData.loop_status;
        lastDelaySec = iterData.next_delay_sec;
        lastSummary = iterData.summary;
        nextHint = iterData.next_hint;

        const persistedStatus =
          iterData.loop_status === "DONE"
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
        if (iterData.loop_status === "DONE") {
          finalStatus = "done";
          exitReason = "done";
          exitCode = EXIT_CODES.DONE;
          terminalEventLogged = true;
          break;
        }

        if (iterData.loop_status === "BLOCKED") {
          finalStatus = verifierTerminalOverride?.finalStatus || "blocked";
          exitReason = verifierTerminalOverride?.exitReason || "worker_blocked";
          exitCode = verifierTerminalOverride?.exitCode ?? EXIT_CODES.BLOCKED;
          terminalEventLogged = true;
          break;
        }

        const postStop = isStopRequested(stateRoot, loopId);
        if (ac.signal.aborted || postStop.requested) {
          finalStatus = "stopped";
          exitReason = ac.signal.aborted ? "signal" : "stop_requested";
          exitCode = EXIT_CODES.STOPPED;
          break;
        }

        const postElapsedSec = Math.max(0, (nowMs() - startMs) / 1000);
        if (config.maxDurationSec != null && postElapsedSec >= config.maxDurationSec) {
          finalStatus = "max_reached";
          exitReason = "max_duration";
          exitCode = EXIT_CODES.MAX_REACHED;
          break;
        }
        if (config.maxTokens != null && usageTotals.total_tokens >= config.maxTokens) {
          finalStatus = "max_reached";
          exitReason = "max_tokens";
          exitCode = EXIT_CODES.MAX_REACHED;
          break;
        }

        if (iteration >= config.maxIterations) {
          finalStatus = "max_reached";
          exitReason = "max_iterations";
          exitCode =
            config.once && lastStatus === "CONTINUE"
              ? EXIT_CODES.DONE
              : EXIT_CODES.MAX_REACHED;
          break;
        }

        let delaySec =
          config.pacing === "fixed"
            ? config.intervalSec ?? 60
            : Math.min(86400, Math.max(10, iterData.next_delay_sec || 120));

        if (config.maxDurationSec != null) {
          const remainingDuration = Math.max(
            0.05,
            config.maxDurationSec - postElapsedSec
          );
          delaySec = Math.min(delaySec, remainingDuration);
        }

        iteration += 1;
        currentState = updateLoopState(stateRoot, loopId, { iteration });
        upsertGlobalIndex(currentState, stateRoot, { homeDir, env });

        const iterSleep = await sleepInterruptible(delaySec, {
          stateRoot,
          loopId,
          signal: ac.signal,
          pollMs,
          sleepFn,
        });
        if (iterSleep.interrupted) {
          finalStatus = "stopped";
          exitReason =
            iterSleep.reason === "stop_requested" ? "stop_requested" : "signal";
          exitCode = EXIT_CODES.STOPPED;
          break;
        }
      }
    }
  } finally {
    if (registerSignals) {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
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
      last_status: lastStatus,
      last_delay_sec: lastDelaySec,
      last_summary: lastSummary,
      next_hint: nextHint,
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
}
