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

const ALLOWED_PLUGIN_JSON_KEYS = new Set([
  "$schema",
  "name",
  "displayName",
  "version",
  "description",
  "logo",
  "suggestedPrompts",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "disabled",
]);

const VERIFIED_CORTEX_TOOLS = new Set([
  "view_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "list_dir",
  "find_by_name",
  "grep_search",
  "run_command",
  "manage_task",
  "schedule",
  "invoke_subagent",
  "send_message",
  "manage_subagents",
  "search_web",
  "read_url_content",
  "ask_question",
]);

const REQUIRED_LOOP_WORKER_TOOLS = [
  "view_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "list_dir",
  "find_by_name",
  "grep_search",
  "run_command",
  "manage_task",
];

function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-test-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const mockBin = path.join(root, "mock-bin");
  const logFile = path.join(root, "agy-calls.jsonl");
  const stateFile = path.join(root, "agy-installed.json");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(mockBin, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mockAgyPath = path.join(mockBin, "agy");
  const mockAgyScript = `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const logFile = process.env.MOCK_AGY_LOG;
const stateFile = process.env.MOCK_AGY_STATE;

if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ args, home: process.env.HOME }) + "\\n");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { installed: false, target: null };
  }
}

function writeState(next) {
  if (stateFile) {
    fs.writeFileSync(stateFile, JSON.stringify(next));
  }
}

if (args[0] === "--version") {
  process.stdout.write("1.5.9\\n");
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "install") {
  const target = args[2] || "";
  writeState({ installed: true, target });
  process.stdout.write(\`Installed plugin agy-loop from \${target}\\n\`);
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "uninstall") {
  writeState({ installed: false, target: null });
  process.stdout.write(\`Uninstalled plugin \${args[2] || ""}\\n\`);
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "list" && args.includes("--json")) {
  const state = readState();
  const list = state.installed
    ? [
        {
          name: "agy-loop",
          enabled: true,
          version: "1.0.0",
          source: "antigravity",
          path: \`\${process.env.HOME}/.gemini/config/plugins/agy-loop\`,
          skills: ["loop"],
        },
      ]
    : [];
  process.stdout.write(JSON.stringify(list, null, 2) + "\\n");
  process.exit(0);
}

if (args[0] === "plugin" && args[1] === "validate") {
  const targetDir = args[args.length - 1];
  const payload = {
    dir: targetDir,
    manifest: "plugin.json",
    name: "agy-loop",
    findings: [],
  };
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\\n");
  } else {
    process.stdout.write("Plugin validation passed (0 findings)\\n");
  }
  process.exit(0);
}

process.stderr.write(\`Unexpected mock agy args: \${args.join(" ")}\\n\`);
process.exit(1);
`;
  fs.writeFileSync(mockAgyPath, mockAgyScript, { mode: 0o755 });

  const nodeBinDir = path.dirname(process.execPath);
  const envWithMockAgy = {
    ...process.env,
    HOME: home,
    MOCK_AGY_LOG: logFile,
    MOCK_AGY_STATE: stateFile,
    PATH: `${mockBin}${path.delimiter}${nodeBinDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  };

  assert.notEqual(envWithMockAgy.HOME, REAL_HOME);

  function readCalls() {
    if (!fs.existsSync(logFile)) return [];
    return fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  return { root, home, workspace, mockBin, envWithMockAgy, readCalls };
}

function makePathWithoutAgy(rootDir) {
  const sysBin = path.join(rootDir, "sys-bin-no-agy");
  fs.mkdirSync(sysBin, { recursive: true });
  const needed = [
    "sh",
    "dirname",
    "grep",
    "cat",
    "mkdir",
    "mv",
    "date",
    "rm",
    "pwd",
    "printf",
    "sed",
    "awk",
    "tr",
    "wc",
    "head",
  ];
  const searchDirs = ["/bin", "/usr/bin"];
  for (const tool of needed) {
    for (const dir of searchDirs) {
      const candidate = path.join(dir, tool);
      if (fs.existsSync(candidate)) {
        const dest = path.join(sysBin, tool);
        if (!fs.existsSync(dest)) {
          fs.symlinkSync(candidate, dest);
        }
        break;
      }
    }
  }
  return sysBin;
}

function parseFrontmatter(markdownText) {
  const match = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(match, "Expected valid YAML frontmatter delimited by ---");
  return { rawFrontmatter: match[1], body: match[2] };
}

test("plugin.json, package.json, and assets/logo.svg satisfy strict schema and parity", () => {
  const pluginJsonPath = path.join(REPO_ROOT, "plugin.json");
  const packageJsonPath = path.join(REPO_ROOT, "package.json");
  const logoPath = path.join(REPO_ROOT, "assets", "logo.svg");

  assert.ok(fs.existsSync(pluginJsonPath), "plugin.json must exist");
  assert.ok(fs.existsSync(packageJsonPath), "package.json must exist");
  assert.ok(fs.existsSync(logoPath), "assets/logo.svg must exist");

  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  for (const key of Object.keys(pluginJson)) {
    assert.ok(
      ALLOWED_PLUGIN_JSON_KEYS.has(key),
      `Disallowed or unknown key '${key}' in plugin.json (fails agy plugin validate --strict)`
    );
  }

  assert.equal(pluginJson.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.equal(pluginJson.name, "agy-loop");
  assert.equal(pluginJson.displayName, "AGY Loop");
  assert.doesNotMatch(
    pluginJson.displayName,
    /Antigravity|Gemini|Claude|Cursor|Plugin/i,
    "displayName must not contain forbidden brand/generic words"
  );
  assert.equal(Array.isArray(pluginJson.suggestedPrompts), true);
  assert.equal(pluginJson.suggestedPrompts.length, 3);
  for (const prompt of pluginJson.suggestedPrompts) {
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.trim().length > 0);
    assert.match(
      prompt,
      /^\/agy-loop:loop\b/,
      `suggestedPrompt '${prompt}' should use the plugin-namespaced '/agy-loop:loop' command`
    );
  }

  assert.equal(packageJson.name, pluginJson.name);
  assert.equal(packageJson.version, pluginJson.version);
  assert.equal(packageJson.description, pluginJson.description);
  assert.equal(packageJson.license, pluginJson.license);
  assert.equal(packageJson.homepage, pluginJson.homepage);
  assert.deepEqual(packageJson.author, pluginJson.author);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines?.node, ">=18");
  assert.equal(packageJson.bin?.["agy-loop"], "./bin/agy-loop.mjs");
  assert.equal(packageJson.dependencies, undefined, "Expected zero external dependencies");
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("hooks.json"),
    'package.json "files" must include "hooks.json"'
  );

  const svg = fs.readFileSync(logoPath, "utf8");
  assert.match(svg, /<svg\b[^>]*viewBox="0 0 128 128"/);
  assert.match(svg, /\bwidth="128"/);
  assert.match(svg, /\bheight="128"/);
  assert.match(svg, /#0F172A/i);
  assert.match(svg, /#38BDF8/i);
  assert.match(svg, /#22C55E/i);
  assert.match(svg, /#A855F7/i);
});

test("plugin repository contains no forbidden Antigravity plugin paths", () => {
  const forbidden = [
    path.join(REPO_ROOT, "commands"),
    path.join(REPO_ROOT, "hooks", "hooks.json"),
    path.join(REPO_ROOT, "AGENTS.md"),
    path.join(REPO_ROOT, "GEMINI.md"),
  ];
  for (const p of forbidden) {
    assert.equal(
      fs.existsSync(p),
      false,
      `Forbidden plugin path must not exist: ${path.relative(REPO_ROOT, p)}`
    );
  }
});

const agentMdPath = path.join(REPO_ROOT, "agents", "loop-worker.md");
const skillMdPath = path.join(REPO_ROOT, "skills", "loop", "SKILL.md");
const helperShPath = path.join(REPO_ROOT, "skills", "loop", "scripts", "loop-helper.sh");

test(
  "agents/loop-worker.md has safe frontmatter, verified Cortex tools, and 4-line output contract",
  { skip: !fs.existsSync(agentMdPath) ? "agents/loop-worker.md not present yet" : false },
  () => {
    const raw = fs.readFileSync(agentMdPath, "utf8");
    const { rawFrontmatter, body } = parseFrontmatter(raw);

    assert.match(rawFrontmatter, /^name:\s*["']?loop-worker["']?\s*$/m);
    assert.match(
      rawFrontmatter,
      /^description:\s*(?:["'][\s\S]*?["']|[>|][-+]?)\s*$/m
    );
    assert.match(rawFrontmatter, /^subagent:\s*true\s*$/m);
    assert.match(rawFrontmatter, /^mainAgent:\s*false\s*$/m);
    assert.match(rawFrontmatter, /^model:\s*["']?flash["']?\s*$/m);
    assert.match(rawFrontmatter, /^commandExecutionPolicy:\s*["']?sandbox["']?\s*$/m);

    const toolLines = [];
    let inTools = false;
    for (const line of rawFrontmatter.split(/\r?\n/)) {
      if (/^tools:\s*$/.test(line)) {
        inTools = true;
        continue;
      }
      if (inTools) {
        const item = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*$/);
        if (item) {
          toolLines.push(item[1]);
        } else if (/^\S/.test(line)) {
          inTools = false;
        }
      }
    }

    assert.ok(toolLines.length > 0, "loop-worker.md must explicitly declare tools");
    for (const toolName of toolLines) {
      assert.ok(
        VERIFIED_CORTEX_TOOLS.has(toolName),
        `Unverified tool '${toolName}' in loop-worker.md risks subagent hang`
      );
    }
    for (const reqTool of REQUIRED_LOOP_WORKER_TOOLS) {
      assert.ok(
        toolLines.includes(reqTool),
        `loop-worker.md missing expected Cortex tool '${reqTool}'`
      );
    }

    assert.match(body, /LOOP_STATUS:\s*DONE\s*\|\s*CONTINUE\s*\|\s*BLOCKED/);
    assert.match(body, /NEXT_DELAY_SEC:/);
    assert.match(body, /SUMMARY:/);
    assert.match(body, /NEXT_HINT:/);
  }
);

test(
  "skills/loop/SKILL.md has quoted YAML frontmatter and stays well under 24,000 byte cap",
  { skip: !fs.existsSync(skillMdPath) ? "skills/loop/SKILL.md not present yet" : false },
  () => {
    const raw = fs.readFileSync(skillMdPath, "utf8");
    const { rawFrontmatter, body } = parseFrontmatter(raw);

    assert.match(rawFrontmatter, /^name:\s*["']?loop["']?\s*$/m);
    assert.match(
      rawFrontmatter,
      /^description:\s*(?:["'][\s\S]*?["']|[>|][-+]?)\s*$/m,
      "SKILL.md description must be safely quoted or block-scalar formatted"
    );

    const bodyBytes = Buffer.byteLength(body, "utf8");
    assert.ok(
      bodyBytes < 24000,
      `SKILL.md body (${bodyBytes} bytes) must be strictly under the 24,000 byte cap`
    );
    assert.ok(bodyBytes > 500, "SKILL.md body should contain full orchestration protocol");
  }
);

test(
  "skills/loop/scripts/loop-helper.sh satisfies parse, resolve-task, and doctor contracts",
  { skip: !fs.existsSync(helperShPath) ? "loop-helper.sh not present yet" : false },
  (t) => {
    const { home, workspace, envWithMockAgy } = makeSandbox(t);

    const syntaxRes = spawnSync("sh", ["-n", helperShPath], { encoding: "utf8" });
    assert.equal(syntaxRes.status, 0, syntaxRes.stderr);

    const runHelper = (args, cwd = workspace, stdinText = undefined) => {
      const res = spawnSync("sh", [helperShPath, ...args], {
        cwd,
        env: envWithMockAgy,
        input: stdinText,
        encoding: "utf8",
      });
      return res;
    };

    // 1. Lifecycle commands
    const statusRes = runHelper(["parse", "status"]);
    assert.equal(statusRes.status, 0, statusRes.stderr);
    assert.deepEqual(JSON.parse(statusRes.stdout), { action: "status" });

    const stopRes = runHelper(["parse", "stop", "task-9"]);
    assert.equal(stopRes.status, 0, stopRes.stderr);
    assert.deepEqual(JSON.parse(stopRes.stdout), { action: "stop", target: "task-9" });

    const stopAllRes = runHelper(["parse", "/loop cancel"]);
    assert.equal(stopAllRes.status, 0, stopAllRes.stderr);
    assert.deepEqual(JSON.parse(stopAllRes.stdout), { action: "stop", target: "all" });

    const docCmdRes = runHelper(["parse", "doctor"]);
    assert.equal(docCmdRes.status, 0, docCmdRes.stderr);
    const docCmdParsed = JSON.parse(docCmdRes.stdout);
    assert.equal(docCmdParsed.action, "doctor");
    assert.ok(!docCmdParsed.clean_shadow);

    // 2. Fixed sub-minute interval
    const fixed30s = JSON.parse(runHelper(["parse", "/loop 30s check local build"]).stdout);
    assert.equal(fixed30s.pacing, "fixed");
    assert.equal(fixed30s.interval_sec, 30);
    assert.equal(fixed30s.cron_expr, null);
    assert.equal(fixed30s.use_cron, false);
    assert.equal(fixed30s.delegate, "loop-worker");
    assert.equal(fixed30s.task_source, "inline");
    assert.equal(fixed30s.prompt, "check local build");

    // 3. Trailing interval + --cron
    const cron5m = JSON.parse(
      runHelper(["parse", "check deploy status every 5m --cron --exact --daemon"]).stdout
    );
    assert.equal(cron5m.pacing, "fixed");
    assert.equal(cron5m.interval_sec, 300);
    assert.equal(cron5m.cron_expr, "*/5 * * * *");
    assert.equal(cron5m.use_cron, true);
    assert.equal(cron5m.exact_timing, true);
    assert.equal(cron5m.is_daemon, true);

    // 4. One-shot in <interval>
    const oneShot = JSON.parse(runHelper(["parse", "in 20m verify staging rollout"]).stdout);
    assert.equal(oneShot.once, true);
    assert.equal(oneShot.max_iterations, 1);
    assert.equal(oneShot.interval_sec, 1200);

    // 5. Dynamic self-paced + flags + quote escaping
    const dynamic = JSON.parse(
      runHelper([
        "parse",
        'check "PR #42" CI & fix failures --stateful --worktree --max 7 --model pro',
      ]).stdout
    );
    assert.equal(dynamic.pacing, "dynamic");
    assert.equal(dynamic.state_mode, "stateful");
    assert.equal(dynamic.workspace, "branch");
    assert.equal(dynamic.max_iterations, 7);
    assert.equal(dynamic.model, "pro");
    assert.match(dynamic.prompt, /PR #42/);

    // 6. Nested slash command auto-selects self delegate
    const slashDelegate = JSON.parse(runHelper(["parse", "10m /check release readiness"]).stdout);
    assert.equal(slashDelegate.delegate, "self");

    // 7. Bare /loop -> loop_md_or_default
    const bare = JSON.parse(runHelper(["parse"]).stdout);
    assert.equal(bare.task_source, "loop_md_or_default");
    assert.equal(bare.prompt, "");

    // 8. Invalid --max / --model exits with status 2
    const badMax = runHelper(["parse", "--max", "0", "check tests"]);
    assert.equal(badMax.status, 2);
    assert.ok(JSON.parse(badMax.stdout.trim() || badMax.stderr.trim()).error);

    const badModel = runHelper(["parse", "--model", "ultra", "check tests"]);
    assert.equal(badModel.status, 2);

    // 9. resolve-task precedence & 25,000 byte truncation
    const builtinTask = JSON.parse(runHelper(["resolve-task", workspace]).stdout);
    assert.equal(builtinTask.source, "builtin");
    assert.equal(builtinTask.path, null);
    assert.equal(builtinTask.truncated, false);

    const globalLoopMd = path.join(home, ".gemini", "config", "loop.md");
    fs.mkdirSync(path.dirname(globalLoopMd), { recursive: true });
    fs.writeFileSync(globalLoopMd, "Global maintenance task\n");
    const resolvedGlobal = JSON.parse(runHelper(["resolve-task", workspace]).stdout);
    assert.equal(resolvedGlobal.source, "~/.gemini/config/loop.md");
    assert.match(resolvedGlobal.prompt, /Global maintenance task/);

    const rootLoopMd = path.join(workspace, "loop.md");
    fs.writeFileSync(rootLoopMd, "Workspace root loop task\n");
    const resolvedRoot = JSON.parse(runHelper(["resolve-task", workspace]).stdout);
    assert.equal(resolvedRoot.source, "loop.md");

    const agentsLoopMd = path.join(workspace, ".agents", "loop.md");
    fs.mkdirSync(path.dirname(agentsLoopMd), { recursive: true });
    fs.writeFileSync(agentsLoopMd, "A".repeat(26050));
    const resolvedAgents = JSON.parse(runHelper(["resolve-task", workspace]).stdout);
    assert.equal(resolvedAgents.source, ".agents/loop.md");
    assert.equal(resolvedAgents.truncated, true);
    assert.ok(Buffer.byteLength(resolvedAgents.prompt, "utf8") <= 25000);

    // 10. doctor subcommand
    fs.rmSync(agentsLoopMd, { force: true });
    fs.rmSync(rootLoopMd, { force: true });
    fs.rmSync(globalLoopMd, { force: true });

    const cleanDoc = JSON.parse(runHelper(["doctor", workspace]).stdout);
    assert.equal(cleanDoc.ok, true);
    assert.deepEqual(cleanDoc.shadows, []);
    assert.deepEqual(cleanDoc.skill_filter_warnings, []);
    assert.equal(cleanDoc.active_loop_md, null);

    fs.mkdirSync(path.join(home, ".gemini", "config", "skills", "loop"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".agents", "skills.json"),
      JSON.stringify({
        include_only: ["some-other-skill"],
        entries: [{ path: "skills", include_only: ["some-other-skill"] }],
      })
    );
    fs.writeFileSync(agentsLoopMd, "Active loop instructions\n");

    const warnDoc = JSON.parse(runHelper(["doctor", workspace]).stdout);
    assert.equal(warnDoc.ok, false);
    assert.ok(warnDoc.shadows.length >= 1);
    assert.ok(warnDoc.skill_filter_warnings.length >= 1);
    assert.ok(warnDoc.active_loop_md);

    // 11. Adversarial regressions: unknown subcommands with backslashes, newlines, control chars
    for (const badSubcmd of ["foo\\xbar", "foo\nbar", "foo\x07bar"]) {
      const badSubRes = runHelper([badSubcmd]);
      assert.equal(badSubRes.status, 2);
      const errObj = JSON.parse(badSubRes.stdout.trim() || badSubRes.stderr.trim());
      assert.ok(errObj.error.includes("Unknown subcommand"));
    }

    // 12. Conflicting flags must exit 2 with valid JSON error
    const conflictCases = [
      ["parse", "30s check --worktree --share"],
      ["parse", "5m check --once --cron"],
      ["parse", "in 5m check --cron"],
      ["parse", "in 20m check --max 5"],
      ["parse", "--once --max 5 check"],
      ["parse", "check --stateful --fresh"],
    ];
    for (const cArgs of conflictCases) {
      const cRes = runHelper(cArgs);
      assert.equal(cRes.status, 2, `Expected exit 2 for conflicting flags: ${cArgs.join(" ")}`);
      const cJson = JSON.parse(cRes.stdout.trim() || cRes.stderr.trim());
      assert.ok(cJson.error);
    }

    // 13. Help subcommands, stop --all, and shell-safe parse --stdin
    for (const helpArg of ["/loop --help", "help", "-h", "/agy-loop:loop --help"]) {
      const hRes = runHelper(["parse", helpArg]);
      assert.equal(hRes.status, 0, hRes.stderr);
      assert.deepEqual(JSON.parse(hRes.stdout), { action: "help" });
    }

    for (const stopAllArg of ["stop --all", "cancel --all"]) {
      const sRes = runHelper(["parse", stopAllArg]);
      assert.equal(sRes.status, 0, sRes.stderr);
      assert.deepEqual(JSON.parse(sRes.stdout), { action: "stop", target: "all" });
    }

    const pwnMarker = path.join(workspace, "should-never-exist");
    const rawMetachars = `/loop 30s check "$(touch ${pwnMarker})" \`id\` $HOME 'single' \\path --stateful`;
    const stdinRes = runHelper(["parse", "--stdin"], workspace, rawMetachars);
    assert.equal(stdinRes.status, 0, stdinRes.stderr);
    assert.equal(fs.existsSync(pwnMarker), false);
    const stdinParsed = JSON.parse(stdinRes.stdout);
    assert.equal(stdinParsed.pacing, "fixed");
    assert.equal(stdinParsed.interval_sec, 30);
    assert.equal(stdinParsed.state_mode, "stateful");
    assert.ok(stdinParsed.prompt.includes(`$(touch ${pwnMarker})`));
    assert.ok(stdinParsed.prompt.includes("`id`"));
    assert.ok(stdinParsed.prompt.includes("$HOME"));
    assert.ok(stdinParsed.prompt.includes("\\path"));
  }
);

test("bin/agy-loop.mjs handles install, --clean-shadow, doctor --json, validate, uninstall, and missing agy", (t) => {
  const { root, home, workspace, envWithMockAgy, readCalls } = makeSandbox(t);
  const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");

  const runCli = (args, customEnv = envWithMockAgy) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      cwd: workspace,
      env: customEnv,
      encoding: "utf8",
    });

  // --help & --version
  const helpRes = runCli(["--help"]);
  assert.equal(helpRes.status, 0);
  assert.match(helpRes.stdout, /Usage:\s+agy-loop/);

  const verRes = runCli(["version", "--json"]);
  assert.equal(verRes.status, 0);
  assert.equal(JSON.parse(verRes.stdout).name, "agy-loop");

  // Create shadow files in isolated HOME
  const shadowSkillDir = path.join(home, ".gemini", "config", "skills", "loop");
  const shadowAgentFile = path.join(home, ".gemini", "config", "agents", "loop-worker.md");
  fs.mkdirSync(shadowSkillDir, { recursive: true });
  fs.writeFileSync(path.join(shadowSkillDir, "SKILL.md"), "legacy shadow skill\n");
  fs.mkdirSync(path.dirname(shadowAgentFile), { recursive: true });
  fs.writeFileSync(shadowAgentFile, "legacy shadow worker\n");

  // 1. Default install warns about shadow files without deleting them
  const installWarnRes = runCli([]);
  assert.equal(installWarnRes.status, 0, installWarnRes.stderr);
  assert.match(installWarnRes.stderr, /--clean-shadow/);
  assert.equal(fs.existsSync(shadowSkillDir), true);
  assert.equal(fs.existsSync(shadowAgentFile), true);

  // 2. doctor --json detects shadows and skills.json filter
  fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".agents", "skills.json"),
    JSON.stringify({ entries: [{ path: "skills", include_only: ["lint"] }] })
  );
  fs.writeFileSync(path.join(workspace, ".agents", "loop.md"), "Check CI\n");

  const docShadowRes = runCli(["doctor", "--json"]);
  assert.equal(docShadowRes.status, 0, docShadowRes.stderr);
  const docShadow = JSON.parse(docShadowRes.stdout);
  assert.equal(docShadow.ok, false);
  assert.equal(docShadow.agy.version, "1.5.9");
  assert.equal(docShadow.plugin.installed, true);
  assert.equal(docShadow.shadows.length, 2);
  assert.equal(docShadow.skillFilterWarnings.length, 1);
  assert.equal(docShadow.loopMd.activeSource, ".agents/loop.md");

  // 3. install --clean-shadow --json backs up shadow files cleanly
  fs.rmSync(path.join(workspace, ".agents", "skills.json"), { force: true });
  const cleanInstallRes = runCli(["install", "--clean-shadow", "--json"]);
  assert.equal(cleanInstallRes.status, 0, cleanInstallRes.stderr);
  const cleanInstall = JSON.parse(cleanInstallRes.stdout);
  assert.equal(cleanInstall.ok, true);
  assert.ok(cleanInstall.backupDir.includes(".agy-loop-backup-"));
  assert.equal(cleanInstall.movedShadows.length, 2);
  assert.equal(fs.existsSync(shadowSkillDir), false);
  assert.equal(fs.existsSync(shadowAgentFile), false);
  assert.equal(
    fs.readFileSync(
      path.join(cleanInstall.backupDir, "config", "skills", "loop", "SKILL.md"),
      "utf8"
    ),
    "legacy shadow skill\n"
  );
  assert.equal(
    fs.readFileSync(
      path.join(cleanInstall.backupDir, "config", "agents", "loop-worker.md"),
      "utf8"
    ),
    "legacy shadow worker\n"
  );

  // 4. doctor --json is now healthy (ok: true)
  const docOkRes = runCli(["status", "--json"]);
  assert.equal(docOkRes.status, 0);
  const docOk = JSON.parse(docOkRes.stdout);
  assert.equal(docOk.ok, true);
  assert.deepEqual(docOk.shadows, []);

  // 4b. doctor --clean-shadow --json (and human-readable status --clean-shadow) cleans shadows directly
  fs.mkdirSync(shadowSkillDir, { recursive: true });
  fs.writeFileSync(path.join(shadowSkillDir, "SKILL.md"), "re-seeded shadow skill\n");
  fs.mkdirSync(path.dirname(shadowAgentFile), { recursive: true });
  fs.writeFileSync(shadowAgentFile, "re-seeded shadow agent\n");

  const docCleanJsonRes = runCli(["doctor", "--clean-shadow", "--json"]);
  assert.equal(docCleanJsonRes.status, 0, docCleanJsonRes.stderr);
  const docClean = JSON.parse(docCleanJsonRes.stdout);
  assert.equal(docClean.ok, true);
  assert.ok(docClean.backupDir && docClean.backupDir.includes(".agy-loop-backup-"));
  assert.equal(docClean.cleanedShadows.length, 2);
  assert.deepEqual(docClean.shadows, []);
  assert.equal(fs.existsSync(shadowSkillDir), false);
  assert.equal(fs.existsSync(shadowAgentFile), false);
  assert.equal(
    fs.readFileSync(
      path.join(docClean.backupDir, "config", "skills", "loop", "SKILL.md"),
      "utf8"
    ),
    "re-seeded shadow skill\n"
  );
  assert.equal(
    fs.readFileSync(
      path.join(docClean.backupDir, "config", "agents", "loop-worker.md"),
      "utf8"
    ),
    "re-seeded shadow agent\n"
  );

  // Human-readable doctor --clean-shadow reminds about /skills reload
  fs.mkdirSync(shadowSkillDir, { recursive: true });
  fs.writeFileSync(path.join(shadowSkillDir, "SKILL.md"), "human shadow skill\n");
  const docCleanHumanRes = runCli(["doctor", "--clean-shadow"]);
  assert.equal(docCleanHumanRes.status, 0, docCleanHumanRes.stderr);
  assert.match(docCleanHumanRes.stdout, /\/skills reload/);
  assert.match(docCleanHumanRes.stdout, /shadow files:\s+none/);
  assert.equal(fs.existsSync(shadowSkillDir), false);

  // 5. validate --json
  const valRes = runCli(["validate", "--json"]);
  assert.equal(valRes.status, 0);
  assert.deepEqual(JSON.parse(valRes.stdout).findings, []);

  // 6. uninstall
  const uninstRes = runCli(["uninstall", "--json"]);
  assert.equal(uninstRes.status, 0);
  assert.equal(JSON.parse(uninstRes.stdout).ok, true);

  const calls = readCalls();
  assert.ok(calls.some((c) => c.args[0] === "plugin" && c.args[1] === "install"));
  assert.ok(calls.some((c) => c.args[0] === "plugin" && c.args[1] === "uninstall"));

  // 7. Missing agy binary in PATH returns clean error
  const noAgyBin = makePathWithoutAgy(root);
  const noAgyRes = runCli(["install"], {
    ...envWithMockAgy,
    PATH: noAgyBin,
  });
  assert.equal(noAgyRes.status, 1);
  assert.match(noAgyRes.stderr, /not found in PATH/);
});

test("JSONC filter edge cases and 0-byte loop.md parity match across bin/agy-loop.mjs and loop-helper.sh", (t) => {
  const { workspace, envWithMockAgy } = makeSandbox(t);
  const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");
  const hasHelper = fs.existsSync(helperShPath);

  const runCli = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });

  const runHelperDoc = () =>
    spawnSync("sh", [helperShPath, "doctor", workspace], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });

  // Install plugin in mock state so doctor ok reflects filter/shadow health cleanly
  assert.equal(runCli(["install", "--json"]).status, 0);
  fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
  const skillsJsonPath = path.join(workspace, ".agents", "skills.json");

  const filterScenarios = [
    {
      name: 'inline // comment mentioning "loop"',
      content: '{\n  "include_only": [\n    "lint" // add "loop" later\n  ]\n}\n',
      expectWarning: true,
    },
    {
      name: "block /* ... */ comment with commented-out include_only",
      content: '{\n  /* "include_only": ["lint"], */\n  "entries": []\n}\n',
      expectWarning: false,
    },
    {
      name: 'explicit "exclude": ["loop"]',
      content: '{\n  "exclude": ["loop"]\n}\n',
      expectWarning: true,
    },
    {
      name: 'wildcard "*" in include_only',
      content: '{\n  "include_only": ["*"]\n}\n',
      expectWarning: false,
    },
    {
      name: 'regex wildcard ".*" in include_only',
      content: '{\n  "include_only": [".*"]\n}\n',
      expectWarning: false,
    },
    {
      name: '",]" inside string literal without loop (and trailing comma outside string)',
      content:
        '{\n  "entries": [\n    { "path": "skills/foo,]", "include_only": ["[x,]oop", "bar,}",], },\n  ],\n}\n',
      expectWarning: true,
      expectWarningMatch: /skills\/foo,\]/,
    },
    {
      name: '",]" inside string literal when loop is only matched if mutated',
      content: '{\n  "include_only": ["loop,]"]\n}\n',
      expectWarning: true,
    },
  ];

  for (const scenario of filterScenarios) {
    fs.writeFileSync(skillsJsonPath, scenario.content);
    const cliDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
    assert.equal(
      cliDoc.skillFilterWarnings.length > 0,
      scenario.expectWarning,
      `bin/agy-loop.mjs mismatch on scenario: ${scenario.name}`
    );
    if (scenario.expectWarningMatch) {
      assert.match(cliDoc.skillFilterWarnings[0], scenario.expectWarningMatch);
    }

    if (hasHelper) {
      const helperRes = runHelperDoc();
      assert.equal(helperRes.status, 0, helperRes.stderr);
      const helperDoc = JSON.parse(helperRes.stdout);
      assert.equal(
        helperDoc.skill_filter_warnings.length > 0,
        scenario.expectWarning,
        `loop-helper.sh mismatch on scenario: ${scenario.name}`
      );
    }
  }

  fs.rmSync(skillsJsonPath, { force: true });

  // 0-byte .agents/loop.md fallback parity
  const agentsLoopMd = path.join(workspace, ".agents", "loop.md");
  const rootLoopMd = path.join(workspace, "loop.md");
  fs.writeFileSync(agentsLoopMd, ""); // 0 bytes

  // Case A: 0-byte .agents/loop.md + no other loop.md -> builtin / null
  const cliEmptyOnly = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(cliEmptyOnly.loopMd.active, null);
  assert.equal(cliEmptyOnly.loopMd.activeSource, "builtin");
  if (hasHelper) {
    const helperEmptyDoc = JSON.parse(runHelperDoc().stdout);
    assert.equal(helperEmptyDoc.active_loop_md, null);
    const helperEmptyResolve = JSON.parse(
      spawnSync("sh", [helperShPath, "resolve-task", workspace], {
        cwd: workspace,
        env: envWithMockAgy,
        encoding: "utf8",
      }).stdout
    );
    assert.equal(helperEmptyResolve.source, "builtin");
  }

  // Case B: 0-byte .agents/loop.md + non-empty root loop.md -> selects root loop.md
  fs.writeFileSync(rootLoopMd, "Non-empty root loop instructions\n");
  const cliFallback = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(cliFallback.loopMd.activeSource, "loop.md");
  assert.equal(
    fs.realpathSync(cliFallback.loopMd.active),
    fs.realpathSync(rootLoopMd)
  );
  if (hasHelper) {
    const helperFallbackDoc = JSON.parse(runHelperDoc().stdout);
    assert.ok(
      helperFallbackDoc.active_loop_md &&
        helperFallbackDoc.active_loop_md.endsWith(`${path.sep}loop.md`) &&
        !helperFallbackDoc.active_loop_md.includes(`${path.sep}.agents${path.sep}loop.md`)
    );
  }
});

test("install.sh and uninstall.sh work in local, piped, --clean-shadow, and missing-agy modes", (t) => {
  const { root, home, workspace, envWithMockAgy, readCalls } = makeSandbox(t);
  const installSh = path.join(REPO_ROOT, "install.sh");
  const uninstallSh = path.join(REPO_ROOT, "uninstall.sh");

  const syntaxRes = spawnSync("sh", ["-n", installSh, uninstallSh], { encoding: "utf8" });
  assert.equal(syntaxRes.status, 0, syntaxRes.stderr);

  // Seed shadow directory
  const shadowDir = path.join(home, ".gemini", "config", "skills", "loop");
  fs.mkdirSync(shadowDir, { recursive: true });
  fs.writeFileSync(path.join(shadowDir, "SKILL.md"), "shadow content\n");

  // 1. Local ./install.sh installs REPO_ROOT and warns on shadow
  const localInstall = spawnSync("sh", [installSh], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(localInstall.status, 0, localInstall.stderr);
  assert.match(localInstall.stderr, /--clean-shadow/);
  assert.equal(fs.existsSync(shadowDir), true);

  // 2. Local ./install.sh --clean-shadow archives shadow into backup dir
  const cleanInstall = spawnSync("sh", [installSh, "--clean-shadow"], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(cleanInstall.status, 0, cleanInstall.stderr);
  assert.match(cleanInstall.stdout, /\.agy-loop-backup-/);
  assert.equal(fs.existsSync(shadowDir), false);

  // 3. Piped stdin install (curl ... | sh) from unrelated directory installs GitHub URL
  const pipedScript = fs.readFileSync(installSh, "utf8");
  const pipedInstall = spawnSync("sh", [], {
    cwd: workspace,
    env: envWithMockAgy,
    input: pipedScript,
    encoding: "utf8",
  });
  assert.equal(pipedInstall.status, 0, pipedInstall.stderr);

  // 4. uninstall.sh calls agy plugin uninstall agy-loop
  const uninstallRes = spawnSync("sh", [uninstallSh], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(uninstallRes.status, 0, uninstallRes.stderr);

  const calls = readCalls();
  assert.ok(
    calls.some(
      (c) => c.args[0] === "plugin" && c.args[1] === "install" && c.args[2] === REPO_ROOT
    ),
    "Local install.sh should install local repo path"
  );
  assert.ok(
    calls.some(
      (c) =>
        c.args[0] === "plugin" &&
        c.args[1] === "install" &&
        c.args[2] === "https://github.com/maxlee/agy-loop"
    ),
    "Piped install.sh should install remote GitHub repository URL"
  );
  assert.ok(
    calls.some(
      (c) => c.args[0] === "plugin" && c.args[1] === "uninstall" && c.args[2] === "agy-loop"
    ),
    "uninstall.sh should uninstall agy-loop"
  );

  // 5. Missing agy binary fails cleanly on both install.sh and uninstall.sh
  const noAgyPath = makePathWithoutAgy(root);
  const missingInstall = spawnSync("/bin/sh", [installSh], {
    cwd: workspace,
    env: { HOME: home, PATH: noAgyPath },
    encoding: "utf8",
  });
  assert.equal(missingInstall.status, 1);
  assert.match(missingInstall.stderr, /not found in PATH/);

  const missingUninstall = spawnSync("/bin/sh", [uninstallSh], {
    cwd: workspace,
    env: { HOME: home, PATH: noAgyPath },
    encoding: "utf8",
  });
  assert.equal(missingUninstall.status, 1);
  assert.match(missingUninstall.stderr, /not found in PATH/);
});

const hooksJsonPath = path.join(REPO_ROOT, "hooks.json");
const realAgyProbe = spawnSync("agy", ["--version"], { encoding: "utf8" });
const hasRealAgy = !realAgyProbe.error && realAgyProbe.status === 0;
const hasFullPluginFiles = fs.existsSync(skillMdPath) && fs.existsSync(agentMdPath);

test(
  "installed plugin self-reinstall (--clean-shadow) via real 'agy plugin install' backs up shadows without self-copy crash",
  {
    skip: !hasRealAgy ? "real 'agy' CLI not on PATH" : false,
  },
  (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-e2e-home-"));
    const tmpHome = path.join(tmpRoot, "home");
    const tmpWs = path.join(tmpRoot, "ws");
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpWs, { recursive: true });

    t.after(() => {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    const isolatedEnv = { ...process.env, HOME: tmpHome };
    delete isolatedEnv.ANTIGRAVITY_LS_ADDRESS;
    delete isolatedEnv.ANTIGRAVITY_CSRF_TOKEN;
    assert.notEqual(isolatedEnv.HOME, REAL_HOME);

    const shadowSkillDir = path.join(tmpHome, ".gemini", "config", "skills", "loop");
    const shadowAgentFile = path.join(tmpHome, ".gemini", "config", "agents", "loop-worker.md");

    const seedShadows = (tag) => {
      fs.mkdirSync(shadowSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(shadowSkillDir, "SKILL.md"),
        `---\nname: loop\ndescription: "OLD_USER_SKILL_${tag}"\n---\nOld skill ${tag}\n`
      );
      fs.mkdirSync(path.dirname(shadowAgentFile), { recursive: true });
      fs.writeFileSync(
        shadowAgentFile,
        `---\nname: loop-worker\ndescription: "OLD_USER_AGENT_${tag}"\nsubagent: true\nmainAgent: false\n---\nOld agent ${tag}\n`
      );
    };

    seedShadows("A");

    // 1. Install via real 'agy plugin install <REPO_ROOT>'
    const installRes = spawnSync("agy", ["plugin", "install", REPO_ROOT], {
      cwd: tmpWs,
      env: isolatedEnv,
      encoding: "utf8",
    });
    assert.equal(installRes.status, 0, `agy plugin install failed: ${installRes.stderr}`);

    const installedDir = path.join(tmpHome, ".gemini", "config", "plugins", "agy-loop");
    assert.equal(fs.existsSync(path.join(installedDir, "plugin.json")), true);
    // Loose shadow files remain intact right after 'agy plugin install'
    assert.equal(fs.existsSync(path.join(shadowSkillDir, "SKILL.md")), true);
    assert.equal(fs.existsSync(shadowAgentFile), true);

    // 2. Run installed copy's install.sh --clean-shadow (from inside installedDir)
    const selfShRes = spawnSync("sh", [path.join(installedDir, "install.sh"), "--clean-shadow"], {
      cwd: installedDir,
      env: isolatedEnv,
      encoding: "utf8",
    });
    assert.equal(
      selfShRes.status,
      0,
      `installed install.sh --clean-shadow failed:\nstdout: ${selfShRes.stdout}\nstderr: ${selfShRes.stderr}`
    );
    assert.doesNotMatch(selfShRes.stderr, /same directory/i);
    assert.equal(fs.existsSync(shadowSkillDir), false);
    assert.equal(fs.existsSync(shadowAgentFile), false);

    const configDir = path.join(tmpHome, ".gemini", "config");
    const backupsAfterSh = fs
      .readdirSync(configDir)
      .filter((name) => name.startsWith(".agy-loop-backup-"));
    assert.equal(backupsAfterSh.length, 1);
    const shBackupDir = path.join(configDir, backupsAfterSh[0]);
    assert.match(
      fs.readFileSync(path.join(shBackupDir, "config", "skills", "loop", "SKILL.md"), "utf8"),
      /OLD_USER_SKILL_A/
    );
    assert.match(
      fs.readFileSync(path.join(shBackupDir, "config", "agents", "loop-worker.md"), "utf8"),
      /OLD_USER_AGENT_A/
    );

    // 3. Re-seed shadows and run installed copy's bin/agy-loop.mjs install --clean-shadow --json
    seedShadows("B");
    const selfNodeRes = spawnSync(
      process.execPath,
      [path.join(installedDir, "bin", "agy-loop.mjs"), "install", "--clean-shadow", "--json"],
      {
        cwd: installedDir,
        env: isolatedEnv,
        encoding: "utf8",
      }
    );
    assert.equal(
      selfNodeRes.status,
      0,
      `installed agy-loop.mjs install --clean-shadow failed:\nstdout: ${selfNodeRes.stdout}\nstderr: ${selfNodeRes.stderr}`
    );
    const selfNodeJson = JSON.parse(selfNodeRes.stdout);
    assert.equal(selfNodeJson.ok, true);
    assert.equal(selfNodeJson.alreadyInPlace, true);
    assert.equal(selfNodeJson.movedShadows.length, 2);
    assert.deepEqual(selfNodeJson.shadows, []);
    assert.match(
      fs.readFileSync(
        path.join(selfNodeJson.backupDir, "config", "skills", "loop", "SKILL.md"),
        "utf8"
      ),
      /OLD_USER_SKILL_B/
    );
    assert.match(
      fs.readFileSync(
        path.join(selfNodeJson.backupDir, "config", "agents", "loop-worker.md"),
        "utf8"
      ),
      /OLD_USER_AGENT_B/
    );

    // 4. Verify doctor --json on installed copy reports ok: true
    const finalDocRes = spawnSync(
      process.execPath,
      [path.join(installedDir, "bin", "agy-loop.mjs"), "doctor", "--json"],
      {
        cwd: tmpWs,
        env: isolatedEnv,
        encoding: "utf8",
      }
    );
    assert.equal(finalDocRes.status, 0, finalDocRes.stderr);
    const finalDoc = JSON.parse(finalDocRes.stdout);
    assert.equal(finalDoc.ok, true);
    assert.equal(finalDoc.plugin.installed, true);
    assert.deepEqual(finalDoc.shadows, []);
  }
);

test(
  "hooks.json SessionStart hook and loop-helper.sh session-start / doctor --clean-shadow work end-to-end",
  {
    skip: !fs.existsSync(hooksJsonPath)
      ? "hooks.json not present yet"
      : !fs.existsSync(helperShPath)
        ? "loop-helper.sh not present yet"
        : false,
  },
  (t) => {
    const { home, workspace, envWithMockAgy } = makeSandbox(t);

    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
    assert.equal(typeof hooksConfig, "object");
    const hookNames = Object.keys(hooksConfig);
    assert.ok(hookNames.length >= 1, "hooks.json must define at least one named hook");

    let sessionStartHandler = null;
    for (const key of hookNames) {
      const spec = hooksConfig[key];
      if (spec && Array.isArray(spec.SessionStart) && spec.SessionStart.length > 0) {
        sessionStartHandler = spec.SessionStart[0];
        // SessionStart uses a flat handler array (not PreToolUse matcher wrapper)
        assert.equal(
          sessionStartHandler.matcher,
          undefined,
          "SessionStart handlers must be flat (no matcher wrapper)"
        );
        break;
      }
    }
    assert.ok(sessionStartHandler, "hooks.json must register a SessionStart handler");
    assert.equal(typeof sessionStartHandler.command, "string");
    assert.match(sessionStartHandler.command, /session-start/);

    const hookStdin = JSON.stringify({
      conversationId: "00000000-0000-0000-0000-000000000001",
      workspacePaths: [workspace],
      hookEventName: "SessionStart",
      cwd: workspace,
    });

    // 1. Clean HOME -> SessionStart outputs {} (zero injected steps, zero token cost)
    const cleanHookRes = spawnSync("sh", ["-c", sessionStartHandler.command], {
      cwd: REPO_ROOT,
      env: { ...envWithMockAgy, PLUGIN_ROOT: REPO_ROOT },
      input: hookStdin,
      encoding: "utf8",
    });
    assert.equal(cleanHookRes.status, 0, cleanHookRes.stderr);
    const cleanHookJson = JSON.parse(cleanHookRes.stdout);
    assert.deepEqual(cleanHookJson, {});

    // 2. Shadowed HOME -> SessionStart outputs injectSteps warning naming shadow paths & --clean-shadow
    const shadowSkillDir = path.join(home, ".gemini", "config", "skills", "loop");
    const shadowAgentFile = path.join(home, ".gemini", "config", "agents", "loop-worker.md");
    fs.mkdirSync(shadowSkillDir, { recursive: true });
    fs.writeFileSync(path.join(shadowSkillDir, "SKILL.md"), "shadow skill\n");
    fs.mkdirSync(path.dirname(shadowAgentFile), { recursive: true });
    fs.writeFileSync(shadowAgentFile, "shadow agent\n");

    const warnHookRes = spawnSync("sh", ["-c", sessionStartHandler.command], {
      cwd: REPO_ROOT,
      env: { ...envWithMockAgy, PLUGIN_ROOT: REPO_ROOT },
      input: hookStdin,
      encoding: "utf8",
    });
    assert.equal(warnHookRes.status, 0, warnHookRes.stderr);
    const warnHookJson = JSON.parse(warnHookRes.stdout);
    assert.ok(
      Array.isArray(warnHookJson.injectSteps) && warnHookJson.injectSteps.length >= 1,
      "Expected non-empty injectSteps when shadow files exist"
    );
    const step0 = warnHookJson.injectSteps[0];
    assert.ok(step0.systemMessage && typeof step0.systemMessage === "object");
    const combinedText = `${step0.systemMessage.systemMessage || ""}\n${
      step0.systemMessage.metadata?.user_markdown || ""
    }`;
    assert.match(combinedText, /--clean-shadow/);
    assert.match(combinedText, /skills\/loop/);
    assert.match(combinedText, /loop-worker\.md/);

    // 3. loop-helper.sh parse "doctor --clean-shadow"
    const parseCleanDoc = spawnSync("sh", [helperShPath, "parse", "doctor --clean-shadow"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(parseCleanDoc.status, 0, parseCleanDoc.stderr);
    const parsedCleanDocJson = JSON.parse(parseCleanDoc.stdout);
    assert.equal(parsedCleanDocJson.action, "doctor");
    assert.equal(parsedCleanDocJson.clean_shadow, true);

    // 4. loop-helper.sh doctor --clean-shadow <workspace> backs up both without collision
    const helperCleanRes = spawnSync(
      "sh",
      [helperShPath, "doctor", "--clean-shadow", workspace],
      {
        cwd: workspace,
        env: envWithMockAgy,
        encoding: "utf8",
      }
    );
    assert.equal(helperCleanRes.status, 0, helperCleanRes.stderr);
    const helperCleanJson = JSON.parse(helperCleanRes.stdout);
    assert.equal(helperCleanJson.ok, true);
    assert.deepEqual(helperCleanJson.shadows, []);
    assert.equal(helperCleanJson.cleaned_shadows.length, 2);
    assert.ok(helperCleanJson.backup_dir && fs.existsSync(helperCleanJson.backup_dir));
    assert.equal(fs.existsSync(shadowSkillDir), false);
    assert.equal(fs.existsSync(shadowAgentFile), false);

    // 5. After cleanup, SessionStart returns {} again
    const postCleanHookRes = spawnSync("sh", ["-c", sessionStartHandler.command], {
      cwd: REPO_ROOT,
      env: { ...envWithMockAgy, PLUGIN_ROOT: REPO_ROOT },
      input: hookStdin,
      encoding: "utf8",
    });
    assert.equal(postCleanHookRes.status, 0, postCleanHookRes.stderr);
    assert.deepEqual(JSON.parse(postCleanHookRes.stdout), {});
  }
);

test(
  "live 'agy plugin validate --strict --json' passes with 0 findings",
  {
    skip: !hasRealAgy
      ? "real 'agy' CLI not on PATH"
      : !hasFullPluginFiles
        ? "skills/ and agents/ not present yet"
        : false,
  },
  () => {
    const res = spawnSync("agy", ["plugin", "validate", "--strict", "--json", REPO_ROOT], {
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      `agy plugin validate --strict failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    const report = JSON.parse(res.stdout);
    assert.equal(report.name, "agy-loop");
    assert.deepEqual(report.findings, [], "Expected 0 warnings and 0 notes under --strict");
    assert.ok(report.components.skills >= 1, "Expected at least 1 compiled skill");
    assert.ok(report.components.agents >= 1, "Expected at least 1 compiled subagent");
    if (fs.existsSync(hooksJsonPath)) {
      assert.equal(report.components.hooks, 1, "Expected hooks: 1 when hooks.json is present");
    }
  }
);
