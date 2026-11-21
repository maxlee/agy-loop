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

    // 2. Verify agy plugin list --json exposes v1.1.0 skill, subagent, and hook
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
    assert.equal(entry.version, "1.1.0");
    assert.ok(Array.isArray(entry.skills) && entry.skills.includes("loop"));
    assert.ok(Array.isArray(entry.agents) && entry.agents.includes("loop-worker"));
    assert.ok(Array.isArray(entry.hooks) && entry.hooks.includes("agy-loop-shadow-check"));

    // 3. Verify node bin/agy-loop.mjs doctor --json passes all v1.1 diagnostics
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
    assert.equal(doc.plugin?.version, "1.1.0");

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
