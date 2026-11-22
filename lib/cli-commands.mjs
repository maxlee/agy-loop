/**
 * CLI subcommand handlers for `agy-loop run | resume | nudge | wake | ps | list | logs | stop | statusline`.
 */

import path from "node:path";

import { formatDuration, formatTokens, parseDurationStrict } from "./duration.mjs";
import { formatRunHelp, parseRunArgs } from "./parse-run-args.mjs";
import { resumeHeadlessLoop, runHeadlessLoop } from "./runner.mjs";
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
export async function handleRun(rawArgs, { version = "1.3.0" } = {}) {
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
export async function handleResume(rawArgs = [], { version = "1.3.0" } = {}) {
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
