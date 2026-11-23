/**
 * CLI subcommand handlers for `agy-loop run | resume | nudge | wake | ps | list | logs | stop | statusline | profiles | daemon | status`.
 */

import path from "node:path";

import {
  installOsDaemon,
  installSidecarDaemon,
  intervalToCron,
  listDaemons,
  readDaemonLogs,
  removeDaemon,
  validatePersistentWorkspace,
} from "./daemon.mjs";
import { formatDuration, formatTokens, parseDurationStrict } from "./duration.mjs";
import { listLeaseLocks } from "./lease-lock.mjs";
import { formatRunHelp, parseRunArgs } from "./parse-run-args.mjs";
import {
  listProfiles,
  resolveProfileTask,
  validateCronExpression,
  validateIanaTimezone,
  validateProfileName,
  validateSidecarGrants,
} from "./profile-parser.mjs";
import { EXIT_CODES, resumeHeadlessLoop, runHeadlessLoop } from "./runner.mjs";
import {
  computeStaleFlag,
  enqueueInboxMessage,
  isPidAlive,
  listGlobalLoops,
  listLoops,
  readEvents,
  readLoopState,
  resolveHome,
  resolveIndexPath,
  resolveLoopByIdOrPrefix,
  resolveStateRoot,
  updateLoopState,
  upsertGlobalIndex,
  writeControlStop,
} from "./state-store.mjs";

function emitCliError(message, { json = false, exitCode = 2 } = {}) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, exit_code: exitCode, error: message }, null, 2)}\n`
    );
  }
  process.stderr.write(`Error: ${message}\n`);
  process.exit(exitCode);
}

function readFlagValue(argv, index, inlineVal, flagName, jsonMode) {
  if (inlineVal !== null) {
    if (!inlineVal.trim()) {
      emitCliError(`Missing value for ${flagName}`, { json: jsonMode, exitCode: 2 });
    }
    return { value: inlineVal, nextIndex: index };
  }
  if (index + 1 >= argv.length || !String(argv[index + 1]).trim()) {
    emitCliError(`Missing value for ${flagName}`, { json: jsonMode, exitCode: 2 });
  }
  return { value: String(argv[index + 1]), nextIndex: index + 1 };
}

function splitFlagToken(arg) {
  const eqIdx = arg.indexOf("=");
  if (eqIdx > 0 && arg.startsWith("-")) {
    return { flag: arg.slice(0, eqIdx), inlineVal: arg.slice(eqIdx + 1) };
  }
  return { flag: arg, inlineVal: null };
}

function truncateInline(text, maxLen = 60) {
  if (typeof text !== "string") {
    return "-";
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return "-";
  }
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, maxLen - 3)}...`;
}

function renderTable(headers, rows) {
  const widths = headers.map((h, col) =>
    Math.max(
      h.length,
      ...rows.map((row) => String(row[col] ?? "").length)
    )
  );
  const formatRow = (cols) =>
    cols
      .map((val, col) => {
        const s = String(val ?? "");
        return col === cols.length - 1 ? s : s.padEnd(widths[col]);
      })
      .join("  ");
  return [formatRow(headers), ...rows.map(formatRow)].join("\n");
}

function formatEventLine(ev) {
  const ts = ev.ts || "-";
  const name = ev.event || "event";
  const iter = ev.iteration != null ? `#${ev.iteration}` : "#-";
  const details = [];

  if (ev.last_status) details.push(ev.last_status);
  else if (ev.status && (name === "init" || name === "stop" || name === "finish")) {
    details.push(`status=${ev.status}`);
  }

  if (name === "iteration_start") {
    if (ev.snapshot_hash) details.push(`snapshot=${ev.snapshot_hash}`);
    if (typeof ev.nudge_count === "number" && ev.nudge_count > 0) {
      details.push(`nudges=${ev.nudge_count}`);
    }
  } else if (name === "iteration_end") {
    if (ev.outcome) details.push(`outcome=${ev.outcome}`);
    if (typeof ev.duration_ms === "number") details.push(`dur=${ev.duration_ms}ms`);
  } else if (name === "inbox_claim") {
    if (ev.count != null) details.push(`claimed=${ev.count}`);
    if (Array.isArray(ev.types) && ev.types.length > 0) {
      details.push(`types=${ev.types.join(",")}`);
    }
  } else if (name === "verify_cmd") {
    if (ev.cmd) details.push(`cmd=${truncateInline(ev.cmd, 40)}`);
    if (ev.exit_code != null) details.push(`exit=${ev.exit_code}`);
    if (ev.timed_out) details.push("timed_out=true");
    if (ev.skipped_due_to_budget) details.push("skipped_due_to_budget=true");
  } else if (name === "resume") {
    if (ev.resumed_from_iteration != null) {
      details.push(`from=#${ev.resumed_from_iteration}`);
    }
    if (ev.previous_status) details.push(`prev=${ev.previous_status}`);
    if (ev.resume_count != null) details.push(`count=${ev.resume_count}`);
  } else if (name === "relay") {
    if (ev.relay_count != null) details.push(`relay=#${ev.relay_count}`);
    if (ev.claimed_count != null) details.push(`claimed=${ev.claimed_count}`);
  }

  if (ev.model) details.push(`model=${ev.model}`);
  if (ev.from_model && ev.to_model) details.push(`${ev.from_model} -> ${ev.to_model}`);
  if (ev.attempt != null) details.push(`attempt=${ev.attempt}/${ev.max_retries ?? "?"}`);
  if (ev.delay_sec != null) details.push(`delay=${ev.delay_sec}s`);
  if (ev.passed !== undefined && ev.passed !== null) details.push(`passed=${ev.passed}`);
  if (ev.skipped_due_to_budget && name !== "verify_cmd") {
    details.push("skipped_due_to_budget=true");
  }

  const tok = ev.usage_delta?.total_tokens;
  if (typeof tok === "number" && tok > 0) {
    details.push(`${formatTokens(tok)} tok`);
  }
  const dur = ev.usage_delta?.duration_seconds;
  if (typeof dur === "number" && dur > 0) {
    details.push(formatDuration(dur));
  }
  if (typeof ev.denied_actions_count === "number" && ev.denied_actions_count > 0) {
    details.push(`denied=${ev.denied_actions_count}`);
  }
  if (Array.isArray(ev.actions) && ev.actions.length > 0) {
    details.push(`actions=${ev.actions.join(",")}`);
  }
  if (ev.exit_reason) details.push(`exit_reason=${ev.exit_reason}`);
  if (ev.stale) details.push("stale=true");
  if (ev.reason) details.push(ev.reason);
  if (ev.summary) details.push(ev.summary);
  if (Array.isArray(ev.issues) && ev.issues.length > 0) {
    details.push(`issues=[${ev.issues.join("; ")}]`);
  }

  return `${ts}  ${name.padEnd(15)} ${iter.padEnd(4)} ${details.join(" | ")}`.trimEnd();
}

/**
 * Handles `agy-loop run ...`.
 *
 * @param {string[]} rawArgs
 * @param {{ version?: string }} [ctx]
 */
export async function handleRun(rawArgs, { version = "2.0.0" } = {}) {
  const jsonRequested = Array.isArray(rawArgs) && rawArgs.includes("--json");
  const parsed = parseRunArgs(rawArgs);

  if (!parsed.ok) {
    emitCliError(parsed.error, { json: jsonRequested, exitCode: parsed.exitCode || 2 });
  }

  if (parsed.help) {
    process.stdout.write(`AGY Loop Runner (v${version})\n\n${formatRunHelp()}`);
    process.exit(0);
  }

  const res = await runHeadlessLoop(parsed);
  process.exit(res.exitCode);
}

/**
 * Handles `agy-loop ps` / `agy-loop list`.
 *
 * @param {string[]} rawArgs
 */
export async function handlePs(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let includeAll = false;
  let globalMode = false;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop ps [options]

Aliases: ps, list

Options:
  --all           Include finished, stopped, and blocked loops
  --global        List loops across workspaces from global index
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--all" || flag === "-a") {
      includeAll = true;
    } else if (flag === "--global" || flag === "-g") {
      globalMode = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else {
      emitCliError(`Unknown argument for ps: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);
  const loops = globalMode
    ? listGlobalLoops({ includeAll, homeDir, env: process.env })
    : listLoops(stateRoot, { includeAll });
  const stateDir = globalMode ? resolveIndexPath(homeDir, process.env) : stateRoot;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, global: globalMode, stateDir, loops }, null, 2)}\n`
    );
    return;
  }

  if (loops.length === 0) {
    process.stdout.write(
      `No ${includeAll ? "" : "active "}loops found${
        globalMode ? " (global index)" : ` in ${stateRoot}`
      }.\n`
    );
    return;
  }

  const headers = [
    "LOOP_ID",
    "ENGINE",
    "STATUS",
    "ITER",
    "MODEL",
    "TOKENS",
    "UPDATED",
    "SUMMARY",
  ];
  const rows = loops.map((loop) => [
    loop.loop_id,
    loop.engine || "interactive",
    loop.stale ? `${loop.status} [stale]` : loop.status,
    `${loop.iteration ?? "?"}/${loop.max_iterations ?? "?"}`,
    loop.active_model || loop.model || "default",
    loop.usage_totals ? formatTokens(loop.usage_totals.total_tokens) : "-",
    loop.updated_at || "-",
    truncateInline(loop.last_summary),
  ]);

  process.stdout.write(`${renderTable(headers, rows)}\n`);
}

/**
 * Handles `agy-loop logs [<loop_id|prefix|latest>] [-f|--follow] [-n|--tail <N>]`.
 *
 * @param {string[]} rawArgs
 */
export async function handleLogs(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let target = null;
  let follow = false;
  let tailCount = null;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop logs [<loop_id|prefix|latest>] [options]

Options:
  -f, --follow       Follow events until the loop finishes or stops
  -n, --tail <N>     Show only the last N events
  --cwd <dir>        Target workspace directory (default: current directory)
  --json             Emit NDJSON event objects
  -h, --help         Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "-f" || flag === "--follow") {
      follow = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "-n" || flag === "--tail") {
      const res = readFlagValue(rawArgs, i, inlineVal, flag, jsonHint);
      if (!/^\d+$/.test(res.value.trim())) {
        emitCliError(`Invalid ${flag} value: '${res.value}' (expected integer >= 0)`, {
          json: jsonHint,
          exitCode: 2,
        });
      }
      tailCount = Number.parseInt(res.value.trim(), 10);
      i = res.nextIndex;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for logs: ${arg}`, { json: jsonHint, exitCode: 2 });
    } else if (target === null) {
      target = arg;
    } else {
      emitCliError(`Unexpected argument for logs: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);
  const resolved = resolveLoopByIdOrPrefix(stateRoot, target || "latest", {
    includeAll: true,
  });
  if (!resolved.ok) {
    emitCliError(resolved.error, { json: jsonHint, exitCode: 1 });
  }

  const loopId = resolved.loop.loop_id;
  const emitEvents = (list) => {
    for (const ev of list) {
      if (json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
      } else {
        process.stdout.write(`${formatEventLine(ev)}\n`);
      }
    }
  };

  const initialEvents = readEvents(stateRoot, loopId);
  const startIdx =
    tailCount !== null ? Math.max(0, initialEvents.length - tailCount) : 0;
  emitEvents(initialEvents.slice(startIdx));
  let emittedCount = initialEvents.length;

  if (!follow) {
    if (initialEvents.length === 0 && !json) {
      process.stdout.write(`No events recorded for ${loopId}.\n`);
    }
    return;
  }

  const initialState = readLoopState(stateRoot, loopId);
  if (!initialState || initialState.status !== "running" || computeStaleFlag(initialState)) {
    return;
  }

  await new Promise((resolve) => {
    let finished = false;
    let pollTimer = null;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      resolve();
    };

    const onSig = () => cleanup();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    pollTimer = setInterval(() => {
      const latestEvents = readEvents(stateRoot, loopId);
      if (latestEvents.length > emittedCount) {
        emitEvents(latestEvents.slice(emittedCount));
        emittedCount = latestEvents.length;
      }

      const curState = readLoopState(stateRoot, loopId);
      if (!curState || curState.status !== "running" || computeStaleFlag(curState)) {
        const trailing = readEvents(stateRoot, loopId);
        if (trailing.length > emittedCount) {
          emitEvents(trailing.slice(emittedCount));
          emittedCount = trailing.length;
        }
        cleanup();
      }
    }, 500);
  });
}

/**
 * Handles `agy-loop stop <loop_id|prefix|all|--all> [--after-current]`.
 *
 * @param {string[]} rawArgs
 */
export async function handleStop(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let target = null;
  let all = false;
  let afterCurrent = false;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop stop <loop_id|prefix|all> [options]

Options:
  --all             Stop all running loops in the workspace
  --after-current   Allow the active iteration to finish before stopping
  --cwd <dir>       Target workspace directory (default: current directory)
  --json            Emit JSON output
  -h, --help        Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--all") {
      all = true;
    } else if (flag === "--after-current") {
      afterCurrent = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for stop: ${arg}`, { json: jsonHint, exitCode: 2 });
    } else if (target === null) {
      target = arg;
    } else {
      emitCliError(`Unexpected argument for stop: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  if (target === "all") {
    all = true;
  }

  if (!all && !target) {
    emitCliError("Usage: agy-loop stop <loop_id|prefix|all> [--after-current]", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);

  let targets = [];
  if (all) {
    targets = listLoops(stateRoot, { includeAll: false });
  } else {
    const resolved = resolveLoopByIdOrPrefix(stateRoot, target, { includeAll: true });
    if (!resolved.ok) {
      emitCliError(resolved.error, { json: jsonHint, exitCode: 1 });
    }
    if (resolved.loop.status === "running") {
      targets = [resolved.loop];
    } else if (!json) {
      process.stdout.write(
        `Loop ${resolved.loop.loop_id} is already ${resolved.loop.status}.\n`
      );
      return;
    }
  }

  const stopped = [];
  const requestedMode = afterCurrent ? "after_current" : "immediate";
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const loop of targets) {
    const isHeadless = loop.engine === "headless";
    const isPidManaged = loop.engine === "headless" || loop.engine === "workflow";
    const hasPid = isPidManaged && Number.isInteger(loop.pid) && loop.pid > 0;
    const pidAlive = hasPid ? isPidAlive(loop.pid) : false;
    const isStale = isPidManaged && hasPid && !pidAlive;

    // Reconcile stale headless loops directly to stopped even if --after-current was passed.
    const effectiveMode = isStale ? "immediate" : requestedMode;
    writeControlStop(stateRoot, loop.loop_id, effectiveMode);

    const patch =
      effectiveMode === "after_current"
        ? {
            stop_requested: true,
            stop_mode: "after_current",
          }
        : {
            status: "stopped",
            stop_requested: true,
            stop_mode: "immediate",
            ...(isStale
              ? { finished_at: nowIso, exit_reason: "stale_pid_reconciled" }
              : {}),
          };

    const updated = updateLoopState(stateRoot, loop.loop_id, patch, {
      event: "stop",
      stop_mode: effectiveMode,
      ...(isStale ? { reconciled_stale: true } : {}),
    });
    upsertGlobalIndex(updated, stateRoot, { homeDir, env: process.env });

    let signalSent = null;
    if (effectiveMode === "immediate" && isHeadless && pidAlive) {
      try {
        process.kill(loop.pid, "SIGTERM");
        signalSent = "SIGTERM";
      } catch {
        // Process exited between liveness probe and signal delivery.
      }
    }

    stopped.push({
      ...updated,
      ...(signalSent ? { signal_sent: signalSent } : {}),
      ...(isStale ? { reconciled_stale: true } : {}),
    });
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, stateDir: stateRoot, stopped }, null, 2)}\n`
    );
    return;
  }

  if (stopped.length === 0) {
    process.stdout.write(`No active loops to stop in ${stateRoot}.\n`);
    return;
  }

  for (const item of stopped) {
    const modeLabel =
      item.stop_mode === "after_current" ? "after current iteration" : "immediately";
    const extra = item.reconciled_stale
      ? " (reconciled stale PID)"
      : item.signal_sent
        ? ` (sent ${item.signal_sent})`
        : "";
    process.stdout.write(`Stopped ${item.loop_id} ${modeLabel}${extra}\n`);
  }
}

/**
 * Handles `agy-loop statusline [--global] [--no-color] [--json]`.
 * Strictly pure filesystem reads (zero subprocesses) for <5ms execution.
 *
 * @param {string[]} rawArgs
 */
export async function handleStatusline(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let globalMode = false;
  let noColor = false;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop statusline [options]

Options:
  --global        Inspect active loops across all workspaces
  --no-color      Disable ANSI color output
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON status summary
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--global") {
      globalMode = true;
    } else if (flag === "--no-color") {
      noColor = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else {
      emitCliError(`Unknown argument for statusline: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);

  const running = globalMode
    ? listGlobalLoops({ includeAll: false, homeDir, env: process.env })
    : listLoops(stateRoot, { includeAll: false });
  const active = running.filter((loop) => !loop.stale);
  const stale = running.filter((loop) => loop.stale);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          count: active.length,
          staleCount: stale.length,
          loops: active,
          staleLoops: stale,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (active.length === 0) {
    return;
  }

  let text;
  if (active.length === 1) {
    const loop = active[0];
    const iter = loop.iteration ?? "?";
    const maxIter = loop.max_iterations ?? "?";
    const totalTokens = loop.usage_totals?.total_tokens || 0;
    const tokSuffix = totalTokens > 0 ? ` (${formatTokens(totalTokens)} tok)` : "";
    text = `↻ agy-loop #${iter}/${maxIter}${tokSuffix}`;
  } else {
    const previews = active
      .slice(0, 3)
      .map((l) => `#${l.iteration ?? "?"}/${l.max_iterations ?? "?"}`);
    const extra = active.length > 3 ? `, +${active.length - 3}` : "";
    text = `↻ ${active.length} loops (${previews.join(", ")}${extra})`;
  }

  const useColor =
    !noColor && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const out = useColor ? `\x1b[36m${text}\x1b[0m` : text;
  process.stdout.write(`${out}\n`);
}

function parsePositiveIntOption(raw, flagName, jsonMode) {
  const trimmed = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    emitCliError(`Invalid ${flagName} value: '${trimmed}' (expected integer >= 1)`, {
      json: jsonMode,
      exitCode: 2,
    });
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    emitCliError(`Invalid ${flagName} value: '${trimmed}' (expected safe integer >= 1)`, {
      json: jsonMode,
      exitCode: 2,
    });
  }
  return parsed;
}

function resolveActiveInboxLoop(stateRoot, target, actionName, jsonMode) {
  let resolved;
  if (target.trim() === "latest") {
    const running = listLoops(stateRoot, { includeAll: false });
    const live = running.filter((item) => !item.stale);
    if (live.length > 0) {
      resolved = { ok: true, loop: live[0] };
    } else if (running.length > 0) {
      resolved = { ok: true, loop: running[0] };
    } else {
      resolved = resolveLoopByIdOrPrefix(stateRoot, target, { includeAll: true });
    }
  } else {
    resolved = resolveLoopByIdOrPrefix(stateRoot, target, { includeAll: true });
  }
  if (!resolved.ok) {
    emitCliError(resolved.error, { json: jsonMode, exitCode: 1 });
  }
  const loop = resolved.loop;
  if (loop.engine !== "headless" && loop.engine !== "workflow") {
    emitCliError(
      `Loop ${loop.loop_id} uses engine '${loop.engine || "interactive"}'; '${actionName}' only supports active headless or workflow loops.`,
      { json: jsonMode, exitCode: 2 }
    );
  }
  if (loop.status !== "running") {
    emitCliError(
      `Loop ${loop.loop_id} is ${loop.status}; '${actionName}' requires a running loop.`,
      { json: jsonMode, exitCode: 1 }
    );
  }
  if (loop.stale) {
    emitCliError(
      `Loop ${loop.loop_id} is stale (pid=${loop.pid} is not alive); cannot ${actionName} a dead process.`,
      { json: jsonMode, exitCode: 1 }
    );
  }
  return loop;
}

/**
 * Handles `agy-loop nudge <loop_id|prefix|latest> "<message>" [--wake] [--cwd <dir>] [--json]`.
 *
 * @param {string[]} rawArgs
 */
export async function handleNudge(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let wake = false;
  let json = false;
  let cwd = null;
  let endOfOptions = false;
  const positional = [];

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (endOfOptions) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop nudge <loop_id|prefix|latest> "<message>" [options]

Options:
  --wake          Immediately interrupt inter-iteration sleep after queueing
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--wake") {
      if (inlineVal !== null) {
        emitCliError("Option --wake does not take a value", { json: jsonHint, exitCode: 2 });
      }
      wake = true;
    } else if (flag === "--json") {
      if (inlineVal !== null) {
        emitCliError("Option --json does not take a value", { json: jsonHint, exitCode: 2 });
      }
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for nudge: ${arg}`, { json: jsonHint, exitCode: 2 });
    } else {
      positional.push(arg);
    }
  }

  const target = positional[0] ? positional[0].trim() : "";
  const message = positional.slice(1).join(" ").trim();
  if (!target || !message) {
    emitCliError('Usage: agy-loop nudge <loop_id|prefix|latest> "<message>" [--wake]', {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);
  const loop = resolveActiveInboxLoop(stateRoot, target, "nudge", json);
  const enqueued = enqueueInboxMessage(stateRoot, loop.loop_id, {
    type: "nudge",
    message,
    wake,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          loop_id: loop.loop_id,
          engine: loop.engine,
          type: "nudge",
          wake,
          message,
          file: enqueued.file,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(
    `Queued nudge for ${loop.loop_id}${wake ? " (wake requested)" : ""}: ${truncateInline(message, 80)}\n`
  );
}

/**
 * Handles `agy-loop wake <loop_id|prefix|latest> [--cwd <dir>] [--json]`.
 *
 * @param {string[]} rawArgs
 */
export async function handleWake(rawArgs = []) {
  const jsonHint = rawArgs.includes("--json");
  let json = false;
  let cwd = null;
  let reason = null;
  let target = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop wake <loop_id|prefix|latest> [options]

Options:
  --reason <msg>  Optional reason recorded with the wake message
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--json") {
      if (inlineVal !== null) {
        emitCliError("Option --json does not take a value", { json: jsonHint, exitCode: 2 });
      }
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (flag === "--reason") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--reason", jsonHint);
      reason = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for wake: ${arg}`, { json: jsonHint, exitCode: 2 });
    } else if (target === null) {
      target = arg;
    } else {
      emitCliError(`Unexpected argument for wake: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  if (!target || !target.trim()) {
    emitCliError("Usage: agy-loop wake <loop_id|prefix|latest> [--cwd <dir>] [--json]", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);
  const loop = resolveActiveInboxLoop(stateRoot, target, "wake", json);
  const enqueued = enqueueInboxMessage(stateRoot, loop.loop_id, {
    type: "wake",
    ...(reason ? { reason } : {}),
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          loop_id: loop.loop_id,
          engine: loop.engine,
          type: "wake",
          ...(reason ? { reason } : {}),
          file: enqueued.file,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`Queued wake for ${loop.loop_id}\n`);
}

/**
 * Handles `agy-loop resume <loop_id|prefix|latest> [options]`.
 *
 * @param {string[]} rawArgs
 * @param {{ version?: string }} [ctx]
 */
export async function handleResume(rawArgs = [], { version = "2.0.0" } = {}) {
  const jsonHint = rawArgs.includes("--json");
  let target = null;
  let maxIterations = null;
  let maxTokens = null;
  let maxDurationSec = null;
  let model = null;
  let settingsArg = null;
  let cwd = null;
  let json = false;
  let quiet = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`AGY Loop Resume (v${version})

Usage:
  agy-loop resume <loop_id|prefix|latest> [options]

Options:
  --max <N>              New maximum iteration limit
  --max-tokens <N>       New cumulative token budget
  --max-duration <dur>   New wall-clock duration budget (e.g. 30m, 2h)
  --model <slug|label>   Override primary model slug or display name
  --settings <json|path> Session-only settings JSON or path (never persisted)
  --cwd <dir>            Target workspace directory (default: current directory)
  --json                 Emit final structured summary JSON to stdout
  --quiet                Suppress non-error progress lines
  -h, --help             Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--json") {
      if (inlineVal !== null) {
        emitCliError("Option --json does not take a value", { json: jsonHint, exitCode: 2 });
      }
      json = true;
    } else if (flag === "--quiet") {
      if (inlineVal !== null) {
        emitCliError("Option --quiet does not take a value", { json: jsonHint, exitCode: 2 });
      }
      quiet = true;
    } else if (flag === "--max") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--max", jsonHint);
      maxIterations = parsePositiveIntOption(res.value, "--max", jsonHint);
      i = res.nextIndex;
    } else if (flag === "--max-tokens") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--max-tokens", jsonHint);
      maxTokens = parsePositiveIntOption(res.value, "--max-tokens", jsonHint);
      i = res.nextIndex;
    } else if (flag === "--max-duration") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--max-duration", jsonHint);
      try {
        maxDurationSec = parseDurationStrict(res.value, "--max-duration").seconds;
      } catch (err) {
        emitCliError(err instanceof Error ? err.message : String(err), {
          json: jsonHint,
          exitCode: 2,
        });
      }
      i = res.nextIndex;
    } else if (flag === "--model") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--model", jsonHint);
      model = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--settings") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--settings", jsonHint);
      settingsArg = res.value;
      i = res.nextIndex;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for resume: ${arg}`, { json: jsonHint, exitCode: 2 });
    } else if (target === null) {
      target = arg;
    } else {
      emitCliError(`Unexpected argument for resume: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  if (!target || !target.trim()) {
    emitCliError("Usage: agy-loop resume <loop_id|prefix|latest> [options]", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const res = await resumeHeadlessLoop(target, {
    maxIterations,
    maxTokens,
    maxDurationSec,
    model,
    settingsArg,
    cwd,
    json,
    quiet,
  });
  process.exit(res.exitCode);
}

const VALID_DAEMON_MODES = new Set(["sidecar", "os"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_OS_SINGLETONS = new Set(["profile", "workspace"]);

function formatProfileSchedule(profile) {
  const cfg = profile?.config || {};
  if (cfg.cron) return `cron:${cfg.cron}`;
  if (cfg.interval_label) return `every ${cfg.interval_label}`;
  if (cfg.once) return "once";
  return "dynamic";
}

function formatDaemonSchedule(daemon) {
  if (daemon?.cron_expr) {
    return daemon.timezone ? `${daemon.cron_expr} (${daemon.timezone})` : daemon.cron_expr;
  }
  if (Number.isInteger(daemon?.interval_sec) && daemon.interval_sec > 0) {
    return `every ${formatDuration(daemon.interval_sec)}`;
  }
  return "-";
}

function extractCommandPrefixForGrant(rawCmd) {
  if (typeof rawCmd !== "string" || !rawCmd.trim()) {
    return null;
  }
  const tokens = rawCmd.trim().split(/\s+/);
  if (tokens.length === 0) return null;
  const bin = tokens[0];
  if (bin.includes("*") || bin === "/" || bin === "\\") {
    return null;
  }
  if (tokens.length >= 2 && ["npm", "pnpm", "yarn", "git", "node", "python", "python3", "cargo", "go"].includes(bin)) {
    const sub = tokens[1];
    if (sub && !sub.startsWith("-") && !sub.includes("*")) {
      return `${bin} ${sub}`;
    }
  }
  return bin;
}

function suggestGrantsFromDeniedActions(deniedActions) {
  const actions = [];
  const rawSuggested = new Set();
  const guidance = new Set();

  for (const item of deniedActions) {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name) continue;
      actions.push(name);
      if (name === "run_command") {
        guidance.add("Pass specific command binaries via --grant 'command(<bin>)' (never command(*)).");
      } else if (name === "write_to_file" || name === "replace_file_content" || name === "write_file") {
        guidance.add("Pass specific file/dir scopes via --grant 'write_file(<path>)' (never write_file(*)).");
      } else if (name === "view_file" || name === "read_file") {
        guidance.add("Pass specific paths via --grant 'read_file(<path>)' (never read_file(*) or read_file(/)).");
      } else {
        guidance.add(`Review denied tool '${name}' and grant only scoped access if required.`);
      }
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const tool = String(item.tool_name || item.tool || item.action || item.name || "").trim();
    if (tool) {
      actions.push(tool);
    }

    const cmdCandidate =
      typeof item.command === "string"
        ? item.command
        : typeof item.cmd === "string"
          ? item.cmd
          : Array.isArray(item.args) && item.args.length > 0
            ? item.args.join(" ")
            : null;
    if (cmdCandidate) {
      const prefix = extractCommandPrefixForGrant(cmdCandidate);
      if (prefix) {
        rawSuggested.add(`command(${prefix})`);
      }
    } else if (tool === "run_command") {
      guidance.add("Pass specific command binaries via --grant 'command(<bin>)' (never command(*)).");
    }

    const pathCandidate =
      typeof item.path === "string"
        ? item.path
        : typeof item.file_path === "string"
          ? item.file_path
          : typeof item.target_file === "string"
            ? item.target_file
            : null;
    if (pathCandidate && pathCandidate.trim() && pathCandidate.trim() !== "/" && !pathCandidate.includes("*")) {
      if (tool === "write_to_file" || tool === "replace_file_content" || tool === "write_file") {
        rawSuggested.add(`write_file(${pathCandidate.trim()})`);
      } else if (tool === "view_file" || tool === "read_file") {
        rawSuggested.add(`read_file(${pathCandidate.trim()})`);
      }
    } else if (tool === "write_to_file" || tool === "replace_file_content" || tool === "write_file") {
      guidance.add("Pass specific file/dir scopes via --grant 'write_file(<path>)' (never write_file(*)).");
    }

    if (typeof item.url === "string" && item.url.trim() && !item.url.includes("*")) {
      rawSuggested.add(`read_url(${item.url.trim()})`);
    }
  }

  const suggestedGrants = [];
  for (const cand of rawSuggested) {
    try {
      const validated = validateSidecarGrants([cand]);
      if (validated.length === 1) {
        suggestedGrants.push(validated[0]);
      }
    } catch {
      // Skip any candidate that violates strict grant validation
    }
  }

  return {
    actions: Array.from(new Set(actions)),
    suggestedGrants,
    guidance: Array.from(guidance),
  };
}

/**
 * Handles `agy-loop profiles [--cwd <dir>] [--json]`.
 *
 * @param {string[]} rawArgs
 */
export async function handleProfiles(rawArgs = []) {
  const jsonHint = Array.isArray(rawArgs) && rawArgs.includes("--json");
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop profiles [options]

Options:
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--json") {
      if (inlineVal !== null) {
        emitCliError("Option --json does not take a value", { json: jsonHint, exitCode: 2 });
      }
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else {
      emitCliError(`Unknown argument for profiles: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const profiles = listProfiles(workspaceDir, homeDir);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, workspaceDir, profiles }, null, 2)}\n`
    );
    return;
  }

  if (profiles.length === 0) {
    process.stdout.write(
      `No profiles found in ${workspaceDir} (.agents/loop.md, .agents/loops/*.md) or ~/.gemini/config/loops/*.md.\n`
    );
    return;
  }

  const headers = ["NAME", "SCOPE", "SOURCE", "STATUS", "SCHEDULE", "MODEL", "SINGLETON"];
  const rows = profiles.map((p) => [
    p.isDefault ? `${p.name} (default)` : p.name,
    p.scope || "-",
    p.source || "-",
    p.ok ? "ok" : `error: ${truncateInline(p.error, 38)}`,
    p.ok ? formatProfileSchedule(p) : "-",
    p.ok && p.config?.worker_model ? p.config.worker_model : "-",
    p.ok ? p.config?.singleton || (p.isDefault ? "none" : "profile") : "-",
  ]);

  process.stdout.write(`${renderTable(headers, rows)}\n`);
  const invalid = profiles.filter((p) => !p.ok);
  if (invalid.length > 0) {
    process.stdout.write("\nInvalid profiles:\n");
    for (const item of invalid) {
      process.stdout.write(`  - ${item.source} (${item.path}): ${item.error}\n`);
    }
  }
}

function printDaemonHelp(version) {
  process.stdout.write(`AGY Loop Daemon Manager (v${version})

Usage:
  agy-loop daemon <subcommand> [options]

Subcommands:
  install     Install a persistent Sidecar or OS (LaunchAgent / systemd --user) daemon
  list        List managed agy-loop daemons
  status      List managed agy-loop daemons with live OS load status
  remove      Unload and remove a managed daemon by <slug> or --all
  logs        Inspect trailing logs for a managed OS daemon

Run 'agy-loop daemon <subcommand> --help' for subcommand options.
`);
}

async function handleDaemonInstall(rawArgs, { version }) {
  const jsonHint = rawArgs.includes("--json");
  let mode = null;
  let profile = null;
  let file = null;
  let cron = null;
  let intervalSec = null;
  let timezone = null;
  let model = null;
  let effort = null;
  let fallbackModel = null;
  let verifierModel = null;
  let title = null;
  const grants = [];
  let includeWorkspaceUri = true;
  let trustProfileCommands = false;
  let singleton = null;
  let dryRun = false;
  let testRun = false;
  let noLoad = false;
  let allowTempWorkspace = false;
  let cwd = null;
  let json = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`AGY Loop Daemon Install (v${version})

Usage:
  agy-loop daemon install [options]

Options:
  --mode <sidecar|os>        Daemon mode (defaults to sidecar if --cron or frontmatter cron is set)
  --profile <name>           Named profile (.agents/loops/<name>.md or ~/.gemini/config/loops/<name>.md)
  --file <path>              Explicit Markdown profile file (mutually exclusive with --profile)
  --cron "<5-field>"         5-field cron expression
  --interval <dur>           Schedule interval (e.g. 5m, 30s)
  --tz <IANA>                IANA timezone (e.g. Asia/Shanghai, UTC)
  --model <slug|label>       Worker model override
  --effort <level>           Reasoning effort (low|medium|high|xhigh|max; OS mode)
  --fallback-model <slug>    Fallback model (OS mode)
  --verifier-model <slug>    Independent verifier model (OS mode)
  --title "<text>"           Display name / title (Sidecar mode)
  --grant "<grant>"          Scoped Sidecar access_grant (repeatable; wildcards forbidden)
  --no-workspace-uri         Omit workspace_uris from Sidecar agent_permissions
  --trust-profile-commands   Trust frontmatter probe_cmd/verify_cmd for OS daemon & --test-run
  --singleton <profile|workspace>  Lock scope override (OS mode)
  --dry-run                  Preview generated daemon config without writing files
  --test-run                 Run a 1-turn check first to discover denied_actions[] & grant guidance
  --no-load                  Write OS service files without loading via launchctl/systemctl
  --allow-temp-workspace     Allow registering temporary workspace paths (/tmp, /var/folders)
  --cwd <dir>                Target workspace directory (default: current directory)
  --json                     Emit JSON output
  -h, --help                 Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--mode") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--mode", jsonHint);
      const val = res.value.trim().toLowerCase();
      if (!VALID_DAEMON_MODES.has(val)) {
        emitCliError(`Invalid --mode '${val}': expected sidecar or os`, {
          json: jsonHint,
          exitCode: 2,
        });
      }
      mode = val;
      i = res.nextIndex;
    } else if (flag === "--profile") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--profile", jsonHint);
      const val = res.value.trim();
      if (file !== null) {
        emitCliError("Conflicting options: --profile and --file cannot be combined", {
          json: jsonHint,
          exitCode: 2,
        });
      }
      if (!validateProfileName(val)) {
        emitCliError(`Invalid --profile name '${val}'`, { json: jsonHint, exitCode: 2 });
      }
      profile = val;
      i = res.nextIndex;
    } else if (flag === "--file") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--file", jsonHint);
      if (profile !== null) {
        emitCliError("Conflicting options: --profile and --file cannot be combined", {
          json: jsonHint,
          exitCode: 2,
        });
      }
      file = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--cron") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cron", jsonHint);
      try {
        cron = validateCronExpression(res.value);
      } catch (err) {
        emitCliError(err instanceof Error ? err.message : String(err), {
          json: jsonHint,
          exitCode: 2,
        });
      }
      i = res.nextIndex;
    } else if (flag === "--interval") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--interval", jsonHint);
      try {
        intervalSec = parseDurationStrict(res.value, "--interval").seconds;
      } catch (err) {
        emitCliError(err instanceof Error ? err.message : String(err), {
          json: jsonHint,
          exitCode: 2,
        });
      }
      i = res.nextIndex;
    } else if (flag === "--tz" || flag === "--timezone") {
      const res = readFlagValue(rawArgs, i, inlineVal, flag, jsonHint);
      try {
        timezone = validateIanaTimezone(res.value);
      } catch (err) {
        emitCliError(err instanceof Error ? err.message : String(err), {
          json: jsonHint,
          exitCode: 2,
        });
      }
      i = res.nextIndex;
    } else if (flag === "--model") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--model", jsonHint);
      model = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--effort") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--effort", jsonHint);
      const val = res.value.trim().toLowerCase();
      if (!VALID_EFFORTS.has(val)) {
        emitCliError(`Invalid --effort '${val}' (expected low, medium, high, xhigh, or max)`, {
          json: jsonHint,
          exitCode: 2,
        });
      }
      effort = val;
      i = res.nextIndex;
    } else if (flag === "--fallback-model") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--fallback-model", jsonHint);
      fallbackModel = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--verifier-model") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--verifier-model", jsonHint);
      verifierModel = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--title") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--title", jsonHint);
      title = res.value.trim();
      i = res.nextIndex;
    } else if (flag === "--grant") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--grant", jsonHint);
      grants.push(res.value.trim());
      i = res.nextIndex;
    } else if (flag === "--singleton") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--singleton", jsonHint);
      const val = res.value.trim().toLowerCase();
      if (!VALID_OS_SINGLETONS.has(val)) {
        emitCliError(`Invalid --singleton '${val}' for daemon (expected profile or workspace)`, {
          json: jsonHint,
          exitCode: 2,
        });
      }
      singleton = val;
      i = res.nextIndex;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (flag === "--no-workspace-uri") {
      includeWorkspaceUri = false;
    } else if (flag === "--trust-profile-commands") {
      trustProfileCommands = true;
    } else if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--test-run") {
      testRun = true;
    } else if (flag === "--no-load") {
      noLoad = true;
    } else if (flag === "--allow-temp-workspace") {
      allowTempWorkspace = true;
    } else if (flag === "--json") {
      json = true;
    } else {
      emitCliError(`Unknown option for daemon install: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  if (cron !== null && intervalSec !== null) {
    emitCliError("Conflicting options: --cron and --interval cannot be combined", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  try {
    validateSidecarGrants(grants);
  } catch (err) {
    emitCliError(err instanceof Error ? err.message : String(err), {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());

  let realWs;
  let profileResult;
  try {
    realWs = validatePersistentWorkspace(workspaceDir, { allowTempWorkspace });
    profileResult = resolveProfileTask({
      workspaceDir: realWs,
      homeDir,
      profile,
      file,
    });
  } catch (err) {
    emitCliError(err instanceof Error ? err.message : String(err), {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const fm = profileResult?.frontmatter ?? {};
  const effectiveMode = mode || (cron || fm.cron ? "sidecar" : null);
  if (!effectiveMode) {
    emitCliError(
      'Missing --mode <sidecar|os>: pass \'--mode sidecar --cron "<5-field>"\' or \'--mode os --interval <dur>\' (or declare \'cron:\' in profile frontmatter).',
      { json: jsonHint, exitCode: 2 }
    );
  }

  if (effectiveMode === "os" && !trustProfileCommands && (fm.probe_cmd || fm.verify_cmd)) {
    const blocked = [fm.probe_cmd ? "probe_cmd" : null, fm.verify_cmd ? "verify_cmd" : null]
      .filter(Boolean)
      .join(", ");
    emitCliError(
      `Refusing to register OS daemon for profile '${profileResult.source}' with untrusted frontmatter command(s) (${blocked}): pass --trust-profile-commands if you trust this repository.`,
      { json: jsonHint, exitCode: 2 }
    );
  }

  let effectiveCliCron = cron;
  let profileResultForDaemon = profileResult;
  if (intervalSec !== null && !cron) {
    if (effectiveMode === "sidecar") {
      try {
        effectiveCliCron = intervalToCron(intervalSec);
      } catch (err) {
        emitCliError(err instanceof Error ? err.message : String(err), {
          json: jsonHint,
          exitCode: 2,
        });
      }
    } else if (fm.cron) {
      profileResultForDaemon = {
        ...profileResult,
        frontmatter: { ...fm, cron: undefined },
      };
    }
  }

  let testRunReport = null;
  if (testRun) {
    const explicitFlags = new Set([
      "once",
      "maxIterations",
      "singleton",
      "interval",
      "intervalSec",
      "pacing",
      "stateMode",
      "resetEvery",
    ]);
    if (profile) explicitFlags.add("profile");
    if (file) explicitFlags.add("profileFile");
    if (model) explicitFlags.add("model");
    if (effort) explicitFlags.add("effort");
    if (fallbackModel) explicitFlags.add("fallbackModel");
    if (verifierModel) explicitFlags.add("verifierModel");
    if (trustProfileCommands) explicitFlags.add("trustProfileCommands");

    let testOut = "";
    let testErr = "";
    const testConfig = {
      pacing: "dynamic",
      once: true,
      intervalSec: null,
      intervalLabel: null,
      maxIterations: 1,
      stateMode: "fresh",
      resetEvery: null,
      maxDurationSec: null,
      maxTokens: null,
      maxRetries: 1,
      maxErrors: 1,
      model: model || null,
      effort: effort || null,
      fallbackModel: fallbackModel || null,
      verifierModel: verifierModel || null,
      mode: null,
      sandbox: effectiveMode === "sidecar",
      dangerouslySkipPermissions: false,
      allowSlashCommands: false,
      settingsArg: null,
      addDirs: [],
      worktree: false,
      keepWorktree: false,
      workspace: "inherit",
      turnTimeoutSec: 120,
      failOnDenied: false,
      verifyCmd: null,
      verifyTimeoutSec: 60,
      probeCmd: null,
      probeTimeoutSec: 60,
      probeUntilPass: false,
      json: true,
      quiet: true,
      cwd: realWs,
      profile: profile || null,
      profileFile: file || null,
      singleton: "none",
      onConflict: "fail",
      trustProfileCommands: Boolean(trustProfileCommands),
      relayOnWake: false,
      explicitFlags,
      taskSource: "loop_md_or_default",
      prompt: "",
    };

    const testRes = await runHeadlessLoop(testConfig, {
      env: process.env,
      stdout: {
        write(chunk) {
          testOut += String(chunk);
        },
      },
      stderr: {
        write(chunk) {
          testErr += String(chunk);
        },
      },
      registerSignals: false,
    });

    if (!testRes.state && testRes.exitCode !== EXIT_CODES.DONE) {
      let parsedErr = null;
      try {
        parsedErr = JSON.parse(testOut)?.error || null;
      } catch {
        parsedErr = null;
      }
      const errDetail =
        parsedErr ||
        testErr.replace(/^Error:\s*/i, "").trim() ||
        `daemon --test-run failed with exit code ${testRes.exitCode}`;
      emitCliError(errDetail, {
        json: jsonHint,
        exitCode: testRes.exitCode || 1,
      });
    }

    const stateRoot = resolveStateRoot(realWs, process.env);
    const events = testRes.state?.loop_id ? readEvents(stateRoot, testRes.state.loop_id) : [];
    const rawDenied = [];
    for (const ev of events) {
      if (ev.event === "denied" && Array.isArray(ev.denied_actions)) {
        rawDenied.push(...ev.denied_actions);
      }
    }
    const grantHints = suggestGrantsFromDeniedActions(rawDenied);
    testRunReport = {
      ok: testRes.exitCode === EXIT_CODES.DONE,
      exitCode: testRes.exitCode,
      loopId: testRes.state?.loop_id ?? null,
      status: testRes.state?.status ?? null,
      deniedActionsCount: rawDenied.length,
      deniedActions: grantHints.actions,
      suggestedGrants: grantHints.suggestedGrants,
      guidance: grantHints.guidance,
    };
  }

  let installRes;
  try {
    if (effectiveMode === "sidecar") {
      installRes = installSidecarDaemon({
        workspaceDir: realWs,
        homeDir,
        env: process.env,
        profile,
        file,
        profileResult: profileResultForDaemon,
        cron: effectiveCliCron,
        intervalSec,
        timezone,
        model,
        title,
        accessGrants: grants,
        includeWorkspaceUri,
        allowTempWorkspace,
        dryRun,
      });
    } else {
      const extraArgs = [];
      if (effort) extraArgs.push("--effort", effort);
      if (fallbackModel) extraArgs.push("--fallback-model", fallbackModel);
      if (verifierModel) extraArgs.push("--verifier-model", verifierModel);
      installRes = installOsDaemon({
        workspaceDir: realWs,
        homeDir,
        env: process.env,
        profile,
        file,
        profileResult: profileResultForDaemon,
        cron,
        intervalSec,
        timezone,
        model,
        singleton,
        trustProfileCommands,
        extraArgs,
        allowTempWorkspace,
        dryRun,
        noLoad,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isServiceRuntimeErr = /(launchctl|systemctl).*failed/i.test(msg);
    emitCliError(msg, {
      json: jsonHint,
      exitCode: isServiceRuntimeErr ? 1 : 2,
    });
  }

  const outPayload = testRunReport ? { ...installRes, testRun: testRunReport } : installRes;
  if (json) {
    process.stdout.write(`${JSON.stringify(outPayload, null, 2)}\n`);
    return;
  }

  if (testRunReport) {
    process.stdout.write(
      `==> Test run (${testRunReport.loopId || "once"}): status=${testRunReport.status || "unknown"}, denied_actions=${testRunReport.deniedActionsCount}\n`
    );
    if (testRunReport.deniedActions.length > 0) {
      process.stdout.write(
        `    Denied actions: ${testRunReport.deniedActions.join(", ")}\n`
      );
    }
    if (testRunReport.suggestedGrants.length > 0) {
      process.stdout.write(
        `    Suggested --grant flags: ${testRunReport.suggestedGrants.map((g) => `--grant "${g}"`).join(" ")}\n`
      );
    }
    for (const tip of testRunReport.guidance) {
      process.stdout.write(`    Grant guidance: ${tip}\n`);
    }
  }

  if (effectiveMode === "sidecar") {
    if (installRes.dryRun) {
      process.stdout.write(
        `[dry-run] Sidecar config preview (${installRes.configPath}):\n${JSON.stringify(installRes.config, null, 2)}\n`
      );
    } else {
      process.stdout.write(
        `==> Installed Sidecar daemon '${installRes.slug}'\n` +
          `  Display Name: ${installRes.config.display_name}\n` +
          `  Config Path:  ${installRes.configPath}\n` +
          `  Schedule:     CRON_TZ=${installRes.timezone} ${installRes.cronExpr}\n` +
          `  Enable in UI: [Open Automations Dashboard](${installRes.dashboardUrl}) (${installRes.dashboardUrl})\n` +
          `  Observe runs: agy remote-control status  |  agy-loop status\n`
      );
    }
    return;
  }

  if (installRes.dryRun) {
    process.stdout.write(
      `[dry-run] OS daemon preview (${installRes.platform}, ${installRes.slug}):\n`
    );
    for (const f of installRes.files || []) {
      process.stdout.write(`--- ${f.path} ---\n${f.content}\n`);
    }
    return;
  }

  process.stdout.write(
    `==> Installed OS daemon '${installRes.slug}' (${installRes.platform})\n` +
      `  Service:      ${installRes.serviceLabel}\n` +
      `  Loaded:       ${installRes.loaded ? "yes" : "no (--no-load)"}\n` +
      `  Config Path:  ${installRes.configPath}\n` +
      `  Log Path:     ${installRes.logPath}\n`
  );
}

async function handleDaemonList(rawArgs, { checkStatus = false } = {}) {
  const jsonHint = rawArgs.includes("--json");
  let globalMode = false;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop daemon ${checkStatus ? "status" : "list"} [options]

Options:
  --global        List managed daemons across all workspaces
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }
    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--global" || flag === "-g") {
      globalMode = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else {
      emitCliError(`Unknown argument for daemon ${checkStatus ? "status" : "list"}: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const daemons = listDaemons({
    workspaceDir: globalMode ? null : workspaceDir,
    global: globalMode,
    homeDir,
    env: process.env,
    checkStatus,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, global: globalMode, workspaceDir, daemons }, null, 2)}\n`
    );
    return;
  }

  if (daemons.length === 0) {
    process.stdout.write(
      `No managed agy-loop daemons found${globalMode ? " (global)" : ` for ${workspaceDir}`}.\n`
    );
    return;
  }

  const headers = ["SLUG", "MODE", "PLATFORM", "PROFILE", "SCHEDULE", "INSTALLED", "LOADED", "CONFIG_PATH"];
  const rows = daemons.map((d) => [
    d.slug,
    d.mode || "-",
    d.platform || "-",
    d.profile_name || "default",
    formatDaemonSchedule(d),
    d.installed ? "yes" : "no",
    d.loaded === null ? "-" : d.loaded ? "yes" : "no",
    d.config_path || "-",
  ]);
  process.stdout.write(`${renderTable(headers, rows)}\n`);
}

async function handleDaemonRemove(rawArgs) {
  const jsonHint = rawArgs.includes("--json");
  let slug = null;
  let all = false;
  let globalMode = false;
  let mode = null;
  let noUnload = false;
  let cwd = null;
  let json = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop daemon remove [<slug>] [options]

Options:
  --all           Remove all managed agy-loop daemons in scope
  --global        With --all, remove managed daemons across all workspaces
  --mode <mode>   Restrict removal to sidecar or os
  --no-unload     Skip launchctl bootout / systemctl disable before removing files
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--all") {
      all = true;
    } else if (flag === "--global" || flag === "-g") {
      globalMode = true;
    } else if (flag === "--no-unload") {
      noUnload = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--mode") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--mode", jsonHint);
      const val = res.value.trim().toLowerCase();
      if (!VALID_DAEMON_MODES.has(val)) {
        emitCliError(`Invalid --mode '${val}': expected sidecar or os`, {
          json: jsonHint,
          exitCode: 2,
        });
      }
      mode = val;
      i = res.nextIndex;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for daemon remove: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    } else if (slug === null) {
      slug = arg.trim();
    } else {
      emitCliError(`Unexpected argument for daemon remove: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  if (!all && !slug) {
    emitCliError("Usage: agy-loop daemon remove <slug> | --all [options]", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());

  let res;
  try {
    res = removeDaemon({
      slug,
      mode,
      all,
      workspaceDir: all && !globalMode ? workspaceDir : null,
      homeDir,
      noUnload,
      env: process.env,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const exitCode = /not found/i.test(msg) ? 1 : 2;
    emitCliError(msg, { json: jsonHint, exitCode });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (!res.removed || res.removed.length === 0) {
    process.stdout.write("No matching managed daemons found to remove.\n");
    return;
  }

  for (const item of res.removed) {
    process.stdout.write(
      `Removed ${item.mode} daemon ${item.slug}${item.config_path ? ` (${item.config_path})` : ""}\n`
    );
  }
}

async function handleDaemonLogs(rawArgs) {
  const jsonHint = rawArgs.includes("--json");
  let slug = null;
  let tail = 50;
  let cwd = null;
  let json = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop daemon logs <slug> [options]

Options:
  -n, --tail <N>  Number of trailing lines to print (default: 50)
  --cwd <dir>     Target workspace directory (default: current directory)
  --json          Emit JSON output
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--json") {
      json = true;
    } else if (flag === "-n" || flag === "--tail") {
      const res = readFlagValue(rawArgs, i, inlineVal, flag, jsonHint);
      tail = parsePositiveIntOption(res.value, flag, jsonHint);
      i = res.nextIndex;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else if (arg.startsWith("-")) {
      emitCliError(`Unknown option for daemon logs: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    } else if (slug === null) {
      slug = arg.trim();
    } else {
      emitCliError(`Unexpected argument for daemon logs: ${arg}`, {
        json: jsonHint,
        exitCode: 2,
      });
    }
  }

  if (!slug) {
    emitCliError("Usage: agy-loop daemon logs <slug> [-n|--tail <N>]", {
      json: jsonHint,
      exitCode: 2,
    });
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  let res;
  try {
    res = readDaemonLogs({ slug, tail, workspaceDir, homeDir, env: process.env });
  } catch (err) {
    emitCliError(err instanceof Error ? err.message : String(err), {
      json: jsonHint,
      exitCode: 2,
    });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return;
  }

  if (res.mode === "sidecar" || !res.exists) {
    process.stdout.write(`${res.message || "No log output."}\n`);
    return;
  }

  if (res.text) {
    process.stdout.write(`${res.text}\n`);
  } else {
    process.stdout.write(`Log file is empty (${res.logPath}).\n`);
  }
}

/**
 * Handles `agy-loop daemon <install|list|status|remove|logs> ...`.
 *
 * @param {string[]} rawArgs
 * @param {{ version?: string, pluginRoot?: string | null }} [ctx]
 */
export async function handleDaemon(rawArgs = [], { version = "2.0.0", pluginRoot = null } = {}) {
  void pluginRoot;
  const jsonHint = Array.isArray(rawArgs) && rawArgs.includes("--json");
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    if (jsonHint) {
      emitCliError("Missing daemon subcommand (expected install, list, status, remove, or logs)", {
        json: true,
        exitCode: 2,
      });
    }
    printDaemonHelp(version);
    return;
  }

  const sub = String(rawArgs[0]);
  if (sub === "-h" || sub === "--help") {
    printDaemonHelp(version);
    return;
  }

  const subArgs = rawArgs.slice(1);
  switch (sub) {
    case "install":
      await handleDaemonInstall(subArgs, { version });
      break;
    case "list":
      await handleDaemonList(subArgs, { checkStatus: false });
      break;
    case "status":
      await handleDaemonList(subArgs, { checkStatus: true });
      break;
    case "remove":
    case "uninstall":
      await handleDaemonRemove(subArgs);
      break;
    case "logs":
      await handleDaemonLogs(subArgs);
      break;
    default:
      emitCliError(
        `Unknown daemon subcommand '${sub}'. Expected install, list, status, remove, or logs.`,
        { json: jsonHint, exitCode: 2 }
      );
      break;
  }
}

/**
 * Handles `agy-loop status [--global] [--cwd <dir>] [--clean-shadow] [--json]` (Option A unified runtime overview).
 *
 * @param {string[]} rawArgs
 * @param {{ version?: string, runDoctorReport?: Function }} [ctx]
 */
export async function handleStatusOverview(
  rawArgs = [],
  { version = "2.0.0", runDoctorReport = null } = {}
) {
  const jsonHint = Array.isArray(rawArgs) && rawArgs.includes("--json");
  let globalMode = false;
  let cleanShadow = false;
  let json = false;
  let cwd = null;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = String(rawArgs[i]);
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`Usage:
  agy-loop status [options]

Options:
  --global        Show active loops and daemons across all workspaces
  --cwd <dir>     Target workspace directory (default: current directory)
  --clean-shadow  Move shadowing user-level loop files into a timestamped backup
  --json          Emit JSON status overview
  -h, --help      Show this help message
`);
      return;
    }

    const { flag, inlineVal } = splitFlagToken(arg);
    if (flag === "--global" || flag === "-g") {
      globalMode = true;
    } else if (flag === "--clean-shadow") {
      cleanShadow = true;
    } else if (flag === "--json") {
      json = true;
    } else if (flag === "--cwd") {
      const res = readFlagValue(rawArgs, i, inlineVal, "--cwd", jsonHint);
      cwd = res.value;
      i = res.nextIndex;
    } else {
      emitCliError(`Unknown argument for status: ${arg}`, { json: jsonHint, exitCode: 2 });
    }
  }

  const homeDir = resolveHome(process.env);
  const workspaceDir = path.resolve(cwd || process.cwd());
  const stateRoot = resolveStateRoot(workspaceDir, process.env);

  const activeLoops = globalMode
    ? listGlobalLoops({ includeAll: false, homeDir, env: process.env })
    : listLoops(stateRoot, { includeAll: false });
  const daemons = listDaemons({
    workspaceDir: globalMode ? null : workspaceDir,
    global: globalMode,
    homeDir,
    env: process.env,
    checkStatus: true,
  });
  const activeLocks = listLeaseLocks(stateRoot);

  const doctorReport =
    typeof runDoctorReport === "function"
      ? runDoctorReport({ cleanShadow, workspaceDir, allowMissingAgy: true })
      : { ok: true };

  const health = {
    ok: Boolean(doctorReport?.ok),
    agyFound: Boolean(doctorReport?.agy?.found),
    agyVersion: doctorReport?.agy?.version ?? null,
    pluginInstalled: Boolean(doctorReport?.plugin?.installed),
    pluginEnabled: Boolean(doctorReport?.plugin?.enabled),
    pluginVersion: doctorReport?.plugin?.version ?? null,
    shadows: Array.isArray(doctorReport?.shadows) ? doctorReport.shadows : [],
    shadowCount: Array.isArray(doctorReport?.shadows) ? doctorReport.shadows.length : 0,
    skillFilterWarningsCount: Array.isArray(doctorReport?.skillFilterWarnings)
      ? doctorReport.skillFilterWarnings.length
      : 0,
    environmentWarningsCount: Array.isArray(doctorReport?.environmentWarnings)
      ? doctorReport.environmentWarnings.length
      : 0,
    hookOk: Boolean(doctorReport?.hookSelfTest?.ok),
    workerToolsOk: Boolean(doctorReport?.agentToolsCheck?.ok),
    verifierToolsOk: Boolean(doctorReport?.verifierToolsCheck?.ok),
    workflowOk: Boolean(doctorReport?.workflowBundleCheck?.ok),
    activeLoopMd: doctorReport?.loopMd?.activeSource ?? "builtin",
    ...(doctorReport?.error ? { error: doctorReport.error } : {}),
    ...(doctorReport?.timedOut ? { timedOut: true } : {}),
  };

  if (json) {
    const payload = {
      ok: health.ok,
      version,
      workspaceDir,
      global: globalMode,
      activeLoops,
      daemons,
      activeLocks,
      health,
      ...(doctorReport?.backupDir
        ? {
            backupDir: doctorReport.backupDir,
            cleanedShadows: doctorReport.cleanedShadows || [],
          }
        : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `AGY Loop Status (v${version}) — ${globalMode ? "global" : workspaceDir}\n`
  );

  if (doctorReport?.movedShadows?.length > 0) {
    process.stdout.write(
      `  Cleaned shadows: ${doctorReport.movedShadows.length} archived to ${doctorReport.backupDir}\n`
    );
  }

  process.stdout.write(`\nActive Loops (${activeLoops.length}):\n`);
  if (activeLoops.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const loop of activeLoops) {
      const profileBadge = loop.profile_name ? ` [${loop.profile_name}]` : "";
      const staleBadge = loop.stale ? " [STALE]" : "";
      const tokBadge =
        loop.usage_totals?.total_tokens > 0
          ? `, ${formatTokens(loop.usage_totals.total_tokens)} tok`
          : "";
      process.stdout.write(
        `  - ${loop.loop_id}${profileBadge} (${loop.engine || "interactive"}, iter ${
          loop.iteration ?? "?"
        }/${loop.max_iterations ?? "?"}${tokBadge}${staleBadge})\n`
      );
    }
  }

  process.stdout.write(`\nManaged Daemons (${daemons.length}):\n`);
  if (daemons.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const d of daemons) {
      const loadText = d.loaded === null ? "" : d.loaded ? ", loaded" : ", unloaded";
      process.stdout.write(
        `  - ${d.slug} (${d.mode}/${d.platform || d.mode}, ${formatDaemonSchedule(d)}, installed=${
          d.installed ? "yes" : "no"
        }${loadText})\n`
      );
    }
  }

  process.stdout.write(`\nLease Locks (${activeLocks.length}):\n`);
  if (activeLocks.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    for (const lock of activeLocks) {
      const stateTag = lock.stale ? "stale" : lock.draining ? "draining" : "alive";
      process.stdout.write(
        `  - ${lock.scope_key} (${lock.scope || "?"}, profile=${lock.profile || "default"}, loop=${
          lock.loop_id || "?"
        }, pid=${lock.pid ?? "?"}, ${stateTag})\n`
      );
    }
  }

  process.stdout.write(
    `\nHealth: ${health.ok ? "ok" : "attention needed"} (agy=${
      health.agyFound ? health.agyVersion || "found" : "missing"
    }, plugin=${
      health.pluginInstalled ? (health.pluginEnabled ? "enabled" : "disabled") : "not installed"
    }, shadows=${health.shadowCount}, warnings=${
      health.skillFilterWarningsCount + health.environmentWarningsCount
    }, loop.md=${health.activeLoopMd})\n`
  );
  if (!health.ok) {
    process.stdout.write("  Run 'agy-loop doctor' for full diagnostics.\n");
  }
}
