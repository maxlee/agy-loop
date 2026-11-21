import { spawn } from "node:child_process";
import { toGoDuration } from "./duration.mjs";
import { EMPTY_USAGE, normalizeUsage, parseAgyError } from "./error-policy.mjs";
import { isOrchestratorModel } from "./models.mjs";

/**
 * Builds shared CLI flags for `agy` headless modes (`json` and `stream-json`).
 * Automatically omits `--effort` for Orchestrator models and enforces
 * `--disable-slash-commands` unless explicitly opted in.
 */
export function buildAgyCommonFlags({
  schemaPath = null,
  turnTimeoutSec = null,
  model = null,
  effort = null,
  mode = null,
  sandbox = false,
  dangerouslySkipPermissions = false,
  allowSlashCommands = false,
  settingsArg = null,
  addDirs = [],
  conversationId = null,
} = {}) {
  const args = [];

  if (typeof schemaPath === "string" && schemaPath.trim().length > 0) {
    args.push("--json-schema", schemaPath);
  }

  const timeoutNum = Number(turnTimeoutSec);
  if (
    turnTimeoutSec !== null &&
    turnTimeoutSec !== undefined &&
    turnTimeoutSec !== "" &&
    Number.isFinite(timeoutNum) &&
    timeoutNum > 0
  ) {
    args.push("--print-timeout", toGoDuration(timeoutNum));
  }

  const normalizedModel = typeof model === "string" ? model.trim() : "";
  if (normalizedModel.length > 0) {
    args.push("--model", normalizedModel);
  }

  // Orchestrator models reject or ignore --effort in agy v1.5.14; always omit it.
  const normalizedEffort = typeof effort === "string" ? effort.trim() : "";
  if (normalizedEffort.length > 0 && !isOrchestratorModel(normalizedModel)) {
    args.push("--effort", normalizedEffort);
  }

  if (typeof mode === "string" && mode.trim().length > 0) {
    args.push("--mode", mode.trim());
  }

  if (sandbox === true) {
    args.push("--sandbox");
  }

  if (dangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }

  if (allowSlashCommands !== true) {
    args.push("--disable-slash-commands");
  }

  if (typeof settingsArg === "string" && settingsArg.trim().length > 0) {
    args.push("--settings", settingsArg);
  } else if (settingsArg && typeof settingsArg === "object") {
    args.push("--settings", JSON.stringify(settingsArg));
  }

  if (Array.isArray(addDirs)) {
    for (const dir of addDirs) {
      if (typeof dir === "string" && dir.trim().length > 0) {
        args.push("--add-dir", dir);
      }
    }
  }

  if (typeof conversationId === "string" && conversationId.trim().length > 0) {
    args.push("--conversation", conversationId.trim());
  }

  return args;
}

/**
 * Prepares the child environment, optionally stripping desktop LS env vars for
 * isolated test runs without mutating the caller's env object.
 */
export function prepareAgyEnv(env = process.env, isolateSessionEnv = false) {
  const baseEnv = env && typeof env === "object" ? env : process.env;
  if (isolateSessionEnv !== true) {
    return baseEnv;
  }
  const cleanEnv = { ...baseEnv };
  delete cleanEnv.ANTIGRAVITY_LS_ADDRESS;
  delete cleanEnv.ANTIGRAVITY_CSRF_TOKEN;
  return cleanEnv;
}

/**
 * Sends SIGTERM and schedules a SIGKILL fallback after `graceMs`.
 * Returns a cleanup callback to cancel the fallback timer once the child exits.
 */
export function forceTerminateChild(child, { graceMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return () => {};
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Child may have exited before kill was delivered.
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill error if process already terminated.
      }
    }
  }, graceMs);
  killTimer.unref?.();
  return () => clearTimeout(killTimer);
}

/**
 * Schedules a short stdio destruction fallback after process `exit` so leaky
 * grandchild file descriptors cannot hold `close` open after forced termination.
 */
export function schedulePipeCloseFallback(child, delayMs = 500) {
  if (!child) {
    return () => {};
  }
  const timer = setTimeout(() => {
    try {
      child.stdout?.destroy();
    } catch {
      // Ignore destroy errors.
    }
    try {
      child.stderr?.destroy();
    } catch {
      // Ignore destroy errors.
    }
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Builds `agy` arguments for single-turn print mode (`--output-format json`).
 * All flags strictly precede `["-p", prompt]`.
 */
export function buildJsonTurnArgs({
  prompt,
  schemaPath = null,
  turnTimeoutSec = null,
  model = null,
  effort = null,
  mode = null,
  sandbox = false,
  dangerouslySkipPermissions = false,
  allowSlashCommands = false,
  settingsArg = null,
  addDirs = [],
  conversationId = null,
} = {}) {
  if (prompt === undefined || prompt === null) {
    throw new TypeError("buildJsonTurnArgs requires a prompt");
  }
  const promptStr = String(prompt);
  const promptArgs = promptStr.startsWith("-") ? [`-p=${promptStr}`] : ["-p", promptStr];
  return [
    "--output-format",
    "json",
    ...buildAgyCommonFlags({
      schemaPath,
      turnTimeoutSec,
      model,
      effort,
      mode,
      sandbox,
      dangerouslySkipPermissions,
      allowSlashCommands,
      settingsArg,
      addDirs,
      conversationId,
    }),
    ...promptArgs,
  ];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scanJsonObjectEnd(str, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }
  return -1;
}

/**
 * Parses full JSON stdout, falling back to locating the last valid outermost
 * JSON object if leading/trailing non-JSON lines are present.
 */
export function parseJsonEnvelope(stdout) {
  if (typeof stdout !== "string") {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to object scanner.
    }
  }

  let lastValid = null;
  let failedScans = 0;
  let idx = trimmed.indexOf("{");

  while (idx !== -1) {
    const end = scanJsonObjectEnd(trimmed, idx);
    if (end !== -1) {
      try {
        const candidate = JSON.parse(trimmed.slice(idx, end + 1));
        if (isPlainObject(candidate)) {
          lastValid = candidate;
          idx = trimmed.indexOf("{", end + 1);
          continue;
        }
      } catch {
        // Not a valid JSON object at idx; advance to next '{'.
      }
    }
    failedScans += 1;
    if (failedScans >= 5000) {
      break;
    }
    idx = trimmed.indexOf("{", idx + 1);
  }

  return lastValid;
}

/**
 * Executes a single headless `agy` turn with `--output-format json`.
 */
export async function runJsonTurn({
  prompt,
  cwd,
  schemaPath = null,
  turnTimeoutSec = 600,
  model = null,
  effort = null,
  mode = null,
  sandbox = false,
  dangerouslySkipPermissions = false,
  allowSlashCommands = false,
  settingsArg = null,
  addDirs = [],
  conversationId = null,
  signal = null,
  agyBin = "agy",
  env = process.env,
  isolateSessionEnv = false,
  outerTimeoutMs = null,
} = {}) {
  const args = buildJsonTurnArgs({
    prompt,
    schemaPath,
    turnTimeoutSec,
    model,
    effort,
    mode,
    sandbox,
    dangerouslySkipPermissions,
    allowSlashCommands,
    settingsArg,
    addDirs,
    conversationId,
  });

  if (signal?.aborted) {
    return {
      exitCode: 130,
      timedOut: false,
      aborted: true,
      result: null,
      agyError: null,
      rawStdout: "",
      rawStderr: "",
      sawFinishTool: true,
      usageDelta: { ...EMPTY_USAGE },
    };
  }

  const spawnEnv = prepareAgyEnv(env, isolateSessionEnv);
  const effectiveOuterMs =
    outerTimeoutMs !== null && outerTimeoutMs !== undefined
      ? Number(outerTimeoutMs)
      : Number.isFinite(Number(turnTimeoutSec)) && Number(turnTimeoutSec) > 0
        ? (Number(turnTimeoutSec) + 60) * 1000
        : 0;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(agyBin, args, {
        cwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const rawStderr = err?.message || String(err);
      resolve({
        exitCode: 1,
        timedOut: false,
        aborted: false,
        result: null,
        agyError: parseAgyError(rawStderr),
        rawStdout: "",
        rawStderr,
        sawFinishTool: true,
        usageDelta: { ...EMPTY_USAGE },
      });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let spawnError = null;
    let cancelKillFallback = () => {};
    let cancelPipeFallback = () => {};
    let watchdogTimer = null;

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    const finalize = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdogTimer !== null) {
        clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      cancelKillFallback();
      cancelPipeFallback();

      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
      let rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError && !rawStderr) {
        rawStderr = spawnError.message || String(spawnError);
      }

      const result = parseJsonEnvelope(rawStdout);
      const agyError = parseAgyError(rawStderr);
      const usageDelta = normalizeUsage(
        result?.usage,
        result?.duration_seconds,
        result?.num_turns
      );

      let exitCode;
      if (aborted) {
        exitCode = 130;
      } else if (timedOut) {
        exitCode = 3;
      } else if (typeof code === "number") {
        exitCode = code;
      } else {
        exitCode = 1;
      }

      resolve({
        exitCode,
        timedOut,
        aborted,
        result,
        agyError,
        rawStdout,
        rawStderr,
        sawFinishTool: true,
        usageDelta,
      });
    };

    const onAbort = () => {
      if (settled || aborted) {
        return;
      }
      aborted = true;
      cancelKillFallback();
      cancelKillFallback = forceTerminateChild(child, { graceMs: 5000 });
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (Number.isFinite(effectiveOuterMs) && effectiveOuterMs > 0) {
      watchdogTimer = setTimeout(() => {
        if (settled || aborted || timedOut) {
          return;
        }
        timedOut = true;
        cancelKillFallback();
        cancelKillFallback = forceTerminateChild(child, { graceMs: 5000 });
      }, effectiveOuterMs);
      watchdogTimer.unref?.();
    }

    child.once("exit", () => {
      if (!settled && (aborted || timedOut)) {
        cancelPipeFallback();
        cancelPipeFallback = schedulePipeCloseFallback(child, 500);
      }
    });

    child.on("error", (err) => {
      spawnError = err;
      // On ENOENT/spawn failure, close may not always follow in every environment.
      if (child.pid === undefined) {
        finalize(1);
      }
    });

    child.on("close", (code) => {
      finalize(code);
    });
  });
}
