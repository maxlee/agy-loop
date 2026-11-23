import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUILTIN_MAINTENANCE_PROMPT,
  LOOP_MD_MAX_BYTES,
  VALID_PROFILE_NAME_RE,
  listProfiles,
  mergeProfileWithCli,
  parseProfileDocument,
  resolveProfileTask,
  truncateUtf8Bytes,
  validateCronExpression,
  validateIanaTimezone,
  validateProfileName,
  validateSidecarGrants,
} from "../lib/profile-parser.mjs";
import {
  acquireLeaseLock,
  computeLockScope,
  getLeaseLockPath,
  listLeaseLocks,
  markLeaseDraining,
  refreshLeaseHeartbeat,
  releaseLeaseLock,
  startLeaseHeartbeat,
  unmarkLeaseDraining,
} from "../lib/lease-lock.mjs";
import {
  VALID_DAEMON_SLUG_RE,
  buildLaunchAgentPlist,
  buildSidecarConfig,
  buildSystemdUnits,
  computeDaemonSlug,
  detectHostTimezone,
  installOsDaemon,
  installSidecarDaemon,
  intervalToCron,
  listDaemons,
  readDaemonLogs,
  removeDaemon,
  validateDaemonSlug,
  validatePersistentWorkspace,
} from "../lib/daemon.mjs";
import {
  createLoopState,
  enqueueInboxMessage,
  peekInboxFlags,
  readDaemonRegistry,
  resolveDaemonRegistryPath,
} from "../lib/state-store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(REPO_ROOT, "bin", "agy-loop.mjs");
const LEASE_LOCK_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, "lib", "lease-lock.mjs")).href;
const REAL_HOME = os.homedir();

function makeMockAgyScript() {
  return `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const logFile = process.env.MOCK_AGY_LOG;
const scenarioFile = process.env.MOCK_AGY_SCENARIO;
const mockVersion = process.env.MOCK_AGY_VERSION || "1.5.14";
const mockPluginVersion = process.env.MOCK_AGY_PLUGIN_VERSION || "2.0.0";

if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ args, cwd: process.cwd() }) + "\\n", "utf8");
}

function readScenario() {
  try {
    return scenarioFile ? JSON.parse(fs.readFileSync(scenarioFile, "utf8")) : {};
  } catch {
    return {};
  }
}

if (args[0] === "--version") {
  process.stdout.write(\`\${mockVersion}\\n\`);
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "list" && args.includes("--json")) {
  process.stdout.write(
    JSON.stringify([
      {
        name: "agy-loop",
        enabled: true,
        version: mockPluginVersion,
        source: "antigravity",
        path: process.env.MOCK_AGY_PLUGIN_PATH || "${REPO_ROOT}",
        skills: ["loop"],
      },
    ]) + "\\n"
  );
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "validate") {
  const target = args[args.length - 1];
  const payload = {
    dir: target,
    manifest: "plugin.json",
    name: "agy-loop",
    findings: [],
  };
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
  } else {
    process.stdout.write(\`Validated \${target} (0 findings)\\n\`);
  }
  process.exit(0);
}

if (!args.includes("-p") && args.includes("models")) {
  process.stdout.write(
    JSON.stringify({
      status: "SUCCESS",
      response: "gemini-4-carbon-low\\tGemini 4 Carbon (Low)\\ngemini-4-hydrogen-xhigh\\tGemini 4 Hydrogen (xHigh)\\ngemini-4-neon-xhigh\\tGemini 4 Neon (xHigh)\\n",
    }) + "\\n"
  );
  process.exit(0);
}

if (args.includes("-p")) {
  const sc = readScenario();
  const envelope = sc.jsonEnvelope || {
    status: "SUCCESS",
    conversation_id: "conv-v2-test-1",
    usage: { total_tokens: 42 },
    structured_output: {
      iteration: 1,
      loop_status: "DONE",
      next_delay_sec: 0,
      summary: "Mock turn ok",
      next_hint: "None",
    },
  };
  process.stdout.write(JSON.stringify(envelope) + "\\n");
  process.exit(sc.jsonExitCode ?? 0);
}

process.stderr.write(\`Unexpected mock agy args: \${args.join(" ")}\\n\`);
process.exit(1);
`;
}

function makeV2Sandbox(t, { withMockAgy = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-v2-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "my_repo");
  const stateDir = path.join(root, "state");
  const indexPath = path.join(root, "index.json");
  const mockBin = path.join(root, "mock-bin");
  const logFile = path.join(root, "mock-agy.jsonl");
  const scenarioFile = path.join(root, "mock-agy-scenario.json");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mockAgyPath = path.join(mockBin, "agy");
  if (withMockAgy) {
    fs.writeFileSync(mockAgyPath, makeMockAgyScript(), { mode: 0o755 });
  }

  const nodeBinDir = path.dirname(process.execPath);
  const env = {
    ...process.env,
    HOME: home,
    AGY_LOOP_STATE_DIR: stateDir,
    AGY_LOOP_INDEX_PATH: indexPath,
    MOCK_AGY_LOG: logFile,
    MOCK_AGY_SCENARIO: scenarioFile,
    MOCK_AGY_PLUGIN_PATH: REPO_ROOT,
    PATH: `${withMockAgy ? `${mockBin}${path.delimiter}` : ""}${nodeBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };
  delete env.AGY_LOOP_DAEMON_REGISTRY_PATH;
  delete env.ANTIGRAVITY_LS_ADDRESS;
  delete env.ANTIGRAVITY_CSRF_TOKEN;
  assert.notEqual(env.HOME, REAL_HOME);

  function setScenario(sc) {
    fs.writeFileSync(scenarioFile, JSON.stringify(sc, null, 2), "utf8");
  }

  function readAgyCalls() {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function runCli(args, { cwd = workspace, customEnv = env } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: customEnv,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  return {
    root,
    home,
    workspace,
    stateDir,
    indexPath,
    mockBin,
    mockAgyPath,
    env,
    setScenario,
    readAgyCalls,
    runCli,
  };
}

// ============================================================================
// 1. lib/profile-parser.mjs
// ============================================================================

test("v2 unit: lib/profile-parser.mjs parses v1 pure Markdown, full v2 YAML frontmatter, aliases, comments, and body-only 25k UTF-8 cap", () => {
  // Pure v1 Markdown (no frontmatter; mid-file --- horizontal rule stays body)
  const v1Text = "# Maintenance Task\n\nCheck build.\n\n---\n\nKeep going.\n";
  const v1 = parseProfileDocument(v1Text, { sourceLabel: ".agents/loop.md" });
  assert.equal(v1.hasFrontmatter, false);
  assert.deepEqual(v1.config, {});
  assert.equal(v1.body, v1Text);
  assert.equal(v1.truncated, false);

  // Full v2 YAML frontmatter (scalars, quotes, comments, booleans, ints, inline & block lists, CRLF)
  const fullYaml = [
    "---",
    "# Leading comment",
    "name: ci-watch",
    'description: "Watch PR #99 & fix \\"flaky\\" tests\\nline2"',
    "engine: workflow # inline comment",
    "interval: 2m30s",
    'cron: "*/15 * * * *"',
    "timezone: Asia/Shanghai",
    "once: false",
    "max_iterations: 12",
    "state_mode: stateful",
    "reset_every: 4",
    "model: gemini-4-hydrogen-xhigh",
    "effort: xhigh",
    "fallback_model: gemini-4-carbon-high",
    "verify: true",
    "verifier_model: gemini-4-neon-xhigh",
    "verify_timeout: 45s",
    "probe_timeout: 15s",
    "mode: accept-edits",
    "sandbox: true",
    "worktree: true",
    "keep_worktree: false",
    "fail_on_denied: true",
    "max_tokens: 80000",
    "max_duration: 2h",
    "max_retries: 0",
    "max_errors: 5",
    "turn_timeout: 3m",
    'targets: ["pkg/a,1", \'pkg/b\', pkg/c]',
    "singleton: profile",
    "access_grants:",
    '  - "command(npm test)" # block comment',
    "  - 'read_file(./src)'",
    "---",
    "",
    "# Body starts here",
    "Run checks.",
    "",
  ].join("\r\n");

  const parsed = parseProfileDocument(fullYaml, { sourceLabel: ".agents/loops/ci-watch.md" });
  assert.equal(parsed.hasFrontmatter, true);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.config.name, "ci-watch");
  assert.equal(parsed.config.description, 'Watch PR #99 & fix "flaky" tests\nline2');
  assert.equal(parsed.config.engine, "workflow");
  assert.equal(parsed.config.interval_sec, 150);
  assert.equal(parsed.config.interval_label, "2m30s");
  assert.equal(parsed.config.cron, "*/15 * * * *");
  assert.equal(parsed.config.timezone, "Asia/Shanghai");
  assert.equal(parsed.config.once, false);
  assert.equal(parsed.config.max_iterations, 12);
  assert.equal(parsed.config.state_mode, "stateful");
  assert.equal(parsed.config.reset_every, 4);
  // Aliases model -> worker_model, max_tokens -> budget_tokens
  assert.equal(parsed.config.worker_model, "gemini-4-hydrogen-xhigh");
  assert.equal(parsed.config.budget_tokens, 80000);
  assert.equal(parsed.config.effort, "xhigh");
  assert.equal(parsed.config.fallback_model, "gemini-4-carbon-high");
  assert.equal(parsed.config.verify, true);
  assert.equal(parsed.config.verifier_model, "gemini-4-neon-xhigh");
  assert.equal(parsed.config.verify_timeout_sec, 45);
  assert.equal(parsed.config.probe_timeout_sec, 15);
  assert.equal(parsed.config.mode, "accept-edits");
  assert.equal(parsed.config.sandbox, true);
  assert.equal(parsed.config.worktree, true);
  assert.equal(parsed.config.keep_worktree, false);
  assert.equal(parsed.config.fail_on_denied, true);
  assert.equal(parsed.config.max_duration_sec, 7200);
  assert.equal(parsed.config.max_retries, 0);
  assert.equal(parsed.config.max_errors, 5);
  assert.equal(parsed.config.turn_timeout_sec, 180);
  assert.deepEqual(parsed.config.targets, ["pkg/a,1", "pkg/b", "pkg/c"]);
  assert.equal(parsed.config.singleton, "profile");
  assert.deepEqual(parsed.config.access_grants, ["command(npm test)", "read_file(./src)"]);
  assert.match(parsed.body, /^# Body starts here\r?\nRun checks\./);

  // UTF-8-safe 25k cap applies ONLY to body; frontmatter remains intact
  const bigFm = [
    "---",
    "name: big-body",
    `description: "${"x".repeat(400)}"`,
    "max_iterations: 9",
    "---",
    "中".repeat(9000), // 27,000 UTF-8 bytes
  ].join("\n");
  const bigDoc = parseProfileDocument(bigFm, { sourceLabel: "big.md" });
  assert.equal(bigDoc.hasFrontmatter, true);
  assert.equal(bigDoc.config.max_iterations, 9);
  assert.equal(bigDoc.truncated, true);
  assert.ok(bigDoc.bodyBytes <= LOOP_MD_MAX_BYTES);
  assert.equal(Buffer.byteLength(bigDoc.body, "utf8"), bigDoc.bodyBytes);
  assert.equal(bigDoc.body.includes("\uFFFD"), false);

  // Boundary check for 4-byte emoji UTF-8 truncation helper
  const emojiRes = truncateUtf8Bytes(Buffer.from("🚀".repeat(7), "utf8"), 10);
  assert.equal(emojiRes.truncated, true);
  assert.equal(emojiRes.text, "🚀🚀");
  assert.equal(Buffer.byteLength(emojiRes.text, "utf8"), 8);
});

test("v2 unit: lib/profile-parser.mjs rejects unknown keys with typo suggestions, conflicts, bad timezones, and traversal", () => {
  // Typo suggestions
  assert.throws(
    () => parseProfileDocument("---\ntz: UTC\n---\nbody\n"),
    /Unknown frontmatter key 'tz'.*did you mean 'timezone'/
  );
  assert.throws(
    () => parseProfileDocument("---\nmax_iters: 5\n---\nbody\n"),
    /Unknown frontmatter key 'max_iters'.*did you mean 'max_iterations'/
  );
  assert.throws(
    () => parseProfileDocument("---\nverfiy: true\n---\nbody\n"),
    /Unknown frontmatter key 'verfiy'.*did you mean 'verify'/
  );

  // Mutual exclusions & schema conflicts
  assert.throws(
    () => parseProfileDocument("---\nonce: true\nmax_iterations: 5\n---\nbody\n"),
    /once: true.*max_iterations: 5/
  );
  assert.throws(
    () => parseProfileDocument("---\nmodel: flash\nworker_model: pro\n---\nbody\n"),
    /'worker_model' and 'model' cannot both be set/
  );
  assert.throws(
    () => parseProfileDocument("---\nbudget_tokens: 100\nmax_tokens: 200\n---\nbody\n"),
    /'budget_tokens' and 'max_tokens' cannot both be set/
  );
  assert.throws(
    () => parseProfileDocument("---\nreset_every: 2\n---\nbody\n"),
    /'reset_every' requires 'state_mode: stateful'/
  );
  assert.throws(
    () => parseProfileDocument("---\nstate_mode: fresh\nreset_every: 2\n---\nbody\n"),
    /'reset_every' requires 'state_mode: stateful'/
  );
  assert.throws(
    () => parseProfileDocument("---\nprobe_until_pass: true\n---\nbody\n"),
    /'probe_until_pass: true' requires 'probe_cmd'/
  );
  assert.throws(
    () => parseProfileDocument("---\nname: ok\n"),
    /Unclosed YAML frontmatter/
  );

  // Path traversal & invalid profile names
  assert.equal(VALID_PROFILE_NAME_RE.test("ci-pr.v2_check"), true);
  for (const badName of ["../evil", "a/b", "a\\b", ".hidden", "has space", "", "a".repeat(65)]) {
    assert.equal(validateProfileName(badName), false, `Expected invalid profile name '${badName}'`);
  }

  // Timezone & cron validation
  assert.equal(validateIanaTimezone("UTC"), "UTC");
  assert.equal(validateIanaTimezone("America/New_York"), "America/New_York");
  for (const badTz of ["PST", "+08:00", "UTC+8", "Mars/Olympus", ""]) {
    assert.throws(() => validateIanaTimezone(badTz), /Invalid (?:IANA )?timezone/);
  }
  assert.equal(validateCronExpression(" 0  9 * * mon-fri "), "0 9 * * mon-fri");
  for (const badCron of ["* * *", "60 * * * *", "* * * * 9", ""]) {
    assert.throws(() => validateCronExpression(badCron), /Invalid cron/);
  }
});

test("v2 unit: lib/profile-parser.mjs precedence, listProfiles, CLI > frontmatter > defaults merge, and --trust-profile-commands red line", (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });

  // Path traversal rejection in resolveProfileTask
  assert.throws(
    () => resolveProfileTask({ workspaceDir: sb.workspace, homeDir: sb.home, profile: "../evil" }),
    /Invalid profile name/
  );
  assert.throws(
    () => resolveProfileTask({ workspaceDir: sb.workspace, homeDir: sb.home, profile: "a/b" }),
    /Invalid profile name/
  );
  assert.throws(
    () =>
      resolveProfileTask({
        workspaceDir: sb.workspace,
        homeDir: sb.home,
        profile: "ci",
        file: "custom.md",
      }),
    /cannot specify both '--profile' and '--file'/i
  );

  // Builtin fallback when no files exist
  const builtin = resolveProfileTask({ workspaceDir: sb.workspace, homeDir: sb.home });
  assert.equal(builtin.source, "builtin");
  assert.equal(builtin.prompt, BUILTIN_MAINTENANCE_PROMPT);

  // Global ~/.gemini/config/loops/ci.md vs workspace .agents/loops/ci.md precedence
  const globalLoopsDir = path.join(sb.home, ".gemini", "config", "loops");
  const wsLoopsDir = path.join(sb.workspace, ".agents", "loops");
  fs.mkdirSync(globalLoopsDir, { recursive: true });
  fs.mkdirSync(wsLoopsDir, { recursive: true });

  fs.writeFileSync(
    path.join(globalLoopsDir, "ci.md"),
    "---\ninterval: 5m\nmax_iterations: 8\n---\nGlobal CI body\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(globalLoopsDir, "global-only.md"),
    "---\nworker_model: flash\n---\nGlobal only body\n",
    "utf8"
  );

  const fromGlobal = resolveProfileTask({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    profile: "ci",
  });
  assert.equal(fromGlobal.scope, "global");
  assert.equal(fromGlobal.source, "~/.gemini/config/loops/ci.md");
  assert.match(fromGlobal.prompt, /Global CI body/);

  // Workspace overrides global
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    [
      "---",
      "interval: 30s",
      "max_iterations: 7",
      "state_mode: stateful",
      "reset_every: 3",
      "worker_model: gemini-4-hydrogen-xhigh",
      "verify: true",
      "verifier_model: gemini-4-neon-xhigh",
      "worktree: true",
      "budget_tokens: 40000",
      "max_duration: 15m",
      "targets: [api, web]",
      "singleton: workspace",
      "---",
      "Workspace CI body",
    ].join("\n"),
    "utf8"
  );
  // Seed an invalid profile to verify listProfiles reports ok: false cleanly
  fs.writeFileSync(path.join(wsLoopsDir, "broken.md"), "---\nunknown_key: 1\n---\nOops\n", "utf8");
  fs.writeFileSync(path.join(sb.workspace, ".agents", "loop.md"), "Default agents loop\n", "utf8");

  const fromWs = resolveProfileTask({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    profile: "ci",
  });
  assert.equal(fromWs.scope, "workspace");
  assert.equal(fromWs.source, ".agents/loops/ci.md");
  assert.equal(fromWs.profileName, "ci");
  assert.match(fromWs.prompt, /Workspace CI body/);

  // Missing profile lists available profiles
  assert.throws(
    () =>
      resolveProfileTask({
        workspaceDir: sb.workspace,
        homeDir: sb.home,
        profile: "nonexistent",
      }),
    /Discovered profiles:.*ci \(workspace\).*global-only \(global\)/
  );

  // listProfiles enumerates default + workspace + global including invalid
  const listed = listProfiles(sb.workspace, sb.home);
  assert.equal(listed.some((p) => p.isDefault && p.source === ".agents/loop.md" && p.ok), true);
  assert.equal(listed.some((p) => p.name === "ci" && p.scope === "workspace" && p.ok), true);
  assert.equal(listed.some((p) => p.name === "broken" && p.ok === false && p.error), true);
  assert.equal(listed.some((p) => p.name === "global-only" && p.scope === "global" && p.ok), true);

  // Merge: frontmatter applies when CLI omits explicit flags; CLI wins when explicitFlags set
  const defaultCliBase = {
    pacing: "dynamic",
    once: false,
    intervalSec: null,
    intervalLabel: null,
    maxIterations: 20,
    stateMode: "fresh",
    resetEvery: null,
    maxDurationSec: null,
    maxTokens: null,
    maxRetries: 3,
    maxErrors: 3,
    model: null,
    effort: null,
    fallbackModel: null,
    verifierModel: null,
    mode: null,
    sandbox: false,
    worktree: false,
    keepWorktree: false,
    workspace: "inherit",
    turnTimeoutSec: 600,
    failOnDenied: false,
    verifyCmd: null,
    verifyTimeoutSec: 60,
    probeCmd: null,
    probeTimeoutSec: 60,
    probeUntilPass: false,
    targets: [],
    profile: "ci",
    singleton: null,
    trustProfileCommands: false,
  };

  const mergedDefaults = mergeProfileWithCli(defaultCliBase, fromWs, {
    explicitFlags: new Set(["profile"]),
  });
  assert.equal(mergedDefaults.ok, true);
  assert.equal(mergedDefaults.pacing, "fixed");
  assert.equal(mergedDefaults.intervalSec, 30);
  assert.equal(mergedDefaults.maxIterations, 7);
  assert.equal(mergedDefaults.stateMode, "stateful");
  assert.equal(mergedDefaults.resetEvery, 3);
  assert.equal(mergedDefaults.model, "gemini-4-hydrogen-xhigh");
  assert.equal(mergedDefaults.verifierModel, "gemini-4-neon-xhigh");
  assert.equal(mergedDefaults.worktree, true);
  assert.equal(mergedDefaults.workspace, "branch");
  assert.equal(mergedDefaults.maxTokens, 40000);
  assert.equal(mergedDefaults.maxDurationSec, 900);
  assert.deepEqual(mergedDefaults.targets, ["api", "web"]);
  assert.equal(mergedDefaults.singleton, "workspace");

  // CLI override precedence
  const mergedCliWins = mergeProfileWithCli(
    {
      ...defaultCliBase,
      maxIterations: 3,
      model: "gemini-4-carbon-low",
      singleton: "none",
      intervalSec: 120,
      intervalLabel: "2m",
      pacing: "fixed",
    },
    fromWs,
    { explicitFlags: new Set(["profile", "maxIterations", "model", "singleton", "interval"]) }
  );
  assert.equal(mergedCliWins.ok, true);
  assert.equal(mergedCliWins.maxIterations, 3);
  assert.equal(mergedCliWins.model, "gemini-4-carbon-low");
  assert.equal(mergedCliWins.singleton, "none");
  assert.equal(mergedCliWins.intervalSec, 120);

  // Security red line: untrusted frontmatter probe_cmd / verify_cmd blocked without --trust-profile-commands
  fs.writeFileSync(
    path.join(wsLoopsDir, "cmds.md"),
    '---\nprobe_cmd: "echo PROBE_UNTRUSTED"\nverify_cmd: "echo VERIFY_UNTRUSTED"\n---\nCmd profile\n',
    "utf8"
  );
  const cmdProfile = resolveProfileTask({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    profile: "cmds",
  });

  const blocked = mergeProfileWithCli(defaultCliBase, cmdProfile, {
    explicitFlags: new Set(["profile"]),
    trustProfileCommands: false,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.error, /--trust-profile-commands/);
  assert.match(blocked.error, /probe_cmd/);
  assert.match(blocked.error, /verify_cmd/);

  // Allowed when trustProfileCommands: true
  const trusted = mergeProfileWithCli(defaultCliBase, cmdProfile, {
    explicitFlags: new Set(["profile"]),
    trustProfileCommands: true,
  });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.probeCmd, "echo PROBE_UNTRUSTED");
  assert.equal(trusted.verifyCmd, "echo VERIFY_UNTRUSTED");

  // Allowed without --trust-profile-commands when CLI explicitly overrides both
  const cliOverrideCmds = mergeProfileWithCli(
    { ...defaultCliBase, probeCmd: "true", verifyCmd: "true" },
    cmdProfile,
    {
      explicitFlags: new Set(["profile", "probeCmd", "verifyCmd"]),
      trustProfileCommands: false,
    }
  );
  assert.equal(cliOverrideCmds.ok, true);
  assert.equal(cliOverrideCmds.probeCmd, "true");
  assert.equal(cliOverrideCmds.verifyCmd, "true");
});

// ============================================================================
// 2. lib/lease-lock.mjs
// ============================================================================

test("v2 unit: lib/lease-lock.mjs Gate 1 O_EXCL concurrency across 6 child processes, heartbeat & ownership checks", async (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });

  assert.equal(computeLockScope({ singleton: "none", workspaceDir: sb.workspace }), null);
  const wsScope = computeLockScope({ singleton: "workspace", workspaceDir: sb.workspace });
  assert.match(wsScope, /^ws_[0-9a-f]{16}$/);
  const ciScope = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "ci",
  });
  const tddScope = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "tdd",
  });
  assert.match(ciScope, /^pf_[0-9a-f]{16}$/);
  assert.notEqual(ciScope, tddScope);

  // Barrier-synchronized concurrent child processes racing on Gate 1 O_EXCL
  const goFile = path.join(sb.root, "race-go.flag");
  const childScript = `
import fs from "node:fs";
import { acquireLeaseLock, releaseLeaseLock } from ${JSON.stringify(LEASE_LOCK_MODULE_URL)};

const [stateRoot, ws, scopeKey, loopId, goFile] = process.argv.slice(1);
process.stdout.write("READY\\n");
while (!fs.existsSync(goFile)) {
  await new Promise((r) => setTimeout(r, 5));
}
const res = await acquireLeaseLock({
  stateRoot,
  scope: "profile",
  scopeKey,
  loopId,
  pid: process.pid,
  profileName: "ci",
  workspaceDir: ws,
  leaseTtlMs: 30000,
  onConflict: "fail",
});
process.stdout.write(JSON.stringify({
  acquired: res.acquired,
  action: res.action,
  pid: process.pid,
  holderPid: res.holder?.pid ?? null,
}) + "\\n");
if (res.acquired) {
  await new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("end", resolve);
    setTimeout(resolve, 5000).unref();
  });
  releaseLeaseLock(res.handle);
}
`;

  const workerCount = 6;
  const children = [];
  const readyPromises = [];

  for (let i = 0; i < workerCount; i += 1) {
    const loopId = `lp_20261123T00000${i}Z_000${i}`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", childScript, sb.stateDir, sb.workspace, ciScope, loopId, goFile],
      { cwd: sb.workspace, env: sb.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    t.after(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore cleanup errors
      }
    });

    let stdout = "";
    let stderr = "";
    let resolveReady;
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    readyPromises.push(readyPromise);

    let resolveResult;
    const resultPromise = new Promise((resolve) => {
      resolveResult = resolve;
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.includes("READY")) {
        resolveReady();
      }
      for (const line of lines) {
        if (line.startsWith("{")) {
          resolveResult(JSON.parse(line));
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const exitPromise = new Promise((resolve) => {
      child.on("close", (status) => resolve({ status, stderr }));
    });
    children.push({ child, resultPromise, exitPromise });
  }

  await Promise.all(readyPromises);
  fs.writeFileSync(goFile, "go\n", "utf8");

  const results = await Promise.all(children.map((c) => c.resultPromise));
  const winners = results.filter((r) => r.acquired === true);
  const losers = results.filter((r) => r.acquired === false);
  assert.equal(winners.length, 1, `Expected exactly 1 O_EXCL winner, got ${JSON.stringify(results)}`);
  assert.equal(losers.length, workerCount - 1);
  for (const loser of losers) {
    assert.equal(loser.action, "conflict");
    assert.equal(loser.holderPid, winners[0].pid);
  }

  // Tell winner to release lock and exit
  for (const c of children) {
    c.child.stdin.end();
  }
  const exits = await Promise.all(children.map((c) => c.exitPromise));
  for (const ex of exits) {
    assert.equal(ex.status, 0, ex.stderr);
  }
  assert.equal(fs.existsSync(getLeaseLockPath(sb.stateDir, ciScope)), false);

  // Heartbeat refresh & ownership enforcement
  const owner = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey: ciScope,
    loopId: "lp_20261123T000100Z_own1",
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    leaseTtlMs: 120,
  });
  assert.equal(owner.acquired, true);
  const lockPath = owner.lockPath;
  const beforeHb = JSON.parse(fs.readFileSync(lockPath, "utf8")).heartbeat_at;

  // Mismatched loopId or pid cannot refresh, drain, or release
  assert.equal(
    refreshLeaseHeartbeat({ ...owner.handle, loopId: "lp_20261123T000100Z_fake" }),
    false
  );
  assert.equal(refreshLeaseHeartbeat({ ...owner.handle, pid: process.pid + 1 }), false);
  assert.equal(releaseLeaseLock({ ...owner.handle, loopId: "lp_20261123T000100Z_fake" }), false);
  assert.equal(fs.existsSync(lockPath), true);

  const stopHb = startLeaseHeartbeat(owner.handle);
  await new Promise((r) => setTimeout(r, 95));
  stopHb();
  const afterHb = JSON.parse(fs.readFileSync(lockPath, "utf8")).heartbeat_at;
  assert.ok(Date.parse(afterHb) >= Date.parse(beforeHb));
  assert.equal(releaseLeaseLock(owner.handle), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("v2 unit: lib/lease-lock.mjs Gate 2 reclaim (dead PID, expired TTL, corrupt), Gate 3 (wake/skip/fail), Gate 4 draining & listLeaseLocks", async (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });
  const scopeKey = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "ci",
  });
  const lockPath = getLeaseLockPath(sb.stateDir, scopeKey);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // Gate 2a: Dead PID with fresh timestamp -> reclaimed
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      scope: "profile",
      scope_key: scopeKey,
      loop_id: "lp_20261123T000201Z_dead",
      pid: 99999999,
      engine: "headless",
      profile: "ci",
      workspace_dir: sb.workspace,
      acquired_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      lease_ttl_ms: 60000,
      draining: false,
    }),
    "utf8"
  );
  const recDead = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000202Z_new1",
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
  });
  assert.equal(recDead.acquired, true);
  assert.equal(releaseLeaseLock(recDead.handle), true);

  // Gate 2b: Live PID with expired heartbeat TTL -> reclaimed
  const oldIso = new Date(Date.now() - 120000).toISOString();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      scope: "profile",
      scope_key: scopeKey,
      loop_id: "lp_20261123T000203Z_exp1",
      pid: process.pid,
      engine: "headless",
      profile: "ci",
      workspace_dir: sb.workspace,
      acquired_at: oldIso,
      heartbeat_at: oldIso,
      lease_ttl_ms: 5000,
      draining: false,
    }),
    "utf8"
  );
  const recTtl = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000204Z_new2",
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
  });
  assert.equal(recTtl.acquired, true);
  assert.equal(releaseLeaseLock(recTtl.handle), true);

  // Gate 2c: Corrupt lock aged past 2s -> reclaimed
  fs.writeFileSync(lockPath, "{corrupt-lock-json", "utf8");
  const pastSec = (Date.now() - 5000) / 1000;
  fs.utimesSync(lockPath, pastSec, pastSec);
  const recCorrupt = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000205Z_new3",
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
  });
  assert.equal(recCorrupt.acquired, true);
  assert.equal(releaseLeaseLock(recCorrupt.handle), true);

  // Gate 3: Live holder conflicts (wake, skip, fail)
  const holderState = createLoopState(sb.stateDir, {
    loop_id: "lp_20261123T000206Z_hold",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: process.pid,
  });
  const holder = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: holderState.loop_id,
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    leaseTtlMs: 60000,
  });
  assert.equal(holder.acquired, true);

  const failRes = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000207Z_cnt1",
    pid: process.pid + 100,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
  });
  assert.equal(failRes.acquired, false);
  assert.equal(failRes.action, "conflict");
  assert.equal(failRes.holder.loop_id, holderState.loop_id);

  const skipRes = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000208Z_cnt2",
    pid: process.pid + 101,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "skip",
  });
  assert.equal(skipRes.acquired, false);
  assert.equal(skipRes.action, "skipped");
  assert.equal(peekInboxFlags(sb.stateDir, holderState.loop_id).wake, false);

  const wakeRes = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000209Z_cnt3",
    pid: process.pid + 102,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "wake",
  });
  assert.equal(wakeRes.acquired, false);
  assert.equal(wakeRes.action, "coalesced");
  const inboxFiles = fs
    .readdirSync(path.join(sb.stateDir, "loops", holderState.loop_id, "inbox"))
    .filter((f) => f.endsWith(".json"));
  assert.equal(inboxFiles.length, 1);
  const wakeMsg = JSON.parse(
    fs.readFileSync(
      path.join(sb.stateDir, "loops", holderState.loop_id, "inbox", inboxFiles[0]),
      "utf8"
    )
  );
  assert.equal(wakeMsg.type, "wake");
  assert.equal(wakeMsg.reason, "singleton_coalesced");
  assert.equal(wakeMsg.source_pid, process.pid + 102);

  // Gate 4: markLeaseDraining -> contender waits -> holder releases -> contender acquires
  assert.equal(markLeaseDraining(holder.handle), true);
  const locksWhileDraining = listLeaseLocks(sb.stateDir);
  assert.equal(locksWhileDraining.length, 1);
  assert.equal(locksWhileDraining[0].alive, true);
  assert.equal(locksWhileDraining[0].draining, true);

  setTimeout(() => {
    releaseLeaseLock(holder.handle);
  }, 150);

  const handoffRes = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T000210Z_cnt4",
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
    drainWaitMs: 2000,
  });
  assert.equal(handoffRes.acquired, true);
  assert.equal(handoffRes.action, "acquired");

  // listLeaseLocks also includes stale/corrupt locks safely
  const stalePath = getLeaseLockPath(sb.stateDir, "ws_0000000000000001");
  fs.writeFileSync(stalePath, "{bad", "utf8");
  const allLocks = listLeaseLocks(sb.stateDir);
  assert.equal(allLocks.length, 2);
  assert.equal(allLocks.some((l) => l.scope_key === scopeKey && l.alive && !l.stale), true);
  assert.equal(
    allLocks.some((l) => l.scope_key === "ws_0000000000000001" && l.corrupt && l.stale),
    true
  );

  assert.equal(releaseLeaseLock(handoffRes.handle), true);
});

// ============================================================================
// 3. lib/daemon.mjs + CLI daemon / profiles / status / validate --remote
// ============================================================================

test("v2 unit: lib/daemon.mjs Sidecar schema, wildcard grant rejection, user_config isolation, and unrelated sidecar protection", (t) => {
  const sb = makeV2Sandbox(t);

  // Persistent workspace validation rejects /tmp without allowTempWorkspace
  assert.throws(
    () => validatePersistentWorkspace(sb.workspace),
    /Refusing to register persistent daemon for ephemeral workspace/
  );
  assert.equal(
    validatePersistentWorkspace(sb.workspace, { allowTempWorkspace: true }),
    fs.realpathSync(sb.workspace)
  );

  // intervalToCron
  assert.equal(intervalToCron(60), "* * * * *");
  assert.equal(intervalToCron(900), "*/15 * * * *");
  assert.equal(intervalToCron(3600), "0 * * * *");
  assert.equal(intervalToCron(7200), "0 */2 * * *");
  assert.equal(intervalToCron(86400), "0 0 * * *");
  assert.throws(() => intervalToCron(45), /minimum cron resolution/);
  assert.throws(() => intervalToCron(420), /does not divide 60m evenly/);

  // Wildcard grant rejection (every forbidden variant)
  const forbiddenGrants = [
    "command(*)",
    "read_file(*)",
    "read_file(/)",
    "write_file(*)",
    "mcp(*)",
    "read_url(*)",
    "execute_url(*)",
    "allow(*)",
    "command(git /*)",
    "read_file(/*)",
  ];
  for (const grant of forbiddenGrants) {
    assert.throws(
      () => validateSidecarGrants([grant]),
      /Rejected|Disallowed|disallowed|wildcard/i,
      `Expected grant '${grant}' to be rejected`
    );
  }
  assert.deepEqual(
    validateSidecarGrants(["command(npm test)", "read_file(./src)", "write_file(./out)"]),
    ["command(npm test)", "read_file(./src)", "write_file(./out)"]
  );

  // Seed user_config.json, config.json, and an unrelated user sidecar to prove agy-loop never modifies them
  const geminiCfgDir = path.join(sb.home, ".gemini", "config");
  const userConfigPath = path.join(geminiCfgDir, "user_config.json");
  const configJsonPath = path.join(geminiCfgDir, "config.json");
  const unrelatedSidecarPath = path.join(geminiCfgDir, "sidecars", "my-custom-sidecar", "sidecar.json");
  fs.mkdirSync(path.dirname(unrelatedSidecarPath), { recursive: true });
  const sentinelUserCfg = '{"sidecars":{"enabled":false},"keep":"untouched"}\n';
  const sentinelCfg = '{"theme":"sentinel"}\n';
  const sentinelSidecar = '{"builtin":"schedule","args":["0 8 * * *","agentapi"]}\n';
  fs.writeFileSync(userConfigPath, sentinelUserCfg, "utf8");
  fs.writeFileSync(configJsonPath, sentinelCfg, "utf8");
  fs.writeFileSync(unrelatedSidecarPath, sentinelSidecar, "utf8");

  // Seed named profile
  const loopsDir = path.join(sb.workspace, ".agents", "loops");
  fs.mkdirSync(loopsDir, { recursive: true });
  fs.writeFileSync(
    path.join(loopsDir, "nightly.md"),
    [
      "---",
      "name: nightly",
      'description: "Nightly test audit"',
      'cron: "0 2 * * *"',
      "timezone: Asia/Shanghai",
      "worker_model: gemini-4-carbon-low",
      "access_grants:",
      '  - "command(npm test)"',
      '  - "read_file(./)"',
      "---",
      "Run nightly audit and report issues.",
    ].join("\n"),
    "utf8"
  );

  // Dry-run does not write sidecar.json or daemons.json
  const dryRes = installSidecarDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    profile: "nightly",
    allowTempWorkspace: true,
    dryRun: true,
  });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.dryRun, true);
  assert.equal(fs.existsSync(dryRes.configPath), false);
  assert.equal(readDaemonRegistry({ homeDir: sb.home, env: sb.env }).length, 0);

  // Real sidecar install
  const instRes = installSidecarDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    profile: "nightly",
    allowTempWorkspace: true,
  });
  assert.equal(instRes.ok, true);
  assert.equal(instRes.dryRun, false);
  assert.equal(fs.existsSync(instRes.configPath), true);

  const written = JSON.parse(fs.readFileSync(instRes.configPath, "utf8"));
  assert.equal(written.builtin, "schedule");
  assert.equal(written.restart_policy, "always");
  assert.equal(written.args[0], "CRON_TZ=Asia/Shanghai 0 2 * * *");
  assert.equal(written.args[1], "agentapi");
  assert.equal(written.args[2], "new-conversation");
  assert.ok(written.args.includes("--model=gemini-4-carbon-low"));
  assert.ok(written.args.some((a) => a.startsWith("--title=")));
  const sepIdx = written.args.indexOf("--");
  assert.ok(sepIdx >= 3);
  assert.equal(written.args[sepIdx + 1], "Run nightly audit and report issues.");
  assert.deepEqual(written.agent_permissions.workspace_uris, [
    pathToFileURL(fs.realpathSync(sb.workspace)).href,
  ]);
  assert.deepEqual(written.agent_permissions.access_grants, [
    "command(npm test)",
    "read_file(./)",
  ]);

  // Verify user_config.json and config.json were never touched
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), sentinelUserCfg);
  assert.equal(fs.readFileSync(configJsonPath, "utf8"), sentinelCfg);

  // Build sidecar config with explicit grants validation failure
  assert.throws(
    () =>
      buildSidecarConfig({
        workspaceDir: sb.workspace,
        profileResult: { prompt: "hi", frontmatter: {} },
        cronExpr: "0 9 * * *",
        timezone: "UTC",
        accessGrants: ["command(*)"],
      }),
    /Rejected wildcard/
  );

  // removeDaemon refuses non-agy-loop-* slug and leaves unrelated sidecar untouched on remove --all
  assert.throws(
    () => removeDaemon({ slug: "my-custom-sidecar", homeDir: sb.home, env: sb.env }),
    /only manages 'agy-loop-\*' artifacts/
  );
  const rmAll = removeDaemon({ all: true, homeDir: sb.home, env: sb.env });
  assert.equal(rmAll.removed.length, 1);
  assert.equal(rmAll.removed[0].slug, instRes.slug);
  assert.equal(fs.existsSync(instRes.configPath), false);
  assert.equal(fs.readFileSync(unrelatedSidecarPath, "utf8"), sentinelSidecar);
  assert.equal(fs.readFileSync(userConfigPath, "utf8"), sentinelUserCfg);
  assert.equal(fs.readFileSync(configJsonPath, "utf8"), sentinelCfg);
});

test("v2 unit: lib/daemon.mjs LaunchAgent .plist (XML escaping, plutil -lint) & Linux systemd units with mock execFn", (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });

  // Workspace path containing XML special characters & < > " '
  const xmlWs = path.join(sb.root, `ws & <"test">'`);
  fs.mkdirSync(path.join(xmlWs, ".agents", "loops"), { recursive: true });
  fs.writeFileSync(
    path.join(xmlWs, ".agents", "loops", "ci.md"),
    "---\ninterval: 5m\n---\nCheck XML escaping.\n",
    "utf8"
  );

  const slug = computeDaemonSlug(xmlWs, "ci");
  assert.match(slug, /^agy-loop-/);

  // 1a. macOS LaunchAgent StartInterval + XML escaping + --no-load
  const execCallsDarwin = [];
  const mockExecDarwin = (cmd, args) => {
    execCallsDarwin.push({ cmd, args });
    return { status: 0, stdout: "", stderr: "", error: null };
  };

  const darwinInterval = installOsDaemon({
    workspaceDir: xmlWs,
    homeDir: sb.home,
    env: sb.env,
    platform: "darwin",
    profile: "ci",
    allowTempWorkspace: true,
    noLoad: true,
    execFn: mockExecDarwin,
  });
  assert.equal(darwinInterval.ok, true);
  assert.equal(darwinInterval.loaded, false);
  assert.equal(execCallsDarwin.length, 0, "--no-load must not invoke launchctl");
  assert.equal(fs.existsSync(darwinInterval.configPath), true);

  const plistIntervalText = fs.readFileSync(darwinInterval.configPath, "utf8");
  assert.match(plistIntervalText, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(plistIntervalText, /<string>--singleton<\/string>\s*<string>profile<\/string>/);
  assert.match(plistIntervalText, /<string>--on-conflict<\/string>\s*<string>wake<\/string>/);
  assert.match(plistIntervalText, /<string>--relay-on-wake<\/string>/);
  assert.match(plistIntervalText, /&amp; &lt;&quot;test&quot;&gt;&apos;/);

  if (process.platform === "darwin") {
    const lintRes = spawnSync("plutil", ["-lint", darwinInterval.configPath], { encoding: "utf8" });
    assert.equal(lintRes.status, 0, `plutil -lint failed: ${lintRes.stdout} ${lintRes.stderr}`);
  }

  // 1b. macOS LaunchAgent StartCalendarInterval (array & single dict) + loaded via mock launchctl
  const darwinCron = installOsDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    platform: "darwin",
    cronExpr: "0,30 9 * * mon-fri",
    profileResult: { profileName: "ci", path: null, prompt: "Check", frontmatter: {} },
    allowTempWorkspace: true,
    noLoad: false,
    execFn: mockExecDarwin,
  });
  assert.equal(darwinCron.loaded, true);
  assert.equal(execCallsDarwin.some((c) => c.cmd === "launchctl" && c.args[0] === "bootstrap"), true);

  const plistCronText = fs.readFileSync(darwinCron.configPath, "utf8");
  assert.match(plistCronText, /<key>StartCalendarInterval<\/key>\s*<array>/);
  if (process.platform === "darwin") {
    const lintCron = spawnSync("plutil", ["-lint", darwinCron.configPath], { encoding: "utf8" });
    assert.equal(lintCron.status, 0, `plutil -lint failed: ${lintCron.stdout} ${lintCron.stderr}`);
  }

  // Single-dict StartCalendarInterval check via buildLaunchAgentPlist
  const singleDictPlist = buildLaunchAgentPlist({
    slug: "agy-loop-single-1234",
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    cronExpr: "15 8 * * 1",
  });
  assert.match(singleDictPlist.plistContent, /<key>StartCalendarInterval<\/key>\s*<dict>/);
  if (process.platform === "darwin") {
    const tmpPlist = path.join(sb.root, "single.plist");
    fs.writeFileSync(tmpPlist, singleDictPlist.plistContent, "utf8");
    const lintSingle = spawnSync("plutil", ["-lint", tmpPlist], { encoding: "utf8" });
    assert.equal(lintSingle.status, 0, `plutil -lint failed: ${lintSingle.stdout} ${lintSingle.stderr}`);
  }

  // 2. Linux systemd --user (.service + .timer)
  const execCallsLinux = [];
  const mockExecLinux = (cmd, args) => {
    execCallsLinux.push({ cmd, args });
    return { status: 0, stdout: "active\n", stderr: "", error: null };
  };

  const linuxCron = installOsDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    platform: "linux",
    cronExpr: "30 9 * * mon-fri",
    timezone: "UTC",
    profileResult: { profileName: "linux-ci", path: null, prompt: "Linux check", frontmatter: {} },
    allowTempWorkspace: true,
    noLoad: false,
    execFn: mockExecLinux,
  });
  assert.equal(linuxCron.ok, true);
  assert.equal(linuxCron.platform, "linux");
  assert.equal(linuxCron.loaded, true);
  assert.equal(linuxCron.artifactPaths.length, 2);
  const [servicePath, timerPath] = linuxCron.artifactPaths;
  assert.equal(fs.existsSync(servicePath), true);
  assert.equal(fs.existsSync(timerPath), true);

  const serviceText = fs.readFileSync(servicePath, "utf8");
  const timerText = fs.readFileSync(timerPath, "utf8");
  assert.match(serviceText, /Type=oneshot/);
  assert.match(serviceText, /--singleton.*profile.*--on-conflict.*wake.*--relay-on-wake/);
  assert.match(timerText, /OnCalendar=Mon\.\.Fri \*-\*-\* 09:30:00 UTC/);
  assert.match(timerText, /Persistent=true/);
  assert.equal(
    execCallsLinux.some(
      (c) => c.cmd === "systemctl" && c.args.join(" ") === "--user daemon-reload"
    ),
    true
  );
  assert.equal(
    execCallsLinux.some(
      (c) => c.cmd === "systemctl" && c.args[1] === "enable" && c.args[2] === "--now"
    ),
    true
  );

  // Interval systemd timer via buildSystemdUnits
  const linuxIntervalUnits = buildSystemdUnits({
    slug: "agy-loop-int-abcd",
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    intervalSec: 90,
  });
  assert.match(linuxIntervalUnits.timerContent, /OnUnitActiveSec=90s/);
  assert.match(linuxIntervalUnits.timerContent, /Persistent=true/);

  // listDaemons with checkStatus & execFn
  const listed = listDaemons({
    global: true,
    homeDir: sb.home,
    env: sb.env,
    platform: "linux",
    checkStatus: true,
    execFn: mockExecLinux,
  });
  const linuxListed = listed.find((d) => d.slug === linuxCron.slug && d.platform === "linux");
  assert.ok(linuxListed);
  assert.equal(linuxListed.installed, true);
  assert.equal(linuxListed.loaded, true);

  // readDaemonLogs for OS daemon
  fs.mkdirSync(path.dirname(linuxCron.logPath), { recursive: true });
  fs.writeFileSync(linuxCron.logPath, "line1\nline2\nline3\n", "utf8");
  const logs = readDaemonLogs({
    slug: linuxCron.slug,
    tail: 2,
    homeDir: sb.home,
    env: sb.env,
  });
  assert.equal(logs.exists, true);
  assert.deepEqual(logs.lines, ["line2", "line3"]);

  // removeDaemon on Linux unloads via systemctl and deletes files
  const rmLinux = removeDaemon({
    slug: linuxCron.slug,
    homeDir: sb.home,
    env: sb.env,
    platform: "linux",
    execFn: mockExecLinux,
  });
  assert.equal(rmLinux.removed.length, 1);
  assert.equal(fs.existsSync(servicePath), false);
  assert.equal(fs.existsSync(timerPath), false);
  assert.equal(
    execCallsLinux.some((c) => c.cmd === "systemctl" && c.args[1] === "disable"),
    true
  );

  // detectHostTimezone returns valid IANA zone
  const tz = detectHostTimezone();
  assert.equal(validateIanaTimezone(tz), tz);
  assert.equal(fs.existsSync(resolveDaemonRegistryPath(sb.home, sb.env)), true);
});

test("v2 cli e2e: profiles, daemon (install/list/status/logs/remove/--test-run), status --json/--clean-shadow, and validate --remote", (t) => {
  const sb = makeV2Sandbox(t);

  // Seed profiles
  const wsLoopsDir = path.join(sb.workspace, ".agents", "loops");
  const globalLoopsDir = path.join(sb.home, ".gemini", "config", "loops");
  fs.mkdirSync(wsLoopsDir, { recursive: true });
  fs.mkdirSync(globalLoopsDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    [
      "---",
      "name: ci",
      'cron: "*/30 * * * *"',
      "timezone: UTC",
      "worker_model: gemini-4-carbon-low",
      "---",
      "Check CI status.",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(wsLoopsDir, "untrusted.md"),
    '---\ninterval: 5m\nprobe_cmd: "echo should_block"\n---\nUntrusted profile\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(globalLoopsDir, "audit.md"),
    "---\nworker_model: gemini-4-neon-xhigh\n---\nGlobal audit.\n",
    "utf8"
  );

  // 1. agy-loop profiles --json
  const profilesRes = sb.runCli(["profiles", "--json"]);
  assert.equal(profilesRes.status, 0, profilesRes.stderr);
  const profilesJson = JSON.parse(profilesRes.stdout);
  assert.equal(profilesJson.ok, true);
  assert.equal(profilesJson.profiles.some((p) => p.name === "ci" && p.ok), true);
  assert.equal(profilesJson.profiles.some((p) => p.name === "audit" && p.scope === "global"), true);

  // 2. Ephemeral /tmp rejected without --allow-temp-workspace
  const rejectTmp = sb.runCli([
    "daemon",
    "install",
    "--profile",
    "ci",
    "--mode",
    "sidecar",
    "--json",
  ]);
  assert.equal(rejectTmp.status, 2);
  assert.match(JSON.parse(rejectTmp.stdout).error, /--allow-temp-workspace/);

  // 3. Untrusted frontmatter probe_cmd blocked on --mode os without --trust-profile-commands
  const rejectUntrustedOs = sb.runCli([
    "daemon",
    "install",
    "--profile",
    "untrusted",
    "--mode",
    "os",
    "--no-load",
    "--allow-temp-workspace",
    "--json",
  ]);
  assert.equal(rejectUntrustedOs.status, 2);
  assert.match(JSON.parse(rejectUntrustedOs.stdout).error, /--trust-profile-commands/);

  // 4. Wildcard --grant rejected
  const rejectWildcard = sb.runCli([
    "daemon",
    "install",
    "--profile",
    "ci",
    "--mode",
    "sidecar",
    "--grant",
    "command(*)",
    "--allow-temp-workspace",
    "--json",
  ]);
  assert.equal(rejectWildcard.status, 2);
  assert.match(JSON.parse(rejectWildcard.stdout).error, /Rejected wildcard/);

  // 5. Sidecar install with --test-run discovering denied_actions[] and grant suggestions
  sb.setScenario({
    jsonEnvelope: {
      status: "SUCCESS",
      conversation_id: "conv-test-run",
      usage: { total_tokens: 50 },
      denied_actions: [
        { tool_name: "run_command", command: "npm test" },
        { tool_name: "write_to_file", file_path: "./coverage/summary.json" },
      ],
      structured_output: {
        iteration: 1,
        loop_status: "DONE",
        next_delay_sec: 0,
        summary: "Test run complete",
        next_hint: "None",
      },
    },
  });
  const sidecarRes = sb.runCli([
    "daemon",
    "install",
    "--profile",
    "ci",
    "--mode",
    "sidecar",
    "--test-run",
    "--allow-temp-workspace",
    "--json",
  ]);
  assert.equal(sidecarRes.status, 0, sidecarRes.stderr);
  const sidecarJson = JSON.parse(sidecarRes.stdout);
  assert.equal(sidecarJson.ok, true);
  assert.equal(sidecarJson.mode, "sidecar");
  assert.equal(sidecarJson.config.builtin, "schedule");
  assert.equal(sidecarJson.testRun.deniedActionsCount, 2);
  assert.ok(sidecarJson.testRun.suggestedGrants.includes("command(npm test)"));
  assert.ok(sidecarJson.testRun.suggestedGrants.includes("write_file(./coverage/summary.json)"));

  // 6. OS daemon install (--no-load) with distinct profile + logs + list + status
  sb.setScenario({});
  const osRes = sb.runCli([
    "daemon",
    "install",
    "--profile",
    "untrusted",
    "--mode",
    "os",
    "--interval",
    "5m",
    "--trust-profile-commands",
    "--no-load",
    "--allow-temp-workspace",
    "--json",
  ]);
  assert.equal(osRes.status, 0, osRes.stderr);
  const osJson = JSON.parse(osRes.stdout);
  assert.equal(osJson.ok, true);
  assert.equal(osJson.mode, "os");
  assert.equal(osJson.loaded, false);
  assert.equal(fs.existsSync(osJson.configPath), true);

  fs.mkdirSync(path.dirname(osJson.logPath), { recursive: true });
  fs.writeFileSync(osJson.logPath, "boot ok\niter 1 ok\n", "utf8");

  const daemonListRes = sb.runCli(["daemon", "list", "--json"]);
  assert.equal(daemonListRes.status, 0, daemonListRes.stderr);
  const daemonList = JSON.parse(daemonListRes.stdout);
  assert.equal(daemonList.daemons.length, 2);

  const daemonStatusRes = sb.runCli(["daemon", "status", "--json"]);
  assert.equal(daemonStatusRes.status, 0, daemonStatusRes.stderr);
  const daemonStatus = JSON.parse(daemonStatusRes.stdout);
  assert.equal(daemonStatus.daemons.length, 2);

  const daemonLogsRes = sb.runCli(["daemon", "logs", osJson.slug, "--tail", "1", "--json"]);
  assert.equal(daemonLogsRes.status, 0, daemonLogsRes.stderr);
  assert.deepEqual(JSON.parse(daemonLogsRes.stdout).lines, ["iter 1 ok"]);

  const sidecarLogsRes = sb.runCli(["daemon", "logs", sidecarJson.slug, "--json"]);
  assert.equal(sidecarLogsRes.status, 0, sidecarLogsRes.stderr);
  assert.match(JSON.parse(sidecarLogsRes.stdout).message, /sidecar:\/\/dashboard/);

  // 7. status --json (Option A) + activeLocks + --clean-shadow
  const shadowSkill = path.join(sb.home, ".gemini", "config", "skills", "loop");
  fs.mkdirSync(shadowSkill, { recursive: true });
  fs.writeFileSync(path.join(shadowSkill, "SKILL.md"), "shadow\n", "utf8");

  const statusBadRes = sb.runCli(["status", "--json"]);
  assert.equal(statusBadRes.status, 0, statusBadRes.stderr);
  const statusBad = JSON.parse(statusBadRes.stdout);
  assert.equal(statusBad.ok, false);
  assert.equal(statusBad.health.ok, false);
  assert.equal(statusBad.health.shadowCount, 1);
  assert.equal(statusBad.daemons.length, 2);
  assert.equal(Array.isArray(statusBad.activeLoops), true);
  assert.equal(Array.isArray(statusBad.activeLocks), true);

  const statusCleanRes = sb.runCli(["status", "--clean-shadow", "--json"]);
  assert.equal(statusCleanRes.status, 0, statusCleanRes.stderr);
  const statusClean = JSON.parse(statusCleanRes.stdout);
  assert.equal(statusClean.ok, true);
  assert.equal(statusClean.health.ok, true);
  assert.equal(statusClean.health.shadowCount, 0);
  assert.ok(statusClean.backupDir && statusClean.cleanedShadows.length === 1);

  // Remove daemons via CLI
  const rmOs = sb.runCli(["daemon", "remove", osJson.slug, "--no-unload", "--json"]);
  assert.equal(rmOs.status, 0, rmOs.stderr);
  assert.equal(JSON.parse(rmOs.stdout).removed.length, 1);

  const rmSidecar = sb.runCli(["daemon", "remove", sidecarJson.slug, "--json"]);
  assert.equal(rmSidecar.status, 0, rmSidecar.stderr);
  assert.equal(JSON.parse(rmSidecar.stdout).removed.length, 1);
  assert.equal(JSON.parse(sb.runCli(["daemon", "list", "--json"]).stdout).daemons.length, 0);

  // 8. agy-loop validate --remote v2.0.0 & default ref (must pass tree/<ref> with no trailing '/.')
  const valRemote = sb.runCli(["validate", "--remote", "v2.0.0", "--json"]);
  assert.equal(valRemote.status, 0, valRemote.stderr);
  const valDefaultRemote = sb.runCli(["validate", "--remote", "--json"]);
  assert.equal(valDefaultRemote.status, 0, valDefaultRemote.stderr);

  const calls = sb.readAgyCalls().filter((c) => c.args[0] === "plugin" && c.args[1] === "validate");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.args, [
      "plugin",
      "validate",
      "--strict",
      "--json",
      "https://github.com/maxlee/agy-loop/tree/v2.0.0",
    ]);
    assert.equal(call.args[4].endsWith("/."), false);
  }

  // Invalid --remote ref fails Exit 2
  const badRemote = sb.runCli(["validate", "--remote", "../evil", "--json"]);
  assert.equal(badRemote.status, 2);
});

test("v2 regression #95: systemd escaping/injection, OnCalendar steps, slug traversal, installOsDaemon defaults, overrides & grants", (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });

  // 1. validateProfileName("a..b"), single-line frontmatter newlines, and validateSidecarGrants hardening
  assert.equal(validateProfileName("a..b"), false);
  assert.equal(validateProfileName("ok.name_1"), true);

  for (const badFm of [
    '---\nname: "a..b"\n---\nBody\n',
    '---\nname: "bad\\nname"\n---\nBody\n',
    '---\nworker_model: "gemini\\nExecStartPre=/bin/sh"\n---\nBody\n',
    '---\ncron: "0 9 * * *\\n#evil"\n---\nBody\n',
    '---\ntimezone: "UTC\\r\\nEvil"\n---\nBody\n',
  ]) {
    assert.throws(() => parseProfileDocument(badFm, { sourceLabel: "bad-fm.md" }));
  }

  for (const badGrant of [
    "read_file(///)",
    "read_file(/.)",
    "read_file(/..)",
    "read_file(/a/..)",
    "mcp(*:*)",
    "mcp(*/*)",
    "read_file(C:\\\\)",
    "read_file(C:/)",
    "read_file(src\nevil)",
    "read_file(src\0evil)",
  ]) {
    assert.throws(
      () => validateSidecarGrants([badGrant]),
      /Unsupported|wildcard|root|Invalid/i,
      `Expected validateSidecarGrants to reject ${JSON.stringify(badGrant)}`
    );
  }

  // 2. mergeProfileWithCli CLI override precedence (--once vs max_iterations, --max vs once, --fresh vs reset_every)
  const fmManyIters = parseProfileDocument(
    "---\nmax_iterations: 15\n---\nMany iterations\n",
    { sourceLabel: "ci.md" }
  );
  const fmOnceOnly = parseProfileDocument(
    "---\nonce: true\n---\nOnce only\n",
    { sourceLabel: "once.md" }
  );
  const fmStateful = parseProfileDocument(
    "---\nstate_mode: stateful\nreset_every: 4\n---\nStateful profile\n",
    { sourceLabel: "stateful.md" }
  );
  const baseCli = {
    pacing: "dynamic",
    once: false,
    intervalSec: null,
    intervalLabel: null,
    maxIterations: 20,
    stateMode: "fresh",
    resetEvery: null,
    targets: [],
  };

  const onceOverridesFm = mergeProfileWithCli(
    { ...baseCli, once: true, maxIterations: 1 },
    { ...fmManyIters, frontmatter: fmManyIters.config, prompt: fmManyIters.body, profileName: "ci" },
    { explicitFlags: new Set(["once"]) }
  );
  assert.equal(onceOverridesFm.ok, true);
  assert.equal(onceOverridesFm.once, true);
  assert.equal(onceOverridesFm.maxIterations, 1);

  const maxOverridesFmOnce = mergeProfileWithCli(
    { ...baseCli, maxIterations: 5, once: false },
    { ...fmOnceOnly, frontmatter: fmOnceOnly.config, prompt: fmOnceOnly.body, profileName: "once" },
    { explicitFlags: new Set(["maxIterations"]) }
  );
  assert.equal(maxOverridesFmOnce.ok, true);
  assert.equal(maxOverridesFmOnce.once, false);
  assert.equal(maxOverridesFmOnce.maxIterations, 5);

  const freshIgnoresFmReset = mergeProfileWithCli(
    { ...baseCli, stateMode: "fresh" },
    { ...fmStateful, frontmatter: fmStateful.config, prompt: fmStateful.body, profileName: "stateful" },
    { explicitFlags: new Set(["stateMode"]) }
  );
  assert.equal(freshIgnoresFmReset.ok, true);
  assert.equal(freshIgnoresFmReset.stateMode, "fresh");
  assert.equal(freshIgnoresFmReset.resetEvery, null);

  // 3. Systemd directive injection & % / $ escaping + OnCalendar step expansion
  const specialWs = path.join(sb.root, "ws%unit$dir");
  fs.mkdirSync(specialWs, { recursive: true });
  const units = buildSystemdUnits({
    slug: "agy-loop-escape-test",
    workspaceDir: specialWs,
    homeDir: sb.home,
    env: { ...sb.env, PATH: `/opt/bin%test:${sb.env.PATH}` },
    profileName: "ci",
    model: "gemini-4%m",
    cronExpr: "*/15 * */2 */3 */2",
    timezone: "UTC",
    description: "Safe\n[Service]\nExecStartPre=/bin/sh -c id 100%",
    extraArgs: ["--label", "val%$HOME"],
  });

  // Flattened newline -> single [Service] header, no injected ExecStartPre= directive line
  assert.equal(units.serviceContent.match(/^\[Service\]$/gm)?.length, 1);
  assert.equal(/^ExecStartPre=/m.test(units.serviceContent), false);
  assert.match(units.serviceContent, /Description=Safe \[Service\] ExecStartPre=\/bin\/sh -c id 100%%/);
  assert.match(units.serviceContent, /WorkingDirectory=.*ws%%unit\$dir/);
  assert.match(units.serviceContent, /Environment="PATH=.*\/opt\/bin%%test/);
  assert.match(units.serviceContent, /gemini-4%%m/);
  assert.match(units.serviceContent, /val%%\$\$HOME/);

  // Reject newlines/NUL in ExecStart/WorkingDirectory fields
  assert.throws(
    () =>
      buildSystemdUnits({
        slug: "agy-loop-escape-test",
        workspaceDir: specialWs,
        homeDir: sb.home,
        env: sb.env,
        intervalSec: 60,
        model: "bad\nExecStartPre=/bin/sh",
      }),
    /newline and NUL/i
  );

  // OnCalendar DOM/month steps start at 01, weekday steps expand cleanly to named weekdays (never /step)
  assert.match(
    units.timerContent,
    /OnCalendar=Sun,Tue,Thu,Sat \*-01\/3-01\/2 \*:00\/15:00 UTC/
  );
  const dowCommaUnits = buildSystemdUnits({
    slug: "agy-loop-dow-test",
    workspaceDir: specialWs,
    homeDir: sb.home,
    env: sb.env,
    cronExpr: "0 9 * * 1,3,5",
  });
  assert.match(dowCommaUnits.timerContent, /OnCalendar=Mon,Wed,Fri \*-\*-\* 09:00:00/);

  // 4. Daemon slug validation & traversal rejection + poisoned registry isolation
  assert.equal(VALID_DAEMON_SLUG_RE.test("agy-loop-ci-01"), true);
  for (const badSlug of [
    "../../../secret",
    "agy-loop-../../escaped",
    "agy-loop-/../../agy-loop-victim",
    "not-agy-loop",
  ]) {
    assert.throws(() => validateDaemonSlug(badSlug), /Invalid daemon slug/);
    assert.throws(
      () => readDaemonLogs({ slug: badSlug, homeDir: sb.home, env: sb.env }),
      /Invalid daemon slug/
    );
    assert.throws(
      () =>
        installSidecarDaemon({
          slug: badSlug,
          workspaceDir: sb.workspace,
          homeDir: sb.home,
          env: sb.env,
          cron: "0 9 * * *",
          allowTempWorkspace: true,
        }),
      /Invalid daemon slug/
    );
    assert.throws(
      () =>
        installOsDaemon({
          slug: badSlug,
          workspaceDir: sb.workspace,
          homeDir: sb.home,
          env: sb.env,
          intervalSec: 60,
          platform: "darwin",
          noLoad: true,
          allowTempWorkspace: true,
        }),
      /Invalid daemon slug/
    );
    assert.throws(
      () => removeDaemon({ slug: badSlug, homeDir: sb.home, env: sb.env }),
      /only manages 'agy-loop-\*'|Invalid daemon slug/
    );
  }

  // Poisoned daemons.json entry must be skipped by listDaemons and rejected by removeDaemon without touching victim dir/file
  const victimDir = path.join(sb.home, ".gemini", "config", "sidecars", "agy-loop-victim");
  fs.mkdirSync(victimDir, { recursive: true });
  fs.writeFileSync(path.join(victimDir, "sidecar.json"), '{"keep":true}\n', "utf8");
  const outsideVictim = path.join(sb.home, ".gemini", "config", "victim.json");
  fs.writeFileSync(outsideVictim, '{"outside":true}\n', "utf8");
  const regPath = resolveDaemonRegistryPath(sb.home, sb.env);
  fs.mkdirSync(path.dirname(regPath), { recursive: true });
  fs.writeFileSync(
    regPath,
    JSON.stringify({
      version: 1,
      daemons: [
        {
          slug: "agy-loop-/../../agy-loop-victim",
          mode: "sidecar",
          platform: "sidecar",
          configPath: path.join(victimDir, "sidecar.json"),
        },
        {
          slug: "agy-loop-/../../victim",
          mode: "sidecar",
          platform: "sidecar",
          configPath: outsideVictim,
        },
      ],
    }),
    "utf8"
  );
  const listedPoisoned = listDaemons({ homeDir: sb.home, env: sb.env });
  assert.equal(listedPoisoned.some((d) => d.slug.includes("..") || d.slug.includes("/")), false);
  assert.throws(
    () => removeDaemon({ slug: "agy-loop-/../../agy-loop-victim", homeDir: sb.home, env: sb.env }),
    /Invalid daemon slug/
  );
  assert.equal(fs.existsSync(path.join(victimDir, "sidecar.json")), true);
  assert.equal(fs.existsSync(outsideVictim), true);

  // 5. installOsDaemon default .agents/loop.md `name: repo-default`, explicit intervalSec priority & programmatic trust check
  const defaultLoopDir = path.join(sb.workspace, ".agents");
  fs.mkdirSync(defaultLoopDir, { recursive: true });
  fs.writeFileSync(
    path.join(defaultLoopDir, "loop.md"),
    [
      "---",
      "name: repo-default",
      "cron: 0 9 * * *",
      "interval: 5m",
      'probe_cmd: "echo UNTRUSTED_DAEMON_CMD"',
      "---",
      "Default loop body",
    ].join("\n"),
    "utf8"
  );

  // Rejects untrusted frontmatter probe_cmd programmatically
  assert.throws(
    () =>
      installOsDaemon({
        workspaceDir: sb.workspace,
        homeDir: sb.home,
        env: sb.env,
        intervalSec: 120,
        platform: "darwin",
        noLoad: true,
        allowTempWorkspace: true,
      }),
    /--trust-profile-commands|trustProfileCommands/
  );

  // When trusted: does NOT pass `--profile repo-default` and lets explicit intervalSec=120 override fm.cron
  const osDefault = installOsDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    intervalSec: 120,
    trustProfileCommands: true,
    platform: "darwin",
    noLoad: true,
    dryRun: true,
    allowTempWorkspace: true,
  });
  const plistXml = osDefault.files[0].content;
  assert.match(plistXml, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.equal(plistXml.includes("StartCalendarInterval"), false);
  const progArgsMatch = plistXml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  assert.ok(progArgsMatch);
  assert.equal(progArgsMatch[1].includes("--profile"), false);
  assert.equal(progArgsMatch[1].includes("repo-default"), false);

  // installSidecarDaemon also prioritizes explicit intervalSec=120 over fm.cron="0 9 * * *"
  const scInterval = installSidecarDaemon({
    workspaceDir: sb.workspace,
    homeDir: sb.home,
    env: sb.env,
    intervalSec: 120,
    dryRun: true,
    allowTempWorkspace: true,
  });
  assert.match(scInterval.config.args[0], /^CRON_TZ=.* \*\/2 \* \* \* \*$/);
});

test("v2 regression #95: Gate 2 multi-process concurrent stale-lock reclaim race (0o600) & unmarkLeaseDraining", async (t) => {
  const sb = makeV2Sandbox(t, { withMockAgy: false });
  const scopeKey = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "race",
  });
  const lockPath = getLeaseLockPath(sb.stateDir, scopeKey);

  // Verify 0o600 + markLeaseDraining + unmarkLeaseDraining round-trip & ownership guard
  const own = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T005000Z_own1",
    pid: process.pid,
    profileName: "race",
    workspaceDir: sb.workspace,
  });
  assert.equal(own.acquired, true);
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  assert.equal(markLeaseDraining(own.handle), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).draining, true);
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  assert.equal(unmarkLeaseDraining({ ...own.handle, loopId: "lp_20261123T005000Z_fake" }), false);
  assert.equal(unmarkLeaseDraining({ ...own.handle, pid: process.pid + 1 }), false);
  assert.equal(unmarkLeaseDraining(own.handle), true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).draining, false);
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  assert.equal(releaseLeaseLock(own.handle), true);

  // Seed ONE dead-PID stale lock and race 6 concurrent child processes under Gate 2 reclaim guard
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      scope: "profile",
      scope_key: scopeKey,
      loop_id: "lp_20261123T005001Z_dead",
      pid: 99999999,
      engine: "headless",
      profile: "race",
      workspace_dir: sb.workspace,
      acquired_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      lease_ttl_ms: 60000,
      draining: false,
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  const workerSrc = `
    import fs from "node:fs";
    import { acquireLeaseLock, releaseLeaseLock } from ${JSON.stringify(LEASE_LOCK_MODULE_URL)};
    const idx = Number(process.argv[1]);
    const res = await acquireLeaseLock({
      stateRoot: ${JSON.stringify(sb.stateDir)},
      scope: "profile",
      scopeKey: ${JSON.stringify(scopeKey)},
      loopId: "lp_20261123T005002Z_r00" + idx,
      pid: process.pid,
      profileName: "race",
      workspaceDir: ${JSON.stringify(sb.workspace)},
      reclaimStaleAfterMs: 60000,
      onConflict: "fail",
    });
    if (res.acquired) {
      const mode = fs.statSync(res.lockPath).mode & 0o777;
      await new Promise((r) => setTimeout(r, 150));
      releaseLeaseLock(res.handle);
      process.stdout.write(JSON.stringify({ acquired: true, action: res.action, mode }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({ acquired: false, action: res.action }) + "\\n");
    }
  `;

  const racers = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", workerSrc, String(i)], {
        cwd: sb.workspace,
        env: sb.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString("utf8")));
      child.stderr.on("data", (d) => (err += d.toString("utf8")));
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Racer ${i} exited ${code}: ${err}`));
        else resolve(JSON.parse(out.trim()));
      });
    })
  );

  const results = await Promise.all(racers);
  const winners = results.filter((r) => r.acquired);
  const losers = results.filter((r) => !r.acquired);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].mode, 0o600);
  assert.equal(losers.length, 5);
  for (const l of losers) {
    assert.equal(l.action, "conflict");
  }
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(`${lockPath}.reclaim.lock`), false);
});

