import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatDuration,
  isUnitWord,
  parseDurationStrict,
  toGoDuration,
  tryParseCompactDuration,
  tryParseSplitDuration,
  formatTokens,
} from "../lib/duration.mjs";
import {
  EMPTY_USAGE,
  addUsageTotals,
  checkBudgets,
  classifyTurnFailure,
  computeUsageDelta,
  isNonRetryableQuotaError,
  isQuotaOrRateLimitError,
  parseAgyError,
} from "../lib/error-policy.mjs";
import { buildJsonTurnArgs, parseJsonEnvelope, runJsonTurn } from "../lib/json-client.mjs";
import {
  fetchModelCatalog,
  isOrchestratorModel,
  parseModelsJsonOutput,
  resolveModelSlug,
} from "../lib/models.mjs";
import { formatRunHelp, parseRunArgs } from "../lib/parse-run-args.mjs";
import { EXIT_CODES, runHeadlessLoop, sleepInterruptible } from "../lib/runner.mjs";
import {
  ITERATION_RESULT_SCHEMA,
  VERIFIER_RESULT_SCHEMA,
  buildVerifierPrompt,
  buildWorkerPrompt,
  extractIterationOutcome,
  extractVerifierOutcome,
  parseFourLineFooter,
  writeSchemaFiles,
} from "../lib/schemas.mjs";
import {
  createLoopState,
  listLoops,
  readControl,
  readEvents,
  readLoopState,
  resolveLoopMdTask,
  updateLoopState,
  upsertGlobalIndex,
  validateLoopId,
  writeControlStop,
} from "../lib/state-store.mjs";
import { StreamSession } from "../lib/stream-client.mjs";
import { handleStatusline } from "../lib/cli-commands.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "agy-loop.mjs");
const HELPER_SH_PATH = path.join(REPO_ROOT, "skills", "loop", "scripts", "loop-helper.sh");
const REAL_HOME = os.homedir();

const DEFAULT_MOCK_MODELS = [
  "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (xHigh)",
  "gemini-4-carbon-high\tGemini 4 Carbon (High)",
  "gemini-4-carbon-low\tGemini 4 Carbon (Low)",
  "gemini-4-neon-xhigh\tGemini 4 Neon (xHigh)",
  "gemini-pro-orchestrator-neon\tOrchestrator (Neon)",
].join("\n");

function makeMockAgyScript() {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const callsFile = process.env.MOCK_AGY_CALLS;
const stateFile = process.env.MOCK_AGY_STATE;
const scenarioFile = process.env.MOCK_AGY_SCENARIO;

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, obj) {
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
}

function logCall(record) {
  if (!callsFile) return;
  fs.appendFileSync(callsFile, JSON.stringify(record) + "\\n", "utf8");
}

function getFlagValue(flagName) {
  const idx = args.indexOf(flagName);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

function applySideEffects(spec) {
  if (!spec || typeof spec !== "object") return;
  if (spec.mutateFile && spec.mutateFile.path) {
    const targetPath = path.isAbsolute(spec.mutateFile.path)
      ? spec.mutateFile.path
      : path.join(process.cwd(), spec.mutateFile.path);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, spec.mutateFile.content ?? "", "utf8");
  }
  if (spec.gitCommit && spec.gitCommit.file) {
    const targetPath = path.join(process.cwd(), spec.gitCommit.file);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, spec.gitCommit.content ?? "worktree change\\n", "utf8");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const addRes = spawnSync(
      "git",
      ["-c", "commit.gpgsign=false", "add", spec.gitCommit.file],
      { cwd: process.cwd(), env: gitEnv, encoding: "utf8" }
    );
    if (addRes.status !== 0) {
      throw new Error("mock git add failed: " + addRes.stderr);
    }
    const commitRes = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test User",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        spec.gitCommit.message || "worktree commit",
      ],
      { cwd: process.cwd(), env: gitEnv, encoding: "utf8" }
    );
    if (commitRes.status !== 0) {
      throw new Error("mock git commit failed: " + commitRes.stderr);
    }
  }
}

const scenario = scenarioFile ? readJsonSafe(scenarioFile, {}) : {};

if (args[0] === "--version") {
  logCall({ mode: "version", args });
  fs.writeSync(1, (process.env.MOCK_AGY_VERSION || "1.5.14") + "\\n");
  process.exit(0);
}

if (!args.includes("-p") && args.includes("models")) {
  logCall({ mode: "models", args });
  if (scenario.modelsSpinnerPrefix) {
    fs.writeSync(1, "\\r⠋ Loading models...\\r\\n");
  }
  const payload = scenario.modelsPayload || {
    status: "SUCCESS",
    response: ${JSON.stringify(DEFAULT_MOCK_MODELS)},
  };
  fs.writeSync(1, JSON.stringify(payload) + "\\n");
  process.exit(scenario.modelsExitCode ?? 0);
}

if (args.includes("--input-format") && getFlagValue("--input-format") === "stream-json") {
  const st = readJsonSafe(stateFile, { jsonWorkerIdx: 0, jsonVerifierIdx: 0, streamSessionIdx: 0 });
  const sessionIdx = st.streamSessionIdx || 0;
  st.streamSessionIdx = sessionIdx + 1;
  writeJsonSafe(stateFile, st);

  const convArg = getFlagValue("--conversation");
  const schemaPath = getFlagValue("--json-schema");
  let schema = null;
  if (schemaPath && fs.existsSync(schemaPath)) {
    schema = readJsonSafe(schemaPath, null);
  }
  logCall({
    mode: "stream-start",
    sessionIdx,
    args,
    cwd: process.cwd(),
    conversationArg: convArg,
    schema,
  });

  const sessionSpec = (scenario.streamSessions && scenario.streamSessions[sessionIdx]) || {};
  if (sessionSpec.startupStderr) {
    fs.writeSync(2, sessionSpec.startupStderr);
  }
  if (sessionSpec.startupExitCode != null) {
    if (sessionSpec.startupDelayMs && sessionSpec.startupDelayMs > 0) {
      setTimeout(() => process.exit(sessionSpec.startupExitCode), sessionSpec.startupDelayMs);
    } else {
      process.exit(sessionSpec.startupExitCode);
    }
  }
  const convId = convArg || sessionSpec.conversationId || \`conv-stream-\${sessionIdx + 1}\`;
  if (sessionSpec.emitInit !== false) {
    fs.writeSync(1, JSON.stringify({ event: "init", conversation_id: convId }) + "\\n");
  }

  let buf = "";
  let turnIdx = 0;
  let stdinEnded = false;
  let chain = Promise.resolve();

  const maybeExitOnEnd = () => {
    if (sessionSpec.ignoreStdinEof) {
      return;
    }
    chain.then(() => {
      if (stdinEnded) {
        process.exit(0);
      }
    });
  };

  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const curTurn = turnIdx++;
    const turnSpec = (sessionSpec.turns && sessionSpec.turns[curTurn]) || {};
    logCall({
      mode: "stream-turn",
      sessionIdx,
      turnInSession: curTurn,
      prompt: msg?.message?.content ?? "",
    });

    if (turnSpec.sleepMs && turnSpec.sleepMs > 0) {
      await new Promise((r) => setTimeout(r, turnSpec.sleepMs));
    }

    applySideEffects(turnSpec);

    const steps =
      turnSpec.steps !== undefined
        ? turnSpec.steps
        : turnSpec.emitFinish === false
          ? [{ tool_name: "run_command" }]
          : [{ tool_name: "run_command" }, { tool_name: "finish" }];

    for (const step of steps) {
      fs.writeSync(
        1,
        JSON.stringify({
          event: "step_update",
          conversation_id: convId,
          step_update: step,
        }) + "\\n"
      );
    }

    if (turnSpec.stderr) {
      fs.writeSync(2, turnSpec.stderr);
    }

    if (turnSpec.exitCode && turnSpec.exitCode !== 0 && !turnSpec.result) {
      process.exit(turnSpec.exitCode);
    }

    if (turnSpec.stderr || (sessionSpec.startupStderr && curTurn === 0)) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const resultObj = {
      conversation_id: convId,
      ...(turnSpec.result || {}),
    };
    const eventLine = JSON.stringify({
      event: "result",
      conversation_id: convId,
      result: resultObj,
    }) + "\\n";

    if (turnSpec.splitUtf8Chunk) {
      const bytes = Buffer.from(eventLine, "utf8");
      // Split deliberately inside multi-byte sequence if present, else midpoint
      let splitAt = Math.floor(bytes.length / 2);
      for (let i = 0; i < bytes.length - 1; i += 1) {
        if (bytes[i] >= 0xe0) {
          splitAt = i + 1;
          break;
        }
      }
      fs.writeSync(1, bytes.subarray(0, splitAt));
      await new Promise((r) => setTimeout(r, 15));
      fs.writeSync(1, bytes.subarray(splitAt));
    } else {
      fs.writeSync(1, eventLine);
    }

    if (turnSpec.exitCode && turnSpec.exitCode !== 0) {
      process.exit(turnSpec.exitCode);
    }
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl = buf.indexOf("\\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      chain = chain.then(() => handleLine(line));
      nl = buf.indexOf("\\n");
    }
  });
  process.stdin.on("end", () => {
    if (buf.trim()) {
      const rem = buf;
      buf = "";
      chain = chain.then(() => handleLine(rem));
    }
    stdinEnded = true;
    maybeExitOnEnd();
  });
} else {
  const schemaPath = getFlagValue("--json-schema");
  const turnKind =
    schemaPath && path.basename(schemaPath) === "verifier-schema.json" ? "verifier" : "worker";
  let schema = null;
  if (schemaPath && fs.existsSync(schemaPath)) {
    schema = readJsonSafe(schemaPath, null);
  }

  const st = readJsonSafe(stateFile, { jsonWorkerIdx: 0, jsonVerifierIdx: 0, streamSessionIdx: 0 });
  const idx = turnKind === "verifier" ? st.jsonVerifierIdx || 0 : st.jsonWorkerIdx || 0;
  if (turnKind === "verifier") {
    st.jsonVerifierIdx = idx + 1;
  } else {
    st.jsonWorkerIdx = idx + 1;
  }
  writeJsonSafe(stateFile, st);

  logCall({
    mode: "json",
    turnKind,
    turnIdx: idx,
    args,
    cwd: process.cwd(),
    schema,
    envLs: process.env.ANTIGRAVITY_LS_ADDRESS ?? null,
    envCsrf: process.env.ANTIGRAVITY_CSRF_TOKEN ?? null,
  });

  const list = turnKind === "verifier" ? scenario.verifierTurns : scenario.jsonTurns;
  const turnSpec = (Array.isArray(list) && list[idx]) || {};

  const run = () => {
    applySideEffects(turnSpec);
    if (turnSpec.stderr) {
      fs.writeSync(2, turnSpec.stderr);
    }
    if (turnSpec.rawStdout != null) {
      fs.writeSync(1, turnSpec.rawStdout);
    } else if (turnSpec.envelope !== undefined) {
      if (turnSpec.envelope !== null) {
        fs.writeSync(1, JSON.stringify(turnSpec.envelope) + "\\n");
      }
    } else {
      fs.writeSync(
        1,
        JSON.stringify({
          status: "SUCCESS",
          conversation_id: "conv-json-" + (idx + 1),
          usage: { total_tokens: 100 },
          structured_output: {
            iteration: idx + 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Default mock done",
            next_hint: "None",
          },
        }) + "\\n"
      );
    }
    process.exit(turnSpec.exitCode ?? 0);
  };

  if (turnSpec.sleepMs && turnSpec.sleepMs > 0) {
    setTimeout(run, turnSpec.sleepMs);
  } else {
    run();
  }
}
`;
}

function makeHeadlessSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-headless-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const indexPath = path.join(root, "global-index.json");
  const mockBin = path.join(root, "mock-bin");
  const callsFile = path.join(root, "mock-agy-calls.jsonl");
  const counterFile = path.join(root, "mock-agy-state.json");
  const scenarioFile = path.join(root, "mock-agy-scenario.json");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mockAgyPath = path.join(mockBin, "agy");
  fs.writeFileSync(mockAgyPath, makeMockAgyScript(), { mode: 0o755 });

  const nodeBinDir = path.dirname(process.execPath);
  const baseEnv = {
    ...process.env,
    HOME: home,
    AGY_LOOP_STATE_DIR: stateDir,
    MOCK_AGY_CALLS: callsFile,
    MOCK_AGY_STATE: counterFile,
    MOCK_AGY_SCENARIO: scenarioFile,
    PATH: `${mockBin}${path.delimiter}${nodeBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
  delete baseEnv.AGY_LOOP_INDEX_PATH;
  delete baseEnv.ANTIGRAVITY_LS_ADDRESS;
  delete baseEnv.ANTIGRAVITY_CSRF_TOKEN;

  assert.notEqual(baseEnv.HOME, REAL_HOME);

  const gitEnv = {
    ...baseEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  function setScenario(scenario) {
    fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), "utf8");
    fs.rmSync(counterFile, { force: true });
    fs.rmSync(callsFile, { force: true });
  }

  function readCalls() {
    if (!fs.existsSync(callsFile)) return [];
    return fs
      .readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function runCli(args, { cwd = workspace, env = baseEnv } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  function spawnCli(args, { cwd = workspace, env = baseEnv } = {}) {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore cleanup errors.
        }
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    const done = new Promise((resolve) => {
      child.on("close", (status, signal) => {
        resolve({ status, signal, stdout, stderr });
      });
    });
    return { child, done, getOutput: () => ({ stdout, stderr }) };
  }

  function runGit(args, cwd = workspace) {
    return spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: gitEnv,
      encoding: "utf8",
    });
  }

  function initGitRepo(dir = workspace) {
    assert.equal(runGit(["init"], dir).status, 0);
    assert.equal(runGit(["config", "user.name", "Test User"], dir).status, 0);
    assert.equal(runGit(["config", "user.email", "test@example.com"], dir).status, 0);
    fs.writeFileSync(path.join(dir, "README.md"), "init\n", "utf8");
    assert.equal(runGit(["add", "README.md"], dir).status, 0);
    const commitRes = runGit(["commit", "-m", "initial commit"], dir);
    assert.equal(commitRes.status, 0, commitRes.stderr);
  }

  return {
    root,
    home,
    workspace,
    stateDir,
    indexPath,
    mockAgyPath,
    baseEnv,
    gitEnv,
    setScenario,
    readCalls,
    runCli,
    spawnCli,
    runGit,
    initGitRepo,
  };
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ============================================================================
// 1. PURE UNIT TESTS
// ============================================================================

test("unit: lib/duration.mjs handles compound/split durations, errors, and formatters", () => {
  assert.equal(isUnitWord("s"), "s");
  assert.equal(isUnitWord("MINUTES,"), "m");
  assert.equal(isUnitWord("hrs"), "h");
  assert.equal(isUnitWord("Days"), "d");
  assert.equal(isUnitWord("weeks"), null);
  assert.equal(isUnitWord(null), null);

  assert.deepEqual(tryParseCompactDuration("30s"), { seconds: 30, label: "30s" });
  assert.deepEqual(tryParseCompactDuration("1h30m"), { seconds: 5400, label: "1h30m" });
  assert.deepEqual(tryParseCompactDuration("2m30s,"), { seconds: 150, label: "2m30s" });
  assert.deepEqual(tryParseCompactDuration("1d12h"), { seconds: 129600, label: "1d12h" });
  assert.equal(tryParseCompactDuration("hello"), null);
  assert.equal(tryParseCompactDuration("5"), null);

  assert.deepEqual(tryParseSplitDuration("5", "minutes"), { seconds: 300, label: "5m" });
  assert.deepEqual(tryParseSplitDuration("2", "hours,"), { seconds: 7200, label: "2h" });
  assert.equal(tryParseSplitDuration("five", "minutes"), null);

  assert.deepEqual(parseDurationStrict("1h30m"), { seconds: 5400, label: "1h30m" });
  assert.deepEqual(parseDurationStrict("5 minutes"), { seconds: 300, label: "5m" });

  for (const bad of ["0m", "1h0m", "1m2m", "1.5m", ".5h", "0 minutes", "1.5 hours", "5m,", ""]) {
    assert.throws(() => parseDurationStrict(bad, "--turn-timeout"), /Invalid --turn-timeout/);
  }
  assert.throws(() => tryParseCompactDuration("0s"), /duration must be >= 1/);
  assert.throws(() => tryParseCompactDuration("1h2h"), /duplicate unit/);
  assert.throws(() => tryParseCompactDuration("1.5m"), /fractional durations/);
  assert.throws(() => tryParseSplitDuration("0", "minutes"), /duration must be >= 1/);
  assert.throws(() => tryParseSplitDuration("0.5", "hours"), /fractional durations/);

  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(-3), "0s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(150), "2m30s");
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(formatDuration(129600), "1d12h");

  assert.equal(toGoDuration(600), "600s");
  assert.equal(toGoDuration(0), "0s");
  assert.equal(toGoDuration(12.4), "12s");

  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(850), "850");
  assert.equal(formatTokens(12400), "12.4k");
  assert.equal(formatTokens(1200000), "1.2M");
});

test("unit: lib/parse-run-args.mjs covers intervals, all flags, conflicts, and '--' boundary", () => {
  assert.match(formatRunHelp(), /Usage:\s+agy-loop run/);

  const helpRes = parseRunArgs(["--help"]);
  assert.equal(helpRes.ok, true);
  assert.equal(helpRes.help, true);

  // Bare -> loop.md hot-reload
  const bare = parseRunArgs([]);
  assert.equal(bare.ok, true);
  assert.equal(bare.pacing, "dynamic");
  assert.equal(bare.taskSource, "loop_md_or_default");
  assert.equal(bare.prompt, "");
  assert.equal(bare.maxIterations, 20);
  assert.equal(bare.stateMode, "fresh");

  // Leading & trailing intervals
  const leadEvery = parseRunArgs(["every", "2m30s", "check", "ci"]);
  assert.equal(leadEvery.ok, true);
  assert.equal(leadEvery.pacing, "fixed");
  assert.equal(leadEvery.intervalSec, 150);
  assert.equal(leadEvery.prompt, "check ci");

  const trailEvery = parseRunArgs(["check", "ci,", "every", "5", "minutes"]);
  assert.equal(trailEvery.ok, true);
  assert.equal(trailEvery.pacing, "fixed");
  assert.equal(trailEvery.intervalSec, 300);
  assert.equal(trailEvery.prompt, "check ci");

  const in20m = parseRunArgs(["in", "20m", "verify", "rollout"]);
  assert.equal(in20m.ok, true);
  assert.equal(in20m.once, true);
  assert.equal(in20m.maxIterations, 1);
  assert.equal(in20m.intervalSec, 1200);
  assert.equal(in20m.prompt, "verify rollout");

  const compound = parseRunArgs(["1h30m", "sync", "branches"]);
  assert.equal(compound.ok, true);
  assert.equal(compound.intervalSec, 5400);
  assert.equal(compound.intervalLabel, "1h30m");

  // Full flag matrix
  const full = parseRunArgs([
    "30s",
    "--stateful",
    "--reset-every",
    "4",
    "--max",
    "12",
    "--max-duration",
    "2h",
    "--max-tokens",
    "50000",
    "--max-retries",
    "2",
    "--max-errors",
    "5",
    "--model",
    "gemini-4-hydrogen-xhigh",
    "--effort",
    "xhigh",
    "--fallback-model",
    "gemini-4-carbon-high",
    "--verifier-model",
    "gemini-4-neon-xhigh",
    "--mode",
    "accept-edits",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--allow-slash-commands",
    "--settings",
    '{"a":1}',
    "--add-dir",
    "/tmp/dir1",
    "--add-dir=/tmp/dir2",
    "--worktree",
    "--keep-worktree",
    "--turn-timeout",
    "3m",
    "--fail-on-denied",
    "--probe",
    "npm test",
    "--probe-timeout",
    "45s",
    "--probe-until-pass",
    "--json",
    "--quiet",
    "--cwd",
    "/tmp/ws",
    "--",
    "--statefull",
    "literal",
  ]);
  assert.equal(full.ok, true);
  assert.equal(full.stateMode, "stateful");
  assert.equal(full.resetEvery, 4);
  assert.equal(full.maxIterations, 12);
  assert.equal(full.maxDurationSec, 7200);
  assert.equal(full.maxTokens, 50000);
  assert.equal(full.maxRetries, 2);
  assert.equal(full.maxErrors, 5);
  assert.equal(full.model, "gemini-4-hydrogen-xhigh");
  assert.equal(full.effort, "xhigh");
  assert.equal(full.fallbackModel, "gemini-4-carbon-high");
  assert.equal(full.verifierModel, "gemini-4-neon-xhigh");
  assert.equal(full.mode, "accept-edits");
  assert.equal(full.sandbox, true);
  assert.equal(full.dangerouslySkipPermissions, true);
  assert.equal(full.allowSlashCommands, true);
  assert.equal(full.settingsArg, '{"a":1}');
  assert.deepEqual(full.addDirs, ["/tmp/dir1", "/tmp/dir2"]);
  assert.equal(full.worktree, true);
  assert.equal(full.keepWorktree, true);
  assert.equal(full.workspace, "branch");
  assert.equal(full.turnTimeoutSec, 180);
  assert.equal(full.failOnDenied, true);
  assert.equal(full.probeCmd, "npm test");
  assert.equal(full.probeTimeoutSec, 45);
  assert.equal(full.probeUntilPass, true);
  assert.equal(full.json, true);
  assert.equal(full.quiet, true);
  assert.equal(full.cwd, "/tmp/ws");
  assert.equal(full.prompt, "--statefull literal");

  // Conflicts & invalid options (exitCode 2)
  const conflictCases = [
    ["--stateful", "--fresh", "check"],
    ["--once", "--max", "5", "check"],
    ["in", "20m", "--max", "5", "check"],
    ["--reset-every", "2", "check"],
    ["--probe-until-pass", "check"],
    ["--unknown-flag", "check"],
    ["--statefull", "check"],
    ["--effort", "turbo", "check"],
    ["--mode", "yolo", "check"],
    ["--max", "0", "check"],
    ["--model"],
  ];
  for (const badArgs of conflictCases) {
    const res = parseRunArgs(badArgs);
    assert.equal(res.ok, false, `Expected failure for ${badArgs.join(" ")}`);
    assert.equal(res.exitCode, 2);
    assert.ok(res.error);
  }
  const typo = parseRunArgs(["--statefull", "check"]);
  assert.match(typo.error, /--stateful/);
});

test("unit: lib/schemas.mjs validates schemas, stale guards, 4-line fallback, and verifier outcomes", (t) => {
  assert.equal(ITERATION_RESULT_SCHEMA.type, "object");
  assert.equal(VERIFIER_RESULT_SCHEMA.type, "object");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-schema-unit-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const { iterSchemaPath, verifierSchemaPath } = writeSchemaFiles(tmpDir);
  assert.equal(JSON.parse(fs.readFileSync(iterSchemaPath, "utf8")).type, "object");
  assert.equal(JSON.parse(fs.readFileSync(verifierSchemaPath, "utf8")).type, "object");

  const wp = buildWorkerPrompt({
    iteration: 2,
    maxIterations: 5,
    stateMode: "stateful",
    workspaceMode: "branch",
    pacing: "fixed",
    nextHint: "Check test failure",
    taskPrompt: "Fix tests",
    probeOutput: "FAIL src/a.test.js",
    worktreeBranch: "agy-loop/lp_1",
  });
  assert.match(wp, /ITERATION 2\/5/);
  assert.match(wp, /<<<PROBE_OUTPUT/);
  assert.match(wp, /agy-loop\/lp_1/);

  const vp = buildVerifierPrompt({
    iteration: 2,
    taskPrompt: "Fix tests",
    workerSummary: "All fixed",
    gitStatus: "M src/a.js",
    diffStat: "1 file changed",
  });
  assert.match(vp, /INDEPENDENT VERIFIER — ITERATION 2/);
  assert.match(vp, /All fixed/);

  // Fresh valid structured_output
  const freshOk = extractIterationOutcome(
    {
      structured_output: {
        iteration: 2,
        loop_status: "DONE",
        next_delay_sec: 15,
        summary: "All tests pass",
        next_hint: "None",
        changed_files: ["src/a.js"],
      },
    },
    2,
    true
  );
  assert.equal(freshOk.valid, true);
  assert.equal(freshOk.source, "structured_output");
  assert.equal(freshOk.data.next_delay_sec, 0);

  // Stale iteration mismatch rejected
  const staleIter = extractIterationOutcome(
    {
      structured_output: {
        iteration: 1,
        loop_status: "DONE",
        next_delay_sec: 0,
        summary: "Old turn 1 output",
        next_hint: "None",
      },
      response: "No footer here",
    },
    2,
    false
  );
  assert.equal(staleIter.valid, false);
  assert.equal(staleIter.stale, true);
  assert.match(staleIter.reason, /Stale structured_output/);

  // !sawFinishTool guard when iteration missing
  const noFinish = extractIterationOutcome(
    {
      structured_output: {
        loop_status: "DONE",
        next_delay_sec: 0,
        summary: "Missing iteration and finish",
        next_hint: "None",
      },
    },
    2,
    false
  );
  assert.equal(noFinish.valid, false);
  assert.equal(noFinish.stale, true);

  // 4-line footer fallback
  const footerText = [
    "Checked workspace.",
    "```",
    "**LOOP_STATUS:** CONTINUE",
    "NEXT_DELAY_SEC: 45",
    "SUMMARY: Build still pending",
    "NEXT_HINT: Poll CI again",
    "```",
  ].join("\n");
  assert.deepEqual(parseFourLineFooter(footerText), {
    loop_status: "CONTINUE",
    next_delay_sec: 45,
    summary: "Build still pending",
    next_hint: "Poll CI again",
  });
  const fallbackOut = extractIterationOutcome({ response: footerText }, 3, false);
  assert.equal(fallbackOut.valid, true);
  assert.equal(fallbackOut.source, "footer");
  assert.equal(fallbackOut.data.iteration, 3);

  // Malformed rejection
  assert.equal(
    extractIterationOutcome(
      { structured_output: { iteration: 1, loop_status: "DONE", next_delay_sec: 0, summary: "  " } },
      1,
      true
    ).valid,
    false
  );
  assert.equal(extractIterationOutcome(null, 1, true).valid, false);

  // Verifier outcome
  const verFail = extractVerifierOutcome({
    structured_output: {
      passed: false,
      summary: "Unit test failed",
      issues: ["Missing edge case check"],
    },
  });
  assert.equal(verFail.valid, true);
  assert.equal(verFail.data.passed, false);
  assert.deepEqual(verFail.data.issues, ["Missing edge case check"]);

  const verRespJson = extractVerifierOutcome({
    response: 'Report:\n```json\n{"passed":true,"summary":"LGTM","issues":[]}\n```',
  });
  assert.equal(verRespJson.valid, true);
  assert.equal(verRespJson.source, "response_json");
  assert.equal(verRespJson.data.passed, true);

  assert.equal(
    extractVerifierOutcome({ structured_output: { passed: "yes", summary: "x", issues: [] } }).valid,
    false
  );
});

test("unit: lib/error-policy.mjs handles AGY_ERROR, failure classification, usage delta, and budgets", () => {
  const errPayload = parseAgyError(
    [
      "noise line",
      'AGY_ERROR: {"short_error":"Old"}',
      "AGY_ERROR: {broken json",
      'AGY_ERROR: {"status":429,"error_code":"RESOURCE_EXHAUSTED","retryable":true,"short_error":"Rate limited"}',
    ].join("\n")
  );
  assert.equal(errPayload.status, 429);
  assert.equal(errPayload.error_code, "RESOURCE_EXHAUSTED");
  assert.equal(parseAgyError("no structured error"), null);

  // Fatal config exit 1 / 2
  assert.equal(
    classifyTurnFailure({
      exitCode: 2,
      rawStderr: "429 rate limit",
      fallbackModel: "gemini-4-carbon-high",
    }).action,
    "fatal_config"
  );
  assert.equal(classifyTurnFailure({ exitCode: 1 }).action, "fatal_config");

  // Quota -> switch_fallback
  const fb = classifyTurnFailure({
    exitCode: 3,
    agyError: errPayload,
    activeModel: "gemini-4-hydrogen-xhigh",
    fallbackModel: "gemini-4-carbon-high",
    alreadyOnFallback: false,
  });
  assert.equal(fb.action, "switch_fallback");
  assert.equal(fb.nextModel, "gemini-4-carbon-high");
  assert.equal(fb.delaySec, 5);

  // Non-retryable weekly cap -> blocked
  const weeklyCap = {
    status: 429,
    error_code: "RESOURCE_EXHAUSTED",
    retryable: false,
    short_error: "Weekly usage limit reached",
  };
  assert.equal(isNonRetryableQuotaError(weeklyCap), true);
  assert.equal(isQuotaOrRateLimitError(weeklyCap), true);
  assert.equal(
    classifyTurnFailure({
      exitCode: 3,
      agyError: weeklyCap,
      activeModel: "gemini-4-carbon-high",
      fallbackModel: null,
    }).action,
    "blocked"
  );

  // Retryable print_timeout / 429 with jittered backoff
  const r1 = classifyTurnFailure({
    exitCode: 3,
    result: { finished_reason: "print_timeout" },
    attempt: 1,
    maxRetries: 3,
    rng: () => 0.5,
  });
  assert.equal(r1.action, "retry");
  assert.equal(r1.delaySec, 30);

  const r2 = classifyTurnFailure({
    exitCode: 3,
    agyError: errPayload,
    alreadyOnFallback: true,
    attempt: 2,
    maxRetries: 3,
    rng: () => 1,
  });
  assert.equal(r2.action, "retry");
  assert.equal(r2.delaySec, 69); // 60 * 1.15

  const rExhausted = classifyTurnFailure({
    exitCode: 3,
    agyError: errPayload,
    alreadyOnFallback: true,
    attempt: 4,
    maxRetries: 3,
  });
  assert.equal(rExhausted.action, "blocked");

  // Cumulative usage delta + clamp >= 0
  const { delta: d1, nextTotals: t1 } = computeUsageDelta(
    { input_tokens: 100, output_tokens: 50, total_tokens: 150, duration_seconds: 1.5, num_turns: 1 },
    EMPTY_USAGE
  );
  assert.equal(d1.total_tokens, 150);
  const { delta: d2 } = computeUsageDelta(
    { input_tokens: 180, output_tokens: 40, total_tokens: 230, duration_seconds: 2.0, num_turns: 2 },
    t1
  );
  assert.equal(d2.input_tokens, 80);
  assert.equal(d2.output_tokens, 0); // clamped
  assert.equal(d2.total_tokens, 80);
  assert.equal(d2.duration_seconds, 0.5);
  const sum = addUsageTotals(d1, d2);
  assert.equal(sum.total_tokens, 230);

  // Budget checks
  assert.equal(
    checkBudgets({ iteration: 1, maxIterations: 5, elapsedSec: 10, consecutiveErrors: 3, maxErrors: 3 })
      .status,
    "circuit_broken"
  );
  assert.equal(
    checkBudgets({ iteration: 6, maxIterations: 5, elapsedSec: 10 }).exitReason,
    "max_iterations"
  );
  assert.equal(
    checkBudgets({ iteration: 1, maxIterations: 5, elapsedSec: 61, maxDurationSec: 60 }).exitReason,
    "max_duration"
  );
  assert.equal(
    checkBudgets({
      iteration: 1,
      maxIterations: 5,
      elapsedSec: 1,
      usageTotals: { total_tokens: 500 },
      maxTokens: 500,
    }).exitReason,
    "max_tokens"
  );
  assert.equal(checkBudgets({ iteration: 2, maxIterations: 5, elapsedSec: 5 }).exceeded, false);
});

test("unit: lib/models.mjs parses tab-delimited JSONOutput, detects Orchestrator, and resolves models", (t) => {
  const catalog = parseModelsJsonOutput(
    `\r⠋ Spinner...\r\n${JSON.stringify({ status: "SUCCESS", response: DEFAULT_MOCK_MODELS })}\n`
  );
  assert.equal(catalog.length, 5);
  assert.deepEqual(catalog[4], {
    slug: "gemini-pro-orchestrator-neon",
    displayName: "Orchestrator (Neon)",
  });

  assert.equal(isOrchestratorModel("Orchestrator (Neon)"), true);
  assert.equal(isOrchestratorModel("gemini-pro-orchestrator-neon"), true);
  assert.equal(isOrchestratorModel("gemini-4-hydrogen-xhigh"), false);

  const bySlug = resolveModelSlug("gemini-4-hydrogen-xhigh", catalog);
  assert.equal(bySlug.ok, true);
  assert.equal(bySlug.isOrchestrator, false);

  const byLabel = resolveModelSlug("orchestrator (neon)", catalog);
  assert.equal(byLabel.ok, true);
  assert.equal(byLabel.slug, "gemini-pro-orchestrator-neon");
  assert.equal(byLabel.isOrchestrator, true);

  const unknown = resolveModelSlug("gemini-4-hydrogn", catalog);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.suggestions.includes("gemini-4-hydrogen-xhigh"));
  assert.match(unknown.error, /Did you mean/);

  const passthrough = resolveModelSlug("custom-model", []);
  assert.equal(passthrough.ok, true);
  assert.equal(passthrough.slug, "custom-model");

  const sb = makeHeadlessSandbox(t);
  sb.setScenario({ modelsSpinnerPrefix: true });
  const fetched = fetchModelCatalog({ agyBin: sb.mockAgyPath, env: sb.baseEnv });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.models.length, 5);
});

test("unit: lib/state-store.mjs & lib/runner.mjs retry backoff with fast sleepFn", async (t) => {
  const sb = makeHeadlessSandbox(t);
  assert.equal(validateLoopId("../bad"), false);
  assert.equal(validateLoopId("lp_20261121T000000Z_ab12"), true);

  // UTF-8 safe 25k truncation in resolveLoopMdTask
  const agentsLoopMd = path.join(sb.workspace, ".agents", "loop.md");
  fs.mkdirSync(path.dirname(agentsLoopMd), { recursive: true });
  fs.writeFileSync(agentsLoopMd, "中".repeat(9000), "utf8"); // 27,000 bytes
  const resolvedMd = resolveLoopMdTask(sb.workspace, sb.home);
  assert.equal(resolvedMd.truncated, true);
  assert.ok(Buffer.byteLength(resolvedMd.prompt, "utf8") <= 25000);
  assert.equal(resolvedMd.prompt.includes("\uFFFD"), false);
  fs.rmSync(agentsLoopMd, { force: true });

  // Verify retryable timeout backoff via fast sleepFn
  const sleeps = [];
  sb.setScenario({
    jsonTurns: [
      {
        exitCode: 3,
        envelope: { status: "ERROR", finished_reason: "print_timeout" },
      },
      {
        exitCode: 0,
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 55 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Recovered after retry",
            next_hint: "None",
          },
        },
      },
    ],
  });

  const cfg = parseRunArgs(["--once", "--max-retries", "2", "--quiet", "retry test"]);
  cfg.cwd = sb.workspace;
  const outBuf = { write: () => {} };
  const errBuf = { write: () => {} };
  const res = await runHeadlessLoop(cfg, {
    agyBin: sb.mockAgyPath,
    env: sb.baseEnv,
    stdout: outBuf,
    stderr: errBuf,
    rng: () => 0.5,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    registerSignals: false,
  });
  assert.equal(res.exitCode, EXIT_CODES.DONE);
  assert.equal(
    sleeps.reduce((sum, ms) => sum + ms, 0),
    30000,
    "Expected total retry backoff sleep of 30,000ms"
  );
  const retryEvents = readEvents(sb.stateDir, res.state.loop_id).filter(
    (ev) => ev.event === "retry"
  );
  assert.equal(retryEvents.length, 1);
  assert.equal(retryEvents[0].delay_sec, 30);
});

// ============================================================================
// 2. HEADLESS FRESH JSON TRANSPORT E2E
// ============================================================================

test("fresh e2e: flags strictly precede -p, schema root is object, and Orchestrator omits --effort", async (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 120 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Orchestrator done",
            next_hint: "None",
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 140 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Hydrogen done",
            next_hint: "None",
          },
        },
      },
    ],
  });

  // 1. Orchestrator (Neon) omits --effort even when --effort high is passed
  const orchRes = sb.runCli([
    "run",
    "--once",
    "--model",
    "Orchestrator (Neon)",
    "--effort",
    "high",
    "--mode",
    "auto",
    "--sandbox",
    "--dangerously-skip-permissions",
    "--allow-slash-commands",
    "--settings",
    '{"theme":"dark"}',
    "--add-dir",
    "/tmp/extra-a",
    "--add-dir",
    "/tmp/extra-b",
    "--turn-timeout",
    "90s",
    "--json",
    "check flags",
  ]);
  assert.equal(orchRes.status, 0, orchRes.stderr);

  // 2. Hydrogen includes --effort high and --disable-slash-commands
  const hydroRes = sb.runCli([
    "run",
    "--once",
    "--model",
    "gemini-4-hydrogen-xhigh",
    "--effort",
    "high",
    "--json",
    "check effort",
  ]);
  assert.equal(hydroRes.status, 0, hydroRes.stderr);

  const jsonCalls = sb.readCalls().filter((c) => c.mode === "json");
  assert.equal(jsonCalls.length, 2);

  const c1 = jsonCalls[0];
  const pIdx1 = c1.args.indexOf("-p");
  assert.ok(pIdx1 > 0, "Expected -p flag");
  assert.equal(pIdx1, c1.args.length - 2, "All flags must strictly precede -p <prompt>");
  assert.equal(c1.args.includes("--effort"), false, "Orchestrator must omit --effort");
  assert.equal(c1.args.includes("--disable-slash-commands"), false);
  assert.equal(c1.args[c1.args.indexOf("--model") + 1], "gemini-pro-orchestrator-neon");
  assert.equal(c1.args[c1.args.indexOf("--print-timeout") + 1], "90s");
  assert.equal(c1.args.filter((a) => a === "--add-dir").length, 2);
  assert.equal(c1.schema?.type, "object");

  const c2 = jsonCalls[1];
  const pIdx2 = c2.args.indexOf("-p");
  assert.equal(pIdx2, c2.args.length - 2);
  assert.equal(c2.args[c2.args.indexOf("--effort") + 1], "high");
  assert.equal(c2.args.includes("--disable-slash-commands"), true);

  // Also verify runJsonTurn isolateSessionEnv strips ANTIGRAVITY_* without mutating caller env
  const callerEnv = {
    ...sb.baseEnv,
    ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:9999",
    ANTIGRAVITY_CSRF_TOKEN: "secret-csrf",
  };
  const turnRes = await runJsonTurn({
    prompt: "env check",
    cwd: sb.workspace,
    agyBin: sb.mockAgyPath,
    env: callerEnv,
    isolateSessionEnv: true,
  });
  assert.equal(turnRes.exitCode, 0);
  const envCall = sb.readCalls().filter((c) => c.mode === "json")[2];
  assert.equal(envCall.envLs, null);
  assert.equal(envCall.envCsrf, null);
  assert.equal(callerEnv.ANTIGRAVITY_LS_ADDRESS, "127.0.0.1:9999");

  // Pure buildJsonTurnArgs & parseJsonEnvelope checks
  const built = buildJsonTurnArgs({
    prompt: "p",
    model: "gemini-pro-orchestrator-neon",
    effort: "xhigh",
  });
  assert.equal(built.includes("--effort"), false);
  assert.equal(parseJsonEnvelope('noise\n{"a":1}\n{"status":"SUCCESS","b":2}\ntrailer').b, 2);
});

test("fresh e2e: 2-pass CONTINUE -> DONE hot-reloads loop.md, sums tokens, keeps git clean", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.initGitRepo();

  const loopMdPath = path.join(sb.workspace, ".agents", "loop.md");
  fs.mkdirSync(path.dirname(loopMdPath), { recursive: true });
  fs.writeFileSync(loopMdPath, "First pass objective v1\n", "utf8");
  assert.equal(sb.runGit(["add", ".agents/loop.md"]).status, 0);
  assert.equal(sb.runGit(["commit", "-m", "add loop.md"]).status, 0);

  // Use workspace .agents/.agy-loop/ (without AGY_LOOP_STATE_DIR) and isolated AGY_LOOP_INDEX_PATH
  const cleanRepoEnv = {
    ...sb.baseEnv,
    AGY_LOOP_INDEX_PATH: sb.indexPath,
  };
  delete cleanRepoEnv.AGY_LOOP_STATE_DIR;

  sb.setScenario({
    jsonTurns: [
      {
        mutateFile: { path: ".agents/loop.md", content: "Reloaded pass objective v2\n" },
        envelope: {
          status: "SUCCESS",
          conversation_id: "conv-fresh-1",
          usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
          duration_seconds: 1.2,
          num_turns: 1,
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Pass 1 complete",
            next_hint: "Re-check with updated loop.md",
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          conversation_id: "conv-fresh-2",
          usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200 },
          duration_seconds: 0.8,
          num_turns: 1,
          structured_output: {
            iteration: 2,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Pass 2 complete",
            next_hint: "None",
          },
        },
      },
    ],
  });

  const res = sb.runCli(["run", "1s", "--max", "5", "--json"], { env: cleanRepoEnv });
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "done");
  assert.equal(payload.iterations, 2);
  assert.equal(payload.usage_totals.total_tokens, 500);

  const workerCalls = sb.readCalls().filter((c) => c.mode === "json");
  assert.equal(workerCalls.length, 2);
  assert.match(workerCalls[0].args[workerCalls[0].args.length - 1], /First pass objective v1/);
  assert.match(workerCalls[1].args[workerCalls[1].args.length - 1], /Reloaded pass objective v2/);

  // Restore tracked loop.md to verify .agents/.agy-loop/.gitignore kept git status empty
  fs.writeFileSync(loopMdPath, "First pass objective v1\n", "utf8");
  const gitignorePath = path.join(sb.workspace, ".agents", ".agy-loop", ".gitignore");
  assert.equal(fs.readFileSync(gitignorePath, "utf8"), "*\n");
  const gitStatus = sb.runGit(["status", "--porcelain"]);
  assert.equal(gitStatus.stdout, "", `Expected clean git status, got: ${gitStatus.stdout}`);
});

test("fresh e2e: Option A exit codes (--once CONTINUE -> 0, max_reached -> 4, BLOCKED -> 3, CLI error -> 2)", (t) => {
  const sb = makeHeadlessSandbox(t);

  // 1. --once returning CONTINUE -> exit 0
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 40 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 30,
            summary: "Single check reported continue",
            next_hint: "Check again later",
          },
        },
      },
    ],
  });
  const onceContinue = sb.runCli(["run", "--once", "--json", "single check"]);
  assert.equal(onceContinue.status, 0, onceContinue.stderr);
  assert.equal(JSON.parse(onceContinue.stdout).status, "max_reached");

  // 2. Multi-iteration hitting --max 2 while CONTINUE -> exit 4
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 40 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Still pending 1",
            next_hint: "Wait",
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 40 },
          structured_output: {
            iteration: 2,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Still pending 2",
            next_hint: "Wait",
          },
        },
      },
    ],
  });
  const maxRes = sb.runCli(["run", "1s", "--max", "2", "--json", "multi check"]);
  assert.equal(maxRes.status, 4, maxRes.stderr);
  const maxPayload = JSON.parse(maxRes.stdout);
  assert.equal(maxPayload.status, "max_reached");
  assert.equal(maxPayload.exit_reason, "max_iterations");

  // 3. BLOCKED -> exit 3
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 20 },
          structured_output: {
            iteration: 1,
            loop_status: "BLOCKED",
            next_delay_sec: 0,
            summary: "Missing API token",
            next_hint: "Provide token",
          },
        },
      },
    ],
  });
  const blockedRes = sb.runCli(["run", "--once", "--json", "blocked check"]);
  assert.equal(blockedRes.status, 3, blockedRes.stderr);
  assert.equal(JSON.parse(blockedRes.stdout).status, "blocked");

  // 4. CLI usage error -> exit 2
  const usageRes = sb.runCli(["run", "--stateful", "--fresh", "bad flags"]);
  assert.equal(usageRes.status, 2);
});

// ============================================================================
// 3. HEADLESS --STATEFUL PERSISTENT STREAM-JSON TRANSPORT E2E
// ============================================================================

test("stateful e2e: no -p flag, multi-turn delta usage, UTF-8 chunking, and --reset-every 2", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-sess-1",
        turns: [
          {
            splitUtf8Chunk: true,
            result: {
              usage: { input_tokens: 60, output_tokens: 40, total_tokens: 100 },
              duration_seconds: 1.0,
              num_turns: 1,
              structured_output: {
                iteration: 1,
                loop_status: "CONTINUE",
                next_delay_sec: 1,
                summary: "Turn 1 中文 ok",
                next_hint: "Continue to 2",
              },
            },
          },
          {
            result: {
              usage: { input_tokens: 160, output_tokens: 100, total_tokens: 260 },
              duration_seconds: 2.5,
              num_turns: 2,
              structured_output: {
                iteration: 2,
                loop_status: "CONTINUE",
                next_delay_sec: 1,
                summary: "Turn 2 ok",
                next_hint: "Rotate next",
              },
            },
          },
        ],
      },
      {
        conversationId: "conv-sess-2",
        turns: [
          {
            result: {
              usage: { input_tokens: 60, output_tokens: 30, total_tokens: 90 },
              duration_seconds: 0.7,
              num_turns: 1,
              structured_output: {
                iteration: 3,
                loop_status: "DONE",
                next_delay_sec: 0,
                summary: "Turn 3 after reset",
                next_hint: "None",
              },
            },
          },
        ],
      },
    ],
  });

  const res = sb.runCli([
    "run",
    "1s",
    "--stateful",
    "--reset-every",
    "2",
    "--max",
    "4",
    "--json",
    "stateful flow",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.iterations, 3);
  assert.equal(payload.usage_totals.total_tokens, 350);

  const calls = sb.readCalls();
  const streamStarts = calls.filter((c) => c.mode === "stream-start");
  assert.equal(streamStarts.length, 2, "Expected 2 stream sessions due to --reset-every 2");
  for (const startCall of streamStarts) {
    assert.equal(startCall.args.includes("-p"), false, "stream-json must NEVER pass -p");
    assert.equal(startCall.args.includes("--print"), false, "stream-json must NEVER pass --print");
    assert.equal(startCall.args[startCall.args.indexOf("--input-format") + 1], "stream-json");
    assert.equal(startCall.args[startCall.args.indexOf("--output-format") + 1], "stream-json");
  }
  assert.equal(streamStarts[1].conversationArg, null, "--reset-every starts a fresh conversation");

  const streamTurns = calls.filter((c) => c.mode === "stream-turn");
  assert.equal(streamTurns.length, 3);
  assert.equal(streamTurns[0].sessionIdx, 0);
  assert.equal(streamTurns[1].sessionIdx, 0);
  assert.equal(streamTurns[2].sessionIdx, 1);

  const events = readEvents(sb.stateDir, payload.loop_id);
  const iterEvents = events.filter((ev) => ev.event === "iteration");
  assert.deepEqual(
    iterEvents.map((ev) => ev.usage_delta.total_tokens),
    [100, 160, 90]
  );
  assert.equal(
    iterEvents.reduce((acc, ev) => acc + ev.usage_delta.total_tokens, 0),
    readLoopState(sb.stateDir, payload.loop_id).usage_totals.total_tokens
  );
  assert.ok(events.some((ev) => ev.event === "session_reset" && ev.iteration === 3));
});

test("stateful e2e: stale structured_output without finish step triggers circuit_broken (exit 1)", (t) => {
  const sb = makeHeadlessSandbox(t);
  const staleTurn1Payload = {
    iteration: 1,
    loop_status: "CONTINUE",
    next_delay_sec: 1,
    summary: "Turn 1 good",
    next_hint: "Do turn 2",
  };
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-stale-1",
        turns: [
          {
            emitFinish: true,
            result: {
              usage: { total_tokens: 100 },
              structured_output: staleTurn1Payload,
            },
          },
          {
            emitFinish: false,
            result: {
              usage: { total_tokens: 150 },
              // Echoes turn 1's stale structured_output!
              structured_output: { ...staleTurn1Payload, loop_status: "DONE" },
              response: "Partial response without valid footer",
            },
          },
          {
            emitFinish: false,
            result: {
              usage: { total_tokens: 200 },
              structured_output: { ...staleTurn1Payload, loop_status: "DONE" },
              response: "Still no footer",
            },
          },
        ],
      },
    ],
  });

  const res = sb.runCli([
    "run",
    "1s",
    "--stateful",
    "--max",
    "5",
    "--max-errors",
    "2",
    "--json",
    "stale trap",
  ]);
  assert.equal(res.status, 1, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.status, "circuit_broken");
  assert.equal(payload.exit_reason, "consecutive_errors");

  const events = readEvents(sb.stateDir, payload.loop_id);
  const errEvents = events.filter((ev) => ev.event === "error");
  assert.equal(errEvents.length, 2);
  assert.equal(errEvents[0].stale, true);
  assert.equal(errEvents[1].stale, true);
});

test("stateful e2e: Exit 3 AGY_ERROR quota crash respawns with --conversation and --fallback-model", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-keep-42",
        turns: [
          {
            result: {
              usage: { total_tokens: 110 },
              structured_output: {
                iteration: 1,
                loop_status: "CONTINUE",
                next_delay_sec: 1,
                summary: "Turn 1 on primary",
                next_hint: "Proceed",
              },
            },
          },
          {
            stderr:
              'AGY_ERROR: {"status":429,"error_code":"RESOURCE_EXHAUSTED","retryable":true,"short_error":"Quota exhausted"}\n',
            exitCode: 3,
          },
        ],
      },
      {
        turns: [
          {
            result: {
              usage: { total_tokens: 75 },
              structured_output: {
                iteration: 2,
                loop_status: "DONE",
                next_delay_sec: 0,
                summary: "Turn 2 recovered on fallback",
                next_hint: "None",
              },
            },
          },
        ],
      },
    ],
  });

  const res = sb.runCli([
    "run",
    "1s",
    "--stateful",
    "--max",
    "4",
    "--model",
    "gemini-4-hydrogen-xhigh",
    "--fallback-model",
    "gemini-4-carbon-high",
    "--json",
    "fallback respawn test",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.active_model, "gemini-4-carbon-high");
  assert.equal(payload.conversation_id, "conv-keep-42");

  const starts = sb.readCalls().filter((c) => c.mode === "stream-start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].conversationArg, "conv-keep-42");
  assert.equal(starts[1].args[starts[1].args.indexOf("--model") + 1], "gemini-4-carbon-high");

  const events = readEvents(sb.stateDir, payload.loop_id);
  assert.ok(
    events.some(
      (ev) =>
        ev.event === "fallback" &&
        ev.from_model === "gemini-4-hydrogen-xhigh" &&
        ev.to_model === "gemini-4-carbon-high"
    )
  );
});

test("e2e: fatal Exit 1/2 fails fast with zero retries; denied_actions[] warns or blocks under --fail-on-denied", (t) => {
  const sb = makeHeadlessSandbox(t);

  // 1. Fatal exit 2 -> zero retries
  sb.setScenario({
    jsonTurns: [
      {
        exitCode: 2,
        stderr: "Invalid CLI configuration\n",
        envelope: null,
      },
    ],
  });
  const fatalRes = sb.runCli(["run", "--max-retries", "3", "--once", "--json", "fatal check"]);
  assert.equal(fatalRes.status, 2);
  const workerCalls = sb.readCalls().filter((c) => c.mode === "json");
  assert.equal(workerCalls.length, 1, "Fatal exit 2 must not retry");
  const fatalPayload = JSON.parse(fatalRes.stdout);
  assert.equal(fatalPayload.status, "blocked");
  assert.equal(fatalPayload.exit_reason, "fatal_config");

  // 2. Soft-denial default -> warns and counts, exits 0
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          denied_actions: [{ tool_name: "run_command" }],
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Completed with soft denial warning",
            next_hint: "None",
          },
        },
      },
    ],
  });
  const warnRes = sb.runCli(["run", "--once", "--json", "soft deny warn"]);
  assert.equal(warnRes.status, 0, warnRes.stderr);
  assert.match(warnRes.stderr, /Warning: 1 action\(s\) soft-denied.*run_command/);
  const warnPayload = JSON.parse(warnRes.stdout);
  assert.equal(warnPayload.denied_actions_count, 1);

  // 3. Soft-denial with --fail-on-denied -> exits 3
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          denied_actions: ["write_to_file"],
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Should be blocked",
            next_hint: "None",
          },
        },
      },
    ],
  });
  const failDeniedRes = sb.runCli([
    "run",
    "--once",
    "--fail-on-denied",
    "--json",
    "soft deny block",
  ]);
  assert.equal(failDeniedRes.status, 3);
  const failDeniedPayload = JSON.parse(failDeniedRes.stdout);
  assert.equal(failDeniedPayload.status, "blocked");
  assert.equal(failDeniedPayload.exit_reason, "denied_actions");
  assert.equal(failDeniedPayload.denied_actions_count, 1);
});

// ============================================================================
// 4. ADVANCED FEATURES E2E
// ============================================================================

test("e2e: --verifier-model overrides DONE -> CONTINUE with issues, then accepts on pass 2", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 100 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Implemented feature",
            next_hint: "None",
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 120 },
          structured_output: {
            iteration: 2,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Added missing edge test",
            next_hint: "None",
          },
        },
      },
    ],
    verifierTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 40 },
          structured_output: {
            passed: false,
            summary: "Verification rejected",
            issues: ["Missing regression test for null input"],
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 35 },
          structured_output: {
            passed: true,
            summary: "All checks verified",
            issues: [],
          },
        },
      },
    ],
  });

  const res = sb.runCli([
    "run",
    "1s",
    "--max",
    "4",
    "--model",
    "gemini-4-hydrogen-xhigh",
    "--verifier-model",
    "gemini-4-neon-xhigh",
    "--json",
    "Build and verify",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.iterations, 2);
  assert.equal(payload.usage_totals.total_tokens, 295);

  const calls = sb.readCalls();
  const workerCalls = calls.filter((c) => c.mode === "json" && c.turnKind === "worker");
  const verifierCalls = calls.filter((c) => c.mode === "json" && c.turnKind === "verifier");
  assert.equal(workerCalls.length, 2);
  assert.equal(verifierCalls.length, 2);
  assert.equal(verifierCalls[0].args.includes("--sandbox"), true);
  assert.equal(verifierCalls[0].args[verifierCalls[0].args.indexOf("--model") + 1], "gemini-4-neon-xhigh");
  assert.match(
    workerCalls[1].args[workerCalls[1].args.length - 1],
    /Missing regression test for null input/
  );

  const events = readEvents(sb.stateDir, payload.loop_id);
  const verEvents = events.filter((ev) => ev.event === "verifier");
  assert.equal(verEvents.length, 2);
  assert.equal(verEvents[0].passed, false);
  assert.equal(verEvents[1].passed, true);
});

test("e2e: --probe + --probe-until-pass finishes DONE with 0 LLM calls and 0 tokens; --max-tokens exits 4", (t) => {
  const sb = makeHeadlessSandbox(t);

  // 1. Immediate probe pass -> 0 LLM calls, 0 tokens
  sb.setScenario({});
  const probeRes = sb.runCli([
    "run",
    "--max",
    "3",
    "--probe",
    "echo probe-ok && exit 0",
    "--probe-until-pass",
    "--json",
    "Wait for build green",
  ]);
  assert.equal(probeRes.status, 0, probeRes.stderr);
  const probePayload = JSON.parse(probeRes.stdout);
  assert.equal(probePayload.status, "done");
  assert.equal(probePayload.exit_reason, "probe_passed");
  assert.equal(probePayload.usage_totals.total_tokens, 0);

  const llmCalls = sb
    .readCalls()
    .filter((c) => c.mode === "json" || c.mode === "stream-turn");
  assert.equal(llmCalls.length, 0, "Expected zero LLM turns when --probe-until-pass exits 0");

  const events = readEvents(sb.stateDir, probePayload.loop_id);
  assert.ok(events.some((ev) => ev.event === "probe_skip" && ev.probe_exit_code === 0));

  // 2. Failing --probe injects output into worker prompt, then pass 2 probe succeeds (0 LLM tokens on pass 2)
  const probeFlagFile = path.join(sb.root, "probe-pass.flag");
  sb.setScenario({
    jsonTurns: [
      {
        mutateFile: { path: probeFlagFile, content: "ok\n" },
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 65 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Fixed probe failure",
            next_hint: "Re-check probe",
          },
        },
      },
    ],
  });
  const probeCmdTwoPass = `test -f ${JSON.stringify(probeFlagFile)} || { echo 'LINT_ERR_XYZ'; exit 1; }`;
  const probeTwoRes = sb.runCli([
    "run",
    "1s",
    "--max",
    "4",
    "--probe",
    probeCmdTwoPass,
    "--probe-until-pass",
    "--json",
    "Fix lint probe",
  ]);
  assert.equal(probeTwoRes.status, 0, probeTwoRes.stderr);
  const probeTwoPayload = JSON.parse(probeTwoRes.stdout);
  assert.equal(probeTwoPayload.status, "done");
  assert.equal(probeTwoPayload.exit_reason, "probe_passed");
  assert.equal(probeTwoPayload.iterations, 2);
  assert.equal(probeTwoPayload.usage_totals.total_tokens, 65);
  const probeWorkerCalls = sb.readCalls().filter((c) => c.mode === "json");
  assert.equal(probeWorkerCalls.length, 1);
  assert.match(probeWorkerCalls[0].args[probeWorkerCalls[0].args.length - 1], /LINT_ERR_XYZ/);

  // 3. --max-tokens budget exceeded -> status max_reached, exit_reason max_tokens, exit 4
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 450 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Expensive turn",
            next_hint: "Next",
          },
        },
      },
    ],
  });
  const tokRes = sb.runCli([
    "run",
    "1s",
    "--max",
    "5",
    "--max-tokens",
    "400",
    "--json",
    "Token budget test",
  ]);
  assert.equal(tokRes.status, 4, tokRes.stderr);
  const tokPayload = JSON.parse(tokRes.stdout);
  assert.equal(tokPayload.status, "max_reached");
  assert.equal(tokPayload.exit_reason, "max_tokens");

  // 4. --max-duration budget exceeded -> status max_reached, exit_reason max_duration, exit 4
  sb.setScenario({
    jsonTurns: [
      {
        sleepMs: 1100,
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 30 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Slow turn 1",
            next_hint: "Next",
          },
        },
      },
    ],
  });
  const durRes = sb.runCli([
    "run",
    "1s",
    "--max",
    "5",
    "--max-duration",
    "1s",
    "--json",
    "Duration budget test",
  ]);
  assert.equal(durRes.status, 4, durRes.stderr);
  const durPayload = JSON.parse(durRes.stdout);
  assert.equal(durPayload.status, "max_reached");
  assert.equal(durPayload.exit_reason, "max_duration");
});

test("e2e: --worktree auto-cleans 0-commit run and preserves committed worktree with merge/cleanup hints", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.initGitRepo();

  // (a) Clean 0-commit run auto-removes worktree & branch
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 80 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Clean inspection only",
            next_hint: "None",
          },
        },
      },
    ],
  });
  const cleanWtRes = sb.runCli(["run", "--once", "--worktree", "--json", "Inspect only"]);
  assert.equal(cleanWtRes.status, 0, cleanWtRes.stderr);
  const cleanWtPayload = JSON.parse(cleanWtRes.stdout);
  assert.equal(cleanWtPayload.worktree.removed, true);
  assert.equal(cleanWtPayload.worktree.preserved, false);
  assert.equal(fs.existsSync(cleanWtPayload.worktree.path), false);
  assert.equal(
    sb.runGit(["branch", "--list", cleanWtPayload.worktree.branch]).stdout.trim(),
    ""
  );

  // (b) Run where mock worker makes a commit preserves worktree & branch with hints
  sb.setScenario({
    jsonTurns: [
      {
        gitCommit: {
          file: "feature.txt",
          content: "new worktree work\n",
          message: "feat: add worktree file",
        },
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 90 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Committed feature.txt",
            next_hint: "None",
            changed_files: ["feature.txt"],
          },
        },
      },
    ],
  });
  const committedWtRes = sb.runCli(["run", "--once", "--worktree", "--json", "Make commit"]);
  assert.equal(committedWtRes.status, 0, committedWtRes.stderr);
  const committedPayload = JSON.parse(committedWtRes.stdout);
  assert.equal(committedPayload.worktree.preserved, true);
  assert.equal(committedPayload.worktree.removed, false);
  assert.equal(committedPayload.worktree.ahead_count, 1);
  assert.equal(fs.existsSync(committedPayload.worktree.path), true);
  assert.match(committedPayload.worktree.merge_hint, /git merge agy-loop\//);
  assert.match(committedPayload.worktree.cleanup_hint, /git worktree remove/);

  // Clean up preserved worktree explicitly before next check
  assert.equal(
    sb.runGit(["worktree", "remove", "--force", committedPayload.worktree.path]).status,
    0
  );
  assert.equal(sb.runGit(["branch", "-D", committedPayload.worktree.branch]).status, 0);
});

// ============================================================================
// 5. OBSERVABILITY & LIFECYCLE CLI COMMANDS (ps, logs, stop, statusline)
// ============================================================================

test("cli observability: ps (--json, --all, --global, stale PID), logs (latest, suffix, --tail, -f), stop (--after-current, SIGTERM, stale), statusline", async (t) => {
  const sb = makeHeadlessSandbox(t);
  const globalEnv = {
    ...sb.baseEnv,
    AGY_LOOP_INDEX_PATH: sb.indexPath,
  };

  // Seed interactive loop via loop-helper.sh state-init
  const parsedInteractive = spawnSync("sh", [HELPER_SH_PATH, "parse", "/loop 1m check interactive"], {
    cwd: sb.workspace,
    env: globalEnv,
    encoding: "utf8",
  });
  assert.equal(parsedInteractive.status, 0, parsedInteractive.stderr);
  const initInteractive = spawnSync(
    "sh",
    [HELPER_SH_PATH, "state-init", sb.workspace, "--stdin"],
    {
      cwd: sb.workspace,
      env: globalEnv,
      input: parsedInteractive.stdout,
      encoding: "utf8",
    }
  );
  assert.equal(initInteractive.status, 0, initInteractive.stderr);
  const interactiveState = JSON.parse(initInteractive.stdout);
  upsertGlobalIndex(interactiveState, sb.stateDir, { homeDir: sb.home, env: globalEnv });

  // Seed running headless loop (live PID = process.pid) + stale dead-PID loop (99999999) + finished loop
  const runningHeadless = createLoopState(sb.stateDir, {
    loop_id: "lp_20261121T100001Z_aa11",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: process.pid,
    iteration: 3,
    max_iterations: 10,
    model: "gemini-4-hydrogen-xhigh",
    usage_totals: { total_tokens: 12400 },
    last_summary: "Active headless",
  });
  upsertGlobalIndex(runningHeadless, sb.stateDir, { homeDir: sb.home, env: globalEnv });

  const staleHeadless = createLoopState(sb.stateDir, {
    loop_id: "lp_20261121T100002Z_bb22",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: 99999999,
    iteration: 2,
    max_iterations: 10,
    model: "gemini-4-carbon-low",
    last_summary: "Dead process",
  });
  upsertGlobalIndex(staleHeadless, sb.stateDir, { homeDir: sb.home, env: globalEnv });

  const doneHeadless = createLoopState(sb.stateDir, {
    loop_id: "lp_20261121T100003Z_cc33",
    status: "done",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: 99999998,
    iteration: 1,
    max_iterations: 1,
    last_summary: "Finished loop",
  });
  updateLoopState(sb.stateDir, doneHeadless.loop_id, { status: "done" }, { event: "finish", status: "done" });
  upsertGlobalIndex(readLoopState(sb.stateDir, doneHeadless.loop_id), sb.stateDir, {
    homeDir: sb.home,
    env: globalEnv,
  });

  // Seed another workspace into global index
  const otherWs = path.join(sb.root, "other-ws");
  const otherStateDir = path.join(sb.root, "other-state");
  fs.mkdirSync(otherWs, { recursive: true });
  const otherLoop = createLoopState(otherStateDir, {
    loop_id: "lp_20261121T100004Z_dd44",
    status: "done",
    workspace_dir: otherWs,
    engine: "headless",
    last_summary: "Other workspace loop",
  });
  upsertGlobalIndex(otherLoop, otherStateDir, { homeDir: sb.home, env: globalEnv });

  // 1. ps --json, ps table, ps --all --json, ps --global --json
  const psActiveJson = JSON.parse(sb.runCli(["ps", "--json"], { env: globalEnv }).stdout);
  assert.equal(psActiveJson.loops.length, 3);
  const staleEntry = psActiveJson.loops.find((l) => l.loop_id === staleHeadless.loop_id);
  const liveEntry = psActiveJson.loops.find((l) => l.loop_id === runningHeadless.loop_id);
  const interEntry = psActiveJson.loops.find((l) => l.loop_id === interactiveState.loop_id);
  assert.equal(staleEntry.stale, true);
  assert.equal(liveEntry.stale, false);
  assert.equal(interEntry.stale, false);

  const psTable = sb.runCli(["ps"], { env: globalEnv });
  assert.equal(psTable.status, 0);
  assert.match(psTable.stdout, /running \[stale\]/);

  const psAllJson = JSON.parse(sb.runCli(["ps", "--all", "--json"], { env: globalEnv }).stdout);
  assert.equal(psAllJson.loops.length, 4);

  const psGlobalJson = JSON.parse(
    sb.runCli(["ps", "--all", "--global", "--json"], { env: globalEnv }).stdout
  );
  assert.ok(psGlobalJson.loops.some((l) => l.loop_id === otherLoop.loop_id));
  assert.ok(psGlobalJson.loops.some((l) => l.loop_id === runningHeadless.loop_id));

  // 2. statusline (2 active, ignoring stale) + in-process (<50ms) and subprocess (<1500ms) timing
  const prevStateEnv = process.env.AGY_LOOP_STATE_DIR;
  const prevIndexEnv = process.env.AGY_LOOP_INDEX_PATH;
  const prevHomeEnv = process.env.HOME;
  const origWrite = process.stdout.write.bind(process.stdout);
  let inProcOut = "";
  let inProcMs = 0;
  try {
    process.env.AGY_LOOP_STATE_DIR = sb.stateDir;
    process.env.AGY_LOOP_INDEX_PATH = sb.indexPath;
    process.env.HOME = sb.home;
    process.stdout.write = (chunk) => {
      inProcOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    const tIn0 = performance.now();
    await handleStatusline(["--cwd", sb.workspace, "--no-color"]);
    inProcMs = performance.now() - tIn0;
  } finally {
    process.stdout.write = origWrite;
    if (prevStateEnv === undefined) delete process.env.AGY_LOOP_STATE_DIR;
    else process.env.AGY_LOOP_STATE_DIR = prevStateEnv;
    if (prevIndexEnv === undefined) delete process.env.AGY_LOOP_INDEX_PATH;
    else process.env.AGY_LOOP_INDEX_PATH = prevIndexEnv;
    if (prevHomeEnv === undefined) delete process.env.HOME;
    else process.env.HOME = prevHomeEnv;
  }
  assert.match(inProcOut, /^↻ 2 loops \(#\d+\/\d+, #\d+\/\d+\)\n$/);
  assert.ok(inProcMs < 50, `Expected in-process statusline < 50ms, took ${inProcMs.toFixed(1)}ms`);

  const t0 = performance.now();
  const slTwoRes = sb.runCli(["statusline"], { env: globalEnv });
  const slDurationMs = performance.now() - t0;
  assert.equal(slTwoRes.status, 0);
  assert.match(slTwoRes.stdout, /^↻ 2 loops \(#\d+\/\d+, #\d+\/\d+\)\n$/);
  assert.ok(
    slDurationMs < 1500,
    `Expected statusline subprocess < 1500ms, took ${slDurationMs.toFixed(1)}ms`
  );

  const slJson = JSON.parse(sb.runCli(["statusline", "--json"], { env: globalEnv }).stdout);
  assert.equal(slJson.count, 2);
  assert.equal(slJson.staleCount, 1);

  // Stop interactive loop so only 1 active remains (runningHeadless with 12.4k tokens)
  const stopInterRes = sb.runCli(["stop", interactiveState.loop_id, "--json"], { env: globalEnv });
  assert.equal(stopInterRes.status, 0);
  const slOneRes = sb.runCli(["statusline"], { env: globalEnv });
  assert.equal(slOneRes.stdout, "↻ agy-loop #3/10 (12.4k tok)\n");

  // 3. stop --after-current + stale PID reconciliation
  const stopAfterRes = sb.runCli(
    ["stop", runningHeadless.loop_id, "--after-current", "--json"],
    { env: globalEnv }
  );
  assert.equal(stopAfterRes.status, 0);
  const afterState = readLoopState(sb.stateDir, runningHeadless.loop_id);
  assert.equal(afterState.status, "running");
  assert.equal(afterState.stop_requested, true);
  assert.equal(afterState.stop_mode, "after_current");
  assert.equal(readControl(sb.stateDir, runningHeadless.loop_id).mode, "after_current");

  // Stale PID reconciles directly to stopped even with --after-current
  const stopStaleRes = JSON.parse(
    sb.runCli(["stop", staleHeadless.loop_id, "--after-current", "--json"], { env: globalEnv })
      .stdout
  );
  assert.equal(stopStaleRes.stopped[0].status, "stopped");
  assert.equal(stopStaleRes.stopped[0].reconciled_stale, true);

  // Clean remaining active loop so statusline outputs "" with stale loop ignored
  updateLoopState(sb.stateDir, runningHeadless.loop_id, { status: "done" });
  const staleOnly = createLoopState(sb.stateDir, {
    loop_id: "lp_20261121T100005Z_ee55",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: 99999997,
  });
  const slZeroRes = sb.runCli(["statusline"], { env: globalEnv });
  assert.equal(slZeroRes.status, 0);
  assert.equal(slZeroRes.stdout, "");
  sb.runCli(["stop", staleOnly.loop_id, "--json"], { env: globalEnv });

  // 4. logs latest & short suffix --tail 1 --json
  const logsLatest = sb.runCli(["logs", "latest"], { env: globalEnv });
  assert.equal(logsLatest.status, 0, logsLatest.stderr);
  assert.ok(logsLatest.stdout.trim().length > 0);

  const logsTail = sb.runCli(["logs", "cc33", "--tail", "1", "--json"], { env: globalEnv });
  assert.equal(logsTail.status, 0, logsTail.stderr);
  const tailLines = logsTail.stdout.trim().split("\n").filter(Boolean);
  assert.equal(tailLines.length, 1);
  assert.equal(JSON.parse(tailLines[0]).event, "finish");

  // 5. Concurrent logs -f following a running 2-turn loop until completion
  sb.setScenario({
    jsonTurns: [
      {
        sleepMs: 300,
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 30 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 1,
            summary: "Follow pass 1",
            next_hint: "Pass 2",
          },
        },
      },
      {
        sleepMs: 250,
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 40 },
          structured_output: {
            iteration: 2,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Follow pass 2",
            next_hint: "None",
          },
        },
      },
    ],
  });

  const knownIds = new Set(listLoops(sb.stateDir, { includeAll: true }).map((l) => l.loop_id));
  const followRun = sb.spawnCli(["run", "1s", "--max", "3", "--json", "follow test"], {
    env: globalEnv,
  });
  const followLoopId = await waitFor(() => {
    const found = listLoops(sb.stateDir, { includeAll: true }).find(
      (l) => !knownIds.has(l.loop_id)
    );
    return found?.loop_id || null;
  });
  const followLogs = sb.spawnCli(["logs", followLoopId, "-f", "--json"], { env: globalEnv });
  const [followRunExit, followLogsExit] = await Promise.all([followRun.done, followLogs.done]);
  assert.equal(followRunExit.status, 0, followRunExit.stderr);
  assert.equal(followLogsExit.status, 0, followLogsExit.stderr);
  const followedEvents = followLogsExit.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.ok(followedEvents.some((e) => e.event === "init"));
  assert.ok(followedEvents.some((e) => e.event === "iteration" && e.iteration === 2));

  // 6. Live SIGTERM via `agy-loop stop <id>` on an in-flight sleeping runner
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 25 },
          structured_output: {
            iteration: 1,
            loop_status: "CONTINUE",
            next_delay_sec: 30,
            summary: "Sleeping now",
            next_hint: "Sleep",
          },
        },
      },
    ],
  });
  const knownIds2 = new Set(listLoops(sb.stateDir, { includeAll: true }).map((l) => l.loop_id));
  const liveRun = sb.spawnCli(["run", "30s", "--max", "5", "--json", "live stop test"], {
    env: globalEnv,
  });
  const liveLoopId = await waitFor(() => {
    const found = listLoops(sb.stateDir, { includeAll: true }).find(
      (l) => !knownIds2.has(l.loop_id)
    );
    if (!found) return null;
    const evs = readEvents(sb.stateDir, found.loop_id);
    return evs.some((e) => e.event === "iteration") ? found.loop_id : null;
  });

  const stopStartMs = performance.now();
  const stopLiveRes = sb.runCli(["stop", liveLoopId, "--json"], { env: globalEnv });
  assert.equal(stopLiveRes.status, 0, stopLiveRes.stderr);
  const stopLiveJson = JSON.parse(stopLiveRes.stdout);
  assert.equal(stopLiveJson.stopped[0].signal_sent, "SIGTERM");

  const liveRunExit = await liveRun.done;
  const stopElapsedMs = performance.now() - stopStartMs;
  assert.equal(liveRunExit.status, 130, `Expected exit 130 on SIGTERM stop, got ${liveRunExit.status}`);
  assert.ok(stopElapsedMs < 2000, `Expected clean stop within 2s, took ${stopElapsedMs.toFixed(1)}ms`);
  assert.equal(readLoopState(sb.stateDir, liveLoopId).status, "stopped");
});

test("unit: sleepInterruptible exits early on AbortSignal and after_current stop requests", async (t) => {
  const sb = makeHeadlessSandbox(t);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const t0 = performance.now();
  const res = await sleepInterruptible(10, { signal: ac.signal, pollMs: 500 });
  const elapsed = performance.now() - t0;
  assert.equal(res.interrupted, true);
  assert.equal(res.reason, "signal");
  assert.ok(elapsed < 500);

  // #49 #5: after_current interrupts between-iteration/delayed-start sleeps promptly
  const loopAfter = createLoopState(sb.stateDir, {
    loop_id: "lp_20261121T120001Z_af01",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
  });
  setTimeout(() => {
    writeControlStop(sb.stateDir, loopAfter.loop_id, "after_current");
  }, 40);
  const t1 = performance.now();
  const afterRes = await sleepInterruptible(10, {
    stateRoot: sb.stateDir,
    loopId: loopAfter.loop_id,
    pollMs: 25,
  });
  const afterElapsed = performance.now() - t1;
  assert.equal(afterRes.interrupted, true);
  assert.equal(afterRes.reason, "stop_requested");
  assert.ok(afterElapsed < 500, `Expected early wake on after_current, took ${afterElapsed}ms`);

  // stopOnAfterCurrent: false lets active-turn retry/fallback sleep complete
  const noInterrupt = await sleepInterruptible(0.08, {
    stateRoot: sb.stateDir,
    loopId: loopAfter.loop_id,
    pollMs: 20,
    stopOnAfterCurrent: false,
  });
  assert.equal(noInterrupt.interrupted, false);
  assert.equal(noInterrupt.reason, null);
});

// ============================================================================
// 6. REGRESSION TESTS FOR #49 REVIEW FINDINGS (#1 - #7)
// ============================================================================

test("regression #49 #1: stream-json ERROR result + exit(1)/exit(3) and print_timeout route through classifyTurnFailure", async (t) => {
  const sb = makeHeadlessSandbox(t);

  // (a) result{status:"ERROR", finished_reason:"error"} + exit(1) -> fatal fast-fail with exit 1, 0 retries
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-err-fatal",
        turns: [
          {
            stderr: 'AGY_ERROR: {"short_error":"Invalid model config","retryable":false}\n',
            exitCode: 1,
            result: {
              status: "ERROR",
              finished_reason: "error",
              error: "Invalid model config",
              usage: { total_tokens: 0 },
            },
          },
        ],
      },
    ],
  });
  const fatalRes = sb.runCli([
    "run",
    "--stateful",
    "--once",
    "--max-retries",
    "3",
    "--json",
    "stream fatal",
  ]);
  assert.equal(fatalRes.status, 1, fatalRes.stderr);
  const fatalPayload = JSON.parse(fatalRes.stdout);
  assert.equal(fatalPayload.status, "blocked");
  assert.equal(fatalPayload.exit_reason, "fatal_config");
  assert.equal(
    sb.readCalls().filter((c) => c.mode === "stream-start").length,
    1,
    "Fatal exit 1 must not retry"
  );

  // (b) turn 2 emits result{status:"ERROR"} + AGY_ERROR(429) + exit(3) -> fallback respawn with --conversation
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-stream-fb",
        turns: [
          {
            result: {
              status: "SUCCESS",
              usage: { total_tokens: 80 },
              structured_output: {
                iteration: 1,
                loop_status: "CONTINUE",
                next_delay_sec: 1,
                summary: "Pass 1 ok",
                next_hint: "Continue",
              },
            },
          },
          {
            stderr:
              'AGY_ERROR: {"status":429,"error_code":"RESOURCE_EXHAUSTED","retryable":true,"short_error":"Quota exhausted"}\n',
            exitCode: 3,
            result: {
              status: "ERROR",
              finished_reason: "error",
              usage: { total_tokens: 85 },
            },
          },
        ],
      },
      {
        turns: [
          {
            result: {
              status: "SUCCESS",
              usage: { total_tokens: 60 },
              structured_output: {
                iteration: 2,
                loop_status: "DONE",
                next_delay_sec: 0,
                summary: "Recovered on fallback",
                next_hint: "None",
              },
            },
          },
        ],
      },
    ],
  });
  const fbRes = sb.runCli([
    "run",
    "1s",
    "--stateful",
    "--max",
    "3",
    "--model",
    "gemini-4-hydrogen-xhigh",
    "--fallback-model",
    "gemini-4-carbon-high",
    "--json",
    "stream error fallback",
  ]);
  assert.equal(fbRes.status, 0, fbRes.stderr);
  const fbPayload = JSON.parse(fbRes.stdout);
  assert.equal(fbPayload.active_model, "gemini-4-carbon-high");
  assert.equal(fbPayload.conversation_id, "conv-stream-fb");
  const fbStarts = sb.readCalls().filter((c) => c.mode === "stream-start");
  assert.equal(fbStarts.length, 2);
  assert.equal(fbStarts[1].conversationArg, "conv-stream-fb");
  assert.equal(fbStarts[1].args[fbStarts[1].args.indexOf("--model") + 1], "gemini-4-carbon-high");

  // (c) result{status:"SUCCESS", finished_reason:"print_timeout"} + exit(0) -> retry + session respawn
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-pto-1",
        turns: [
          {
            stderr:
              'AGY_ERROR: {"status":"DEADLINE_EXCEEDED","retryable":false,"reason":"print_timeout"}\n',
            result: {
              status: "SUCCESS",
              finished_reason: "print_timeout",
              usage: { total_tokens: 20 },
            },
          },
        ],
      },
      {
        turns: [
          {
            result: {
              status: "SUCCESS",
              usage: { total_tokens: 45 },
              structured_output: {
                iteration: 1,
                loop_status: "DONE",
                next_delay_sec: 0,
                summary: "Succeeded after print_timeout retry",
                next_hint: "None",
              },
            },
          },
        ],
      },
    ],
  });
  const cfg = parseRunArgs(["--stateful", "--once", "--max-retries", "2", "--quiet", "pto test"]);
  cfg.cwd = sb.workspace;
  const ptoSleeps = [];
  const ptoRes = await runHeadlessLoop(cfg, {
    agyBin: sb.mockAgyPath,
    env: sb.baseEnv,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    rng: () => 0.5,
    sleepFn: async (ms) => ptoSleeps.push(ms),
    registerSignals: false,
  });
  assert.equal(ptoRes.exitCode, EXIT_CODES.DONE);
  assert.equal(ptoRes.state.status, "done");
  assert.equal(
    ptoSleeps.reduce((a, b) => a + b, 0),
    30000
  );
  const ptoEvents = readEvents(sb.stateDir, ptoRes.state.loop_id);
  assert.ok(ptoEvents.some((ev) => ev.event === "retry" && ev.reason === "print_timeout"));
  assert.equal(
    ptoEvents.some((ev) => ev.event === "error"),
    false,
    "print_timeout must route to retry, not schema error"
  );
  const ptoStarts = sb.readCalls().filter((c) => c.mode === "stream-start");
  assert.equal(ptoStarts.length, 2);
  assert.equal(ptoStarts[1].conversationArg, "conv-pto-1");
});

test("regression #49 #2: --verifier-model fails closed on --once/final rejection & crash, retries before maxIterations", (t) => {
  const sb = makeHeadlessSandbox(t);

  // (a) --once verifier rejection -> status: "blocked", exit_reason: "verifier_rejected", exit 3
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Worker claimed done",
            next_hint: "None",
          },
        },
      },
    ],
    verifierTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 30 },
          structured_output: {
            passed: false,
            summary: "Tests still failing",
            issues: ["Fix failing assertion"],
          },
        },
      },
    ],
  });
  const rejOnce = sb.runCli([
    "run",
    "--once",
    "--verifier-model",
    "gemini-4-neon-xhigh",
    "--json",
    "verify once reject",
  ]);
  assert.equal(rejOnce.status, 3);
  const rejPayload = JSON.parse(rejOnce.stdout);
  assert.equal(rejPayload.status, "blocked");
  assert.equal(rejPayload.exit_reason, "verifier_rejected");

  // (b) --once verifier crash / invalid JSON -> status: "blocked", exit_reason: "verifier_error", exit 1
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Worker claimed done",
            next_hint: "None",
          },
        },
      },
    ],
    verifierTurns: [
      {
        exitCode: 1,
        stderr: "verifier crashed\n",
        envelope: null,
      },
    ],
  });
  const errOnce = sb.runCli([
    "run",
    "--once",
    "--verifier-model",
    "gemini-4-neon-xhigh",
    "--json",
    "verify once error",
  ]);
  assert.equal(errOnce.status, 1);
  const errPayload = JSON.parse(errOnce.stdout);
  assert.equal(errPayload.status, "blocked");
  assert.equal(errPayload.exit_reason, "verifier_error");

  // (c) Verifier crash on pass 1 when iteration < maxIterations -> CONTINUE with verifier error hint, then pass 2 DONE
  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 1,
            summary: "Pass 1 claimed done",
            next_hint: "None",
          },
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 50 },
          structured_output: {
            iteration: 2,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Pass 2 verified done",
            next_hint: "None",
          },
        },
      },
    ],
    verifierTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 15 },
          response: "Unparseable verifier prose without JSON",
        },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 25 },
          structured_output: {
            passed: true,
            summary: "Confirmed green",
            issues: [],
          },
        },
      },
    ],
  });
  const retryVerRes = sb.runCli([
    "run",
    "1s",
    "--max",
    "3",
    "--verifier-model",
    "gemini-4-neon-xhigh",
    "--json",
    "verify retry on error",
  ]);
  assert.equal(retryVerRes.status, 0, retryVerRes.stderr);
  const retryVerPayload = JSON.parse(retryVerRes.stdout);
  assert.equal(retryVerPayload.iterations, 2);
  const workerCalls = sb.readCalls().filter((c) => c.mode === "json" && c.turnKind === "worker");
  assert.match(workerCalls[1].args[workerCalls[1].args.length - 1], /Verifier error/);
});

test("regression #49 #3: --worktree resolves relative --add-dir and --settings against workspaceDir without persisting settingsArg", (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.initGitRepo();

  const sharedDir = path.join(sb.root, "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  const localSettingsPath = path.join(sb.workspace, "local-settings.json");
  fs.writeFileSync(localSettingsPath, '{"apiKey":"SECRET_NEVER_PERSIST"}\n', "utf8");

  sb.setScenario({
    jsonTurns: [
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 70 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Worktree relative paths ok",
            next_hint: "None",
          },
        },
      },
    ],
  });

  const res = sb.runCli([
    "run",
    "--once",
    "--worktree",
    "--add-dir",
    "../shared",
    "--settings",
    "./local-settings.json",
    "--json",
    "relative path test",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(res.stdout);

  const workerCall = sb.readCalls().find((c) => c.mode === "json");
  const passedAddDir = workerCall.args[workerCall.args.indexOf("--add-dir") + 1];
  const passedSettings = workerCall.args[workerCall.args.indexOf("--settings") + 1];
  const expectedAddDir = fs.realpathSync(sharedDir);
  const expectedSettings = fs.realpathSync(localSettingsPath);
  assert.equal(passedAddDir, expectedAddDir);
  assert.equal(passedSettings, expectedSettings);
  assert.equal(fs.existsSync(passedAddDir), true);
  assert.equal(fs.existsSync(passedSettings), true);

  const savedState = readLoopState(sb.stateDir, payload.loop_id);
  assert.deepEqual(savedState.add_dirs, [expectedAddDir]);
  const serializedArtifacts = [
    JSON.stringify(savedState),
    JSON.stringify(readEvents(sb.stateDir, payload.loop_id)),
    res.stdout,
  ].join("\n");
  assert.equal(serializedArtifacts.includes("SECRET_NEVER_PERSIST"), false);
  assert.equal(serializedArtifacts.includes("local-settings.json"), false);
});

test("regression #49 #4: outer safety watchdog timeout retries via classifyTurnFailure", async (t) => {
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    jsonTurns: [
      {
        sleepMs: 500,
        envelope: { status: "SUCCESS" },
      },
      {
        envelope: {
          status: "SUCCESS",
          usage: { total_tokens: 55 },
          structured_output: {
            iteration: 1,
            loop_status: "DONE",
            next_delay_sec: 0,
            summary: "Recovered from outer watchdog",
            next_hint: "None",
          },
        },
      },
    ],
  });

  const cfg = parseRunArgs(["--once", "--max-retries", "2", "--quiet", "watchdog test"]);
  cfg.cwd = sb.workspace;
  const sleeps = [];
  const res = await runHeadlessLoop(cfg, {
    agyBin: sb.mockAgyPath,
    env: sb.baseEnv,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    outerTimeoutMs: 80,
    rng: () => 0.5,
    sleepFn: async (ms) => sleeps.push(ms),
    registerSignals: false,
  });

  assert.equal(res.exitCode, EXIT_CODES.DONE);
  assert.equal(res.state.status, "done");
  assert.equal(sb.readCalls().filter((c) => c.mode === "json").length, 2);
  assert.equal(
    sleeps.reduce((a, b) => a + b, 0),
    30000
  );
  const events = readEvents(sb.stateDir, res.state.loop_id);
  assert.ok(
    events.some(
      (ev) => ev.event === "retry" && ev.reason === "turn timed out (outer watchdog)"
    )
  );
});

test("regression #49 #6 & #7: leading-dash -p= flag, StreamSession startup stderr preservation, and stdin EPIPE exitCode", async (t) => {
  // #49 #6: prompt starting with '-' uses -p=<prompt>
  const helpPromptArgs = buildJsonTurnArgs({ prompt: "--help" });
  assert.equal(helpPromptArgs[helpPromptArgs.length - 1], "-p=--help");
  assert.equal(helpPromptArgs.includes("-p"), false);
  const dashHArgs = buildJsonTurnArgs({ prompt: "-h" });
  assert.equal(dashHArgs[dashHArgs.length - 1], "-p=-h");
  const normalArgs = buildJsonTurnArgs({ prompt: "hello" });
  assert.deepEqual(normalArgs.slice(-2), ["-p", "hello"]);

  // #49 #7a: Turn 1 preserves startup stderr, Turn 2 resets stderr
  const sb = makeHeadlessSandbox(t);
  sb.setScenario({
    streamSessions: [
      {
        conversationId: "conv-startup-stderr",
        startupStderr: "startup advisory line\n",
        turns: [
          {
            result: {
              status: "SUCCESS",
              usage: { total_tokens: 10 },
              structured_output: {
                iteration: 1,
                loop_status: "CONTINUE",
                next_delay_sec: 1,
                summary: "t1",
                next_hint: "t2",
              },
            },
          },
          {
            stderr: "turn2 stderr only\n",
            result: {
              status: "SUCCESS",
              usage: { total_tokens: 20 },
              structured_output: {
                iteration: 2,
                loop_status: "DONE",
                next_delay_sec: 0,
                summary: "t2",
                next_hint: "None",
              },
            },
          },
        ],
      },
    ],
  });
  const sess1 = new StreamSession({ agyBin: sb.mockAgyPath, cwd: sb.workspace, env: sb.baseEnv });
  try {
    const t1 = await sess1.sendTurn("turn 1");
    assert.equal(t1.exitCode, 0);
    assert.match(t1.rawStderr, /startup advisory line/);
    const t2 = await sess1.sendTurn("turn 2");
    assert.equal(t2.exitCode, 0);
    assert.equal(t2.rawStderr.includes("startup advisory line"), false);
    assert.match(t2.rawStderr, /turn2 stderr only/);
  } finally {
    await sess1.close();
  }

  // #49 #7b: immediate startup crash & stdin destroyed/EPIPE defer to real exit code + AGY_ERROR
  sb.setScenario({
    streamSessions: [
      {
        startupStderr:
          'AGY_ERROR: {"status":429,"error_code":"RESOURCE_EXHAUSTED","retryable":true,"short_error":"Startup quota"}\n',
        startupExitCode: 3,
      },
      {
        ignoreStdinEof: true,
        startupDelayMs: 60,
        startupStderr:
          'AGY_ERROR: {"status":429,"error_code":"RESOURCE_EXHAUSTED","retryable":true,"short_error":"Delayed EPIPE quota"}\n',
        startupExitCode: 3,
      },
    ],
  });
  const sess2 = new StreamSession({ agyBin: sb.mockAgyPath, cwd: sb.workspace, env: sb.baseEnv });
  try {
    const crashOutcome = await sess2.sendTurn("hello during immediate exit");
    assert.equal(crashOutcome.crashed, true);
    assert.equal(crashOutcome.exitCode, 3);
    assert.equal(crashOutcome.agyError?.error_code, "RESOURCE_EXHAUSTED");
    assert.match(crashOutcome.rawStderr, /Startup quota/);
  } finally {
    await sess2.close();
  }

  const sess3 = new StreamSession({ agyBin: sb.mockAgyPath, cwd: sb.workspace, env: sb.baseEnv });
  try {
    await sess3.start();
    sess3._child.stdin.destroy();
    const epipeOutcome = await sess3.sendTurn("hello after destroyed stdin");
    assert.equal(epipeOutcome.crashed, true);
    assert.equal(epipeOutcome.exitCode, 3);
    assert.equal(epipeOutcome.agyError?.error_code, "RESOURCE_EXHAUSTED");
    assert.match(epipeOutcome.rawStderr, /Delayed EPIPE quota/);
  } finally {
    await sess3.close();
  }
});

