import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_HOME = os.homedir();

const isLiveEnabled = process.env.AGY_LIVE_TEST === "1";
const agyProbe = isLiveEnabled ? spawnSync("agy", ["--version"], { encoding: "utf8" }) : null;
const hasRealAgy = Boolean(agyProbe && !agyProbe.error && agyProbe.status === 0);
const skipReason = !isLiveEnabled
  ? "Set AGY_LIVE_TEST=1 to run live agy CLI behavioral tests"
  : !hasRealAgy
    ? "real 'agy' CLI not on PATH"
    : false;

function buildCleanAgyEnv(customHome = null) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTIGRAVITY_")) {
      delete env[key];
    }
  }
  if (customHome) {
    env.HOME = customHome;
  }
  return env;
}

test(
  "live: 'agy plugin validate --strict --json .' reports 0 findings and all v1.1 components",
  { skip: skipReason },
  () => {
    const res = spawnSync("agy", ["plugin", "validate", "--strict", "--json", REPO_ROOT], {
      cwd: REPO_ROOT,
      env: buildCleanAgyEnv(),
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(
      res.status,
      0,
      `agy plugin validate --strict failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    const report = JSON.parse(res.stdout);
    assert.equal(report.name, "agy-loop");
    assert.deepEqual(report.findings, []);
    assert.ok(report.components.skills >= 1, "Expected components.skills >= 1");
    assert.ok(report.components.agents >= 1, "Expected components.agents >= 1");
    assert.equal(report.components.hooks, 1, "Expected components.hooks === 1");
  }
);

test(
  "live: isolated HOME 'agy plugin install .', 'doctor --json', and 'agy --output-format json models'",
  { skip: skipReason },
  (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-live-"));
    const tmpHome = path.join(tmpRoot, "home");
    const tmpWs = path.join(tmpRoot, "ws");
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpWs, { recursive: true });
    t.after(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const isolatedEnv = buildCleanAgyEnv(tmpHome);
    assert.notEqual(isolatedEnv.HOME, REAL_HOME);

    // 1. Install plugin cleanly into isolated temp HOME
    const installRes = spawnSync("agy", ["plugin", "install", REPO_ROOT], {
      cwd: tmpWs,
      env: isolatedEnv,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(
      installRes.status,
      0,
      `agy plugin install failed:\nstdout: ${installRes.stdout}\nstderr: ${installRes.stderr}`
    );

    const installedDir = path.join(tmpHome, ".gemini", "config", "plugins", "agy-loop");
    assert.equal(fs.existsSync(path.join(installedDir, "plugin.json")), true);

    // 2. Verify agy plugin list --json exposes v1.2.0 skill, subagent, and hook
    const listRes = spawnSync("agy", ["plugin", "list", "--json"], {
      cwd: tmpWs,
      env: isolatedEnv,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(listRes.status, 0, listRes.stderr);
    const pluginList = JSON.parse(listRes.stdout);
    const entry = (Array.isArray(pluginList) ? pluginList : pluginList.plugins || []).find(
      (p) => p && p.name === "agy-loop"
    );
    assert.ok(entry, "Expected agy-loop in isolated agy plugin list --json");
    assert.equal(entry.enabled, true);
    assert.equal(entry.version, "1.2.0");
    assert.ok(Array.isArray(entry.skills) && entry.skills.includes("loop"));
    assert.ok(Array.isArray(entry.agents) && entry.agents.includes("loop-worker"));
    assert.ok(Array.isArray(entry.hooks) && entry.hooks.includes("agy-loop-shadow-check"));

    // 3. Verify node bin/agy-loop.mjs doctor --json passes all v1.2 diagnostics
    const docRes = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "bin", "agy-loop.mjs"), "doctor", "--json"],
      {
        cwd: tmpWs,
        env: isolatedEnv,
        encoding: "utf8",
        timeout: 30000,
      }
    );
    assert.equal(docRes.status, 0, `doctor --json failed:\nstdout: ${docRes.stdout}\nstderr: ${docRes.stderr}`);
    const doc = JSON.parse(docRes.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.hookSelfTest?.ok, true);
    assert.equal(doc.agentToolsCheck?.ok, true);
    assert.equal(doc.plugin?.installed, true);
    assert.equal(doc.plugin?.version, "1.2.0");

    // 4. Verify agy --output-format json models exits 0 with valid JSON (uses authenticated user HOME with ANTIGRAVITY_* stripped)
    const modelsRes = spawnSync("agy", ["--output-format", "json", "models"], {
      cwd: tmpWs,
      env: buildCleanAgyEnv(),
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(
      modelsRes.status,
      0,
      `agy --output-format json models failed:\nstdout: ${modelsRes.stdout}\nstderr: ${modelsRes.stderr}`
    );
    const modelsJson = JSON.parse(modelsRes.stdout);
    assert.equal(modelsJson.status, "SUCCESS");
    assert.equal(typeof modelsJson.response, "string");
    assert.ok(modelsJson.response.length > 0);
  }
);

test(
  "live: 'agy --output-format json --print-timeout 45s -p' handles /agents and /help cleanly with 0 tokens and no hook/registry errors",
  { skip: skipReason },
  (t) => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-live-cmd-"));
    t.after(() => {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    });

    const cleanEnv = buildCleanAgyEnv();

    for (const [slashCmd, expectedCmdName] of [
      ["/agents", "agents"],
      ["/help", "help"],
    ]) {
      const res = spawnSync(
        "agy",
        ["--output-format", "json", "--print-timeout", "45s", "-p", slashCmd],
        {
          cwd: tmpWs,
          env: cleanEnv,
          encoding: "utf8",
          timeout: 45000,
        }
      );
      assert.equal(
        res.status,
        0,
        `agy -p ${slashCmd} failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
      );
      assert.doesNotMatch(
        res.stderr,
        /not found in registry|protojson|hook.*error|failed to load/i,
        `Unexpected hook/registry error in stderr for ${slashCmd}: ${res.stderr}`
      );
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.status, "SUCCESS");
      assert.equal(parsed.usage?.total_tokens ?? 0, 0);
      assert.equal(parsed.command?.name, expectedCmdName);
    }
  }
);

test(
  "live: 'agy-loop run --once --model gemini-4-carbon-low --json' executes single turn and updates ps & logs",
  { skip: skipReason },
  (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-live-once-"));
    const tmpWs = path.join(tmpRoot, "ws");
    const tmpStateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(tmpWs, { recursive: true });
    t.after(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const liveEnv = {
      ...buildCleanAgyEnv(),
      AGY_LOOP_STATE_DIR: tmpStateDir,
    };
    const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");

    const runRes = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "--once",
        "--model",
        "gemini-4-carbon-low",
        "--turn-timeout",
        "60s",
        "--json",
        "Do not edit files or run tools. Immediately finish with iteration 1, loop_status DONE, next_delay_sec 0, summary 'Live once ok', next_hint 'None'.",
      ],
      {
        cwd: tmpWs,
        env: liveEnv,
        encoding: "utf8",
        timeout: 120000,
      }
    );
    assert.equal(
      runRes.status,
      0,
      `agy-loop run --once failed (exit=${runRes.status}):\nstdout: ${runRes.stdout}\nstderr: ${runRes.stderr}`
    );

    const payload = JSON.parse(runRes.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.status, "done");
    assert.ok(payload.loop_id);
    assert.ok(payload.usage_totals.total_tokens > 0, "Expected positive live token usage");

    const statePath = path.join(tmpStateDir, "loops", payload.loop_id, "state.json");
    assert.equal(fs.existsSync(statePath), true);
    const savedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(savedState.status, "done");
    assert.ok(savedState.usage_totals.total_tokens > 0);

    const psRes = spawnSync(process.execPath, [cliPath, "ps", "--all", "--json"], {
      cwd: tmpWs,
      env: liveEnv,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(psRes.status, 0, psRes.stderr);
    const psJson = JSON.parse(psRes.stdout);
    assert.ok(psJson.loops.some((l) => l.loop_id === payload.loop_id && l.status === "done"));

    const logsRes = spawnSync(
      process.execPath,
      [cliPath, "logs", payload.loop_id, "--json"],
      {
        cwd: tmpWs,
        env: liveEnv,
        encoding: "utf8",
        timeout: 15000,
      }
    );
    assert.equal(logsRes.status, 0, logsRes.stderr);
    const logEvents = logsRes.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(logEvents.some((ev) => ev.event === "init"));
    assert.ok(logEvents.some((ev) => ev.event === "iteration"));
  }
);

test(
  "live: 'agy-loop run 1s --stateful --max 2 --model gemini-4-carbon-low' reuses stream-json session with per-turn usage_delta",
  { skip: skipReason },
  (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-live-stateful-"));
    const tmpWs = path.join(tmpRoot, "ws");
    const tmpStateDir = path.join(tmpRoot, "state");
    fs.mkdirSync(tmpWs, { recursive: true });
    t.after(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const liveEnv = {
      ...buildCleanAgyEnv(),
      AGY_LOOP_STATE_DIR: tmpStateDir,
    };
    const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");

    const runRes = spawnSync(
      process.execPath,
      [
        cliPath,
        "run",
        "1s",
        "--stateful",
        "--max",
        "2",
        "--model",
        "gemini-4-carbon-low",
        "--turn-timeout",
        "60s",
        "--json",
        "Do not edit files or run tools. On iteration 1 return loop_status CONTINUE with next_delay_sec 1; on iteration 2 return loop_status DONE with next_delay_sec 0.",
      ],
      {
        cwd: tmpWs,
        env: liveEnv,
        encoding: "utf8",
        timeout: 180000,
      }
    );
    assert.equal(
      runRes.status,
      0,
      `agy-loop run --stateful failed (exit=${runRes.status}):\nstdout: ${runRes.stdout}\nstderr: ${runRes.stderr}`
    );

    const payload = JSON.parse(runRes.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.exit_code, 0);
    assert.equal(payload.status, "done");

    const loopDir = path.join(tmpStateDir, "loops", payload.loop_id);
    const savedState = JSON.parse(fs.readFileSync(path.join(loopDir, "state.json"), "utf8"));
    assert.equal(savedState.transport, "stream-json");
    assert.equal(savedState.iteration, 2);
    assert.equal(typeof savedState.conversation_id, "string");
    assert.ok(savedState.conversation_id.length > 0, "Expected non-empty conversation_id");
    assert.ok(savedState.usage_totals.total_tokens > 0);

    const events = fs
      .readFileSync(path.join(loopDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const iterEvents = events.filter((ev) => ev.event === "iteration");
    assert.equal(iterEvents.length, 2, `Expected 2 iteration events, got ${iterEvents.length}`);
    for (const ev of iterEvents) {
      assert.ok(
        ev.usage_delta && ev.usage_delta.total_tokens > 0,
        `Expected positive per-turn usage_delta on iteration ${ev.iteration}`
      );
    }

    const statuslineRes = spawnSync(process.execPath, [cliPath, "statusline"], {
      cwd: tmpWs,
      env: liveEnv,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(statuslineRes.status, 0, statuslineRes.stderr);
    assert.equal(statuslineRes.stdout, "");
  }
);
