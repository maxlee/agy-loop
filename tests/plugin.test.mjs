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

const BROKEN_ONEHARNESS_TOOLS = [
  "multi_replace_file_content",
  "list_dir",
  "find_by_name",
  "grep_search",
];

const REQUIRED_LOOP_WORKER_TOOLS = [
  "view_file",
  "write_to_file",
  "replace_file_content",
  "run_command",
  "manage_task",
  "search_web",
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
const mockVersion = process.env.MOCK_AGY_VERSION || "1.5.9";
const mockPluginVersion = process.env.MOCK_AGY_PLUGIN_VERSION || "2.0.0";
const sleepMs = Number.parseInt(process.env.MOCK_AGY_SLEEP_MS || "0", 10);

function handleArgs() {
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
    process.stdout.write(\`\${mockVersion}\\n\`);
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
            version: mockPluginVersion,
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
}

if (Number.isFinite(sleepMs) && sleepMs > 0) {
  setTimeout(handleArgs, sleepMs);
} else {
  handleArgs();
}
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
  assert.equal(pluginJson.version, "2.0.0");
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
  assert.equal(packageJson.bin?.["agy-loop"], "bin/agy-loop.mjs");
  assert.equal(packageJson.dependencies, undefined, "Expected zero external dependencies");
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("hooks.json"),
    'package.json "files" must include "hooks.json"'
  );
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("lib/"),
    'package.json "files" must include "lib/"'
  );
  assert.ok(
    Array.isArray(packageJson.files) && packageJson.files.includes("workflows/"),
    'package.json "files" must include "workflows/"'
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
const verifierAgentMdPath = path.join(REPO_ROOT, "agents", "loop-verifier.md");
const skillMdPath = path.join(REPO_ROOT, "skills", "loop", "SKILL.md");
const workflowEngineRefPath = path.join(
  REPO_ROOT,
  "skills",
  "loop",
  "references",
  "workflow-engine.md"
);
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
        `loop-worker.md missing expected dual-engine tool '${reqTool}'`
      );
    }
    for (const brokenTool of BROKEN_ONEHARNESS_TOOLS) {
      assert.equal(
        toolLines.includes(brokenTool),
        false,
        `loop-worker.md must NOT include oneharness-broken tool '${brokenTool}'`
      );
    }
    assert.deepEqual(
      [...toolLines].sort(),
      [...REQUIRED_LOOP_WORKER_TOOLS].sort(),
      "loop-worker.md tools must match exact 6-tool dual-engine intersection"
    );

    assert.match(body, /LOOP_STATUS:\s*DONE\s*\|\s*CONTINUE\s*\|\s*BLOCKED/);
    assert.match(body, /NEXT_DELAY_SEC:/);
    assert.match(body, /SUMMARY:/);
    assert.match(body, /NEXT_HINT:/);
  }
);

test(
  "skills/loop/SKILL.md has quoted YAML frontmatter, stays under 18,000 bytes, and forbids resolve-task bypass",
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

    const totalBytes = Buffer.byteLength(raw, "utf8");
    const bodyBytes = Buffer.byteLength(body, "utf8");
    assert.ok(
      totalBytes < 16000,
      `SKILL.md total (${totalBytes} bytes) must be strictly under the 16,000 byte budget`
    );
    assert.ok(
      bodyBytes < 16000,
      `SKILL.md body (${bodyBytes} bytes) must be strictly under the 16,000 byte budget`
    );
    assert.ok(
      bodyBytes < 24000,
      `SKILL.md body (${bodyBytes} bytes) must be strictly under the 24,000 byte cap`
    );
    assert.equal(
      fs.existsSync(workflowEngineRefPath),
      true,
      "skills/loop/references/workflow-engine.md must exist for progressive disclosure"
    );
    const profilesDaemonsRefPath = path.join(
      REPO_ROOT,
      "skills",
      "loop",
      "references",
      "profiles-and-daemons.md"
    );
    assert.equal(
      fs.existsSync(profilesDaemonsRefPath),
      true,
      "skills/loop/references/profiles-and-daemons.md must exist for progressive disclosure"
    );
    assert.match(body, /references\/workflow-engine\.md/);
    assert.match(body, /references\/profiles-and-daemons\.md/);
    assert.ok(bodyBytes > 500, "SKILL.md body should contain full orchestration protocol");
    assert.doesNotMatch(
      body,
      /you may also read with\s+`?read_file`?\s+or\s+`?view_file`?/i,
      "SKILL.md must not reintroduce Turn A resolve-task bypass"
    );
    assert.doesNotMatch(
      body,
      /or re-read via\s+`?read_file`?\s*\/\s*`?view_file`?/i,
      "SKILL.md must not reintroduce Turn C resolve-task bypass"
    );
    assert.match(
      body,
      /do NOT bypass with (?:direct )?`?read_file`?\/`?view_file`?/i,
      "SKILL.md must explicitly forbid bypassing resolve-task"
    );
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
  assert.match(helpRes.stdout, /^\s*status\s+Show runtime overview/m);
  assert.match(helpRes.stdout, /^\s*doctor\s+Inspect agy capabilities/m);
  for (const subcmd of [
    "run",
    "resume",
    "nudge",
    "wake",
    "ps",
    "logs",
    "stop",
    "statusline",
    "profiles",
    "daemon",
    "validate",
    "status",
    "doctor",
  ]) {
    assert.match(
      helpRes.stdout,
      new RegExp(`\\b${subcmd}\\b`),
      `agy-loop --help must mention '${subcmd}'`
    );
  }

  const verRes = runCli(["version", "--json"]);
  assert.equal(verRes.status, 0);
  const verJson = JSON.parse(verRes.stdout);
  assert.equal(verJson.name, "agy-loop");
  assert.equal(verJson.version, "2.0.0");

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
  assert.equal(docShadow.plugin.version, "2.0.0");
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

  // 4. Option A status --json overview vs deep doctor --json report (both ok: true)
  const statusOkRes = runCli(["status", "--json"]);
  assert.equal(statusOkRes.status, 0);
  const statusOk = JSON.parse(statusOkRes.stdout);
  assert.equal(statusOk.ok, true);
  assert.equal(Array.isArray(statusOk.activeLoops), true);
  assert.equal(Array.isArray(statusOk.daemons), true);
  assert.equal(Array.isArray(statusOk.activeLocks), true);
  assert.equal(statusOk.health?.ok, true);
  assert.deepEqual(statusOk.health?.shadows, []);

  const docOkRes = runCli(["doctor", "--json"]);
  assert.equal(docOkRes.status, 0);
  const docOk = JSON.parse(docOkRes.stdout);
  assert.equal(docOk.ok, true);
  assert.deepEqual(docOk.shadows, []);
  assert.equal(typeof docOk.profiles?.count, "number");
  assert.equal(Array.isArray(docOk.activeLocks), true);
  assert.equal(typeof docOk.daemons?.total, "number");

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

test("loop-helper.sh v1.1 parser handles lifecycle subcommands, compound/prefix durations, Option A flags, and quotes", (t) => {
  const { workspace, envWithMockAgy } = makeSandbox(t);
  const runParse = (argStr, useStdin = false) =>
    useStdin
      ? spawnSync("sh", [helperShPath, "parse", "--stdin"], {
          cwd: workspace,
          env: envWithMockAgy,
          input: argStr,
          encoding: "utf8",
        })
      : spawnSync("sh", [helperShPath, "parse", argStr], {
          cwd: workspace,
          env: envWithMockAgy,
          encoding: "utf8",
        });

  // Lifecycle subcommands
  const lifecycleOk = [
    ["status --json", { action: "status", json: true }],
    ["status --all", { action: "status", all: true }],
    ["status --all --json", { action: "status", all: true, json: true }],
    ["list --all --json", { action: "status", all: true, json: true }],
    ["stop id1 id2", { action: "stop", target: "id1", targets: ["id1", "id2"] }],
    ["stop id1 --after-current", { action: "stop", target: "id1", after_current: true }],
    [
      "stop id1 id2 --after-current",
      { action: "stop", target: "id1", targets: ["id1", "id2"], after_current: true },
    ],
  ];
  for (const [input, expected] of lifecycleOk) {
    const res = runParse(input);
    assert.equal(res.status, 0, `Expected exit 0 for '${input}': ${res.stdout} ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout), expected, `Mismatch for '${input}'`);
  }

  for (const badLifecycle of [
    "status badarg",
    "help flags",
    "clean-shadow extra",
    "stop all id1",
    "stop --badflag",
  ]) {
    const res = runParse(badLifecycle);
    assert.equal(res.status, 2, `Expected exit 2 for '${badLifecycle}', got ${res.status}`);
    assert.ok(JSON.parse(res.stdout).error, `Expected JSON error for '${badLifecycle}'`);
  }

  // Durations & prefix `every`
  const every5m = JSON.parse(runParse("every 5m check").stdout);
  assert.equal(every5m.pacing, "fixed");
  assert.equal(every5m.interval_sec, 300);
  assert.equal(every5m.interval_label, "5m");
  assert.equal(every5m.cron_expr, "*/5 * * * *");
  assert.equal(every5m.prompt, "check");

  const every5Min = JSON.parse(runParse("every 5 minutes check").stdout);
  assert.equal(every5Min.pacing, "fixed");
  assert.equal(every5Min.interval_sec, 300);
  assert.equal(every5Min.interval_label, "5m");
  assert.equal(every5Min.prompt, "check");

  const everyHourComma = JSON.parse(runParse("every hour, check").stdout);
  assert.equal(everyHourComma.pacing, "fixed");
  assert.equal(everyHourComma.interval_sec, 3600);
  assert.equal(everyHourComma.interval_label, "1h");
  assert.equal(everyHourComma.cron_expr, "0 * * * *");
  assert.equal(everyHourComma.prompt, "check");

  const compound1h30m = JSON.parse(runParse("1h30m check").stdout);
  assert.equal(compound1h30m.pacing, "fixed");
  assert.equal(compound1h30m.interval_sec, 5400);
  assert.equal(compound1h30m.interval_label, "1h30m");
  assert.equal(compound1h30m.cron_expr, null);
  assert.equal(compound1h30m.prompt, "check");

  const every2m30s = JSON.parse(runParse("every 2m30s check").stdout);
  assert.equal(every2m30s.pacing, "fixed");
  assert.equal(every2m30s.interval_sec, 150);
  assert.equal(every2m30s.interval_label, "2m30s");
  assert.equal(every2m30s.prompt, "check");

  for (const badDur of [
    "1.5m check",
    "every 0.5h check",
    "0m check",
    "1h0m check",
    "1m2m check",
  ]) {
    const res = runParse(badDur);
    assert.equal(res.status, 2, `Expected exit 2 for invalid duration '${badDur}'`);
    assert.ok(JSON.parse(res.stdout).error);
  }

  // Option A two-tier unknown --flag policy
  for (const badFlagCase of [
    "--statefull check",
    "check --statefull",
    "5m check --work-tree",
    "--unknown 5m check",
  ]) {
    const res = runParse(badFlagCase);
    assert.equal(res.status, 2, `Expected exit 2 for '${badFlagCase}'`);
    assert.ok(JSON.parse(res.stdout).error);
  }

  const midFlagRes = runParse("30s gh pr checks --required");
  assert.equal(midFlagRes.status, 0, midFlagRes.stderr);
  const midFlagJson = JSON.parse(midFlagRes.stdout);
  assert.equal(midFlagJson.interval_sec, 30);
  assert.equal(midFlagJson.prompt, "gh pr checks --required");
  assert.ok(Array.isArray(midFlagJson.warnings) && midFlagJson.warnings.length > 0);
  assert.match(midFlagJson.warnings[0], /--required/);

  const endOfOptsRes = runParse("30s -- --statefull");
  assert.equal(endOfOptsRes.status, 0, endOfOptsRes.stderr);
  const endOfOptsJson = JSON.parse(endOfOptsRes.stdout);
  assert.equal(endOfOptsJson.interval_sec, 30);
  assert.equal(endOfOptsJson.prompt, "--statefull");
  assert.equal(endOfOptsJson.warnings, undefined);

  // Quote consistency (single quoted token vs multi-token embedded quotes)
  for (const useStdin of [false, true]) {
    const singleDoubleQ = JSON.parse(runParse('30s "npm test"', useStdin).stdout);
    assert.equal(singleDoubleQ.prompt, "npm test");

    const singleSingleQ = JSON.parse(runParse("30s 'npm test'", useStdin).stdout);
    assert.equal(singleSingleQ.prompt, "npm test");

    const multiEmbedded = JSON.parse(runParse('check "PR #42" CI', useStdin).stdout);
    assert.equal(multiEmbedded.prompt, 'check "PR #42" CI');
  }
});

test("loop-helper.sh externalized state store supports init/read/update/list/stop, git cleanliness, traversal guard, and AGY_LOOP_STATE_DIR", (t) => {
  const { root, workspace, envWithMockAgy } = makeSandbox(t);
  const runHelper = (args, customEnv = envWithMockAgy, stdinText = undefined, cwd = workspace) =>
    spawnSync("sh", [helperShPath, ...args], {
      cwd,
      env: customEnv,
      input: stdinText,
      encoding: "utf8",
    });

  // 1. Initialize real git repo to prove .agents/.agy-loop/.gitignore keeps git status clean
  const gitEnv = { ...envWithMockAgy, GIT_CONFIG_NOSYSTEM: "1" };
  const runGit = (args) =>
    spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: workspace,
      env: gitEnv,
      encoding: "utf8",
    });

  const gitInit = runGit(["init"]);
  assert.equal(gitInit.status, 0, gitInit.stderr);
  assert.equal(runGit(["config", "user.email", "test@example.com"]).status, 0);
  assert.equal(runGit(["config", "user.name", "Test User"]).status, 0);
  fs.writeFileSync(path.join(workspace, "README.md"), "repo\n");
  assert.equal(runGit(["add", "README.md"]).status, 0);
  const gitCommit = runGit(["commit", "-m", "init"]);
  assert.equal(gitCommit.status, 0, gitCommit.stderr);

  const parsedRun = runHelper(["parse", "/loop 30s check CI --max 5 --worktree --model flash"]);
  assert.equal(parsedRun.status, 0, parsedRun.stderr);

  const initRes = runHelper(["state-init", workspace, "--stdin"], envWithMockAgy, parsedRun.stdout);
  assert.equal(initRes.status, 0, initRes.stdout + initRes.stderr);
  const state1 = JSON.parse(initRes.stdout);
  assert.equal(state1.schema_version, 1);
  assert.equal(state1.status, "running");
  assert.equal(state1.iteration, 1);
  assert.equal(state1.consecutive_errors, 0);
  assert.equal(state1.stop_requested, false);
  assert.equal(state1.max_iterations, 5);
  assert.equal(state1.workspace, "branch");
  assert.equal(state1.model, "flash");
  assert.match(state1.loop_id, /^lp_\d{8}T\d{6}Z_[0-9a-f]{4}$/);
  assert.match(state1.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(state1.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const stateRoot = path.join(workspace, ".agents", ".agy-loop");
  assert.equal(fs.readFileSync(path.join(stateRoot, ".gitignore"), "utf8"), "*\n");
  const loopDir1 = path.join(stateRoot, "loops", state1.loop_id);
  assert.equal(fs.existsSync(path.join(loopDir1, "state.json")), true);
  assert.equal(fs.existsSync(path.join(loopDir1, "events.jsonl")), true);

  // 2. Adversarial shell metacharacters in state-update --stdin + CLI flags
  const pwnPath = path.join(workspace, "state-pwned");
  const advSummary = `Passed $(touch "${pwnPath}") & \`id\` $HOME 'single' "double"\nsecond line`;
  const advHint = `Inspect $(echo nope) && \`uname\` "next"\nhint line 2`;
  const updateRes = runHelper(
    [
      "state-update",
      workspace,
      state1.loop_id,
      "--stdin",
      "--increment-iteration",
      "--increment-errors",
      "--task-id",
      "task-42",
      "--worker-id",
      "conv-99",
      "--worktree-branch",
      "feat/fix-ci",
    ],
    envWithMockAgy,
    JSON.stringify({
      last_status: "CONTINUE",
      last_delay_sec: 30,
      last_summary: advSummary,
      next_hint: advHint,
      event: "iteration_complete",
    })
  );
  assert.equal(updateRes.status, 0, updateRes.stdout + updateRes.stderr);
  assert.equal(fs.existsSync(pwnPath), false, "Adversarial command substitution must not execute");

  const readRes = runHelper(["state-read", workspace, state1.loop_id]);
  assert.equal(readRes.status, 0, readRes.stderr);
  const readState1 = JSON.parse(readRes.stdout);
  assert.equal(readState1.iteration, 2);
  assert.equal(readState1.consecutive_errors, 1);
  assert.equal(readState1.task_id, "task-42");
  assert.equal(readState1.worker_id, "conv-99");
  assert.equal(readState1.worktree_branch, "feat/fix-ci");
  assert.equal(readState1.last_summary, advSummary);
  assert.equal(readState1.next_hint, advHint);

  const resetErrRes = runHelper(["state-update", workspace, state1.loop_id, "--reset-errors"]);
  assert.equal(resetErrRes.status, 0, resetErrRes.stderr);
  assert.equal(JSON.parse(resetErrRes.stdout).consecutive_errors, 0);

  const eventsLines = fs
    .readFileSync(path.join(loopDir1, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(eventsLines.length >= 2);
  assert.equal(eventsLines[0].event, "init");
  assert.equal(eventsLines[1].event, "iteration_complete");

  // git status --porcelain must remain completely empty after state-init + state-update
  const gitStatus = runGit(["status", "--porcelain"]);
  assert.equal(gitStatus.status, 0, gitStatus.stderr);
  assert.equal(gitStatus.stdout, "", `Expected clean git working tree, got:\n${gitStatus.stdout}`);

  // 3. state-list (--active vs --all) and state-stop (--after-current, single id, all)
  const run2Json = runHelper(["parse", "1m build check"]).stdout;
  const state2 = JSON.parse(runHelper(["state-init", workspace, "--stdin"], envWithMockAgy, run2Json).stdout);
  const state3 = JSON.parse(runHelper(["state-init", workspace, "--stdin"], envWithMockAgy, run2Json).stdout);

  const stopAfterRes = runHelper(["state-stop", workspace, state1.loop_id, "--after-current"]);
  assert.equal(stopAfterRes.status, 0, stopAfterRes.stderr);
  const stopAfterJson = JSON.parse(stopAfterRes.stdout);
  assert.equal(stopAfterJson.stopped.length, 1);
  assert.equal(stopAfterJson.stopped[0].status, "running");
  assert.equal(stopAfterJson.stopped[0].stop_requested, true);
  assert.equal(stopAfterJson.stopped[0].stop_mode, "after_current");

  const stopNowRes = runHelper(["state-stop", workspace, state1.loop_id]);
  assert.equal(stopNowRes.status, 0, stopNowRes.stderr);
  const stopNowJson = JSON.parse(stopNowRes.stdout);
  assert.equal(stopNowJson.stopped.length, 1);
  assert.equal(stopNowJson.stopped[0].status, "stopped");
  assert.equal(stopNowJson.stopped[0].stop_mode, "immediate");

  const listActive = JSON.parse(runHelper(["state-list", workspace, "--active"]).stdout);
  assert.equal(listActive.loops.length, 2);
  assert.equal(listActive.loops.some((l) => l.loop_id === state1.loop_id), false);
  assert.equal(listActive.loops.some((l) => l.loop_id === state2.loop_id), true);
  assert.equal(listActive.loops.some((l) => l.loop_id === state3.loop_id), true);

  const listAll = JSON.parse(runHelper(["state-list", workspace, "--all"]).stdout);
  assert.equal(listAll.loops.length, 3);

  const stopAllRes = runHelper(["state-stop", workspace, "all"]);
  assert.equal(stopAllRes.status, 0, stopAllRes.stderr);
  assert.equal(JSON.parse(stopAllRes.stdout).stopped.length, 2);
  assert.equal(JSON.parse(runHelper(["state-list", workspace, "--active"]).stdout).loops.length, 0);

  // 4. Path traversal & invalid loop_id rejection
  for (const badId of ["../escape", "badid"]) {
    for (const subcmd of [
      ["state-read", workspace, badId],
      ["state-update", workspace, badId, "--increment-errors"],
      ["state-stop", workspace, badId],
    ]) {
      const badRes = runHelper(subcmd);
      assert.equal(badRes.status, 2, `Expected exit 2 for ${subcmd.join(" ")}`);
      assert.ok(JSON.parse(badRes.stdout).error);
    }
  }

  // 5. AGY_LOOP_STATE_DIR override
  const customStateDir = path.join(root, "custom-state-store");
  const cleanWs = path.join(root, "clean-ws");
  fs.mkdirSync(cleanWs, { recursive: true });
  const envOverride = { ...envWithMockAgy, AGY_LOOP_STATE_DIR: customStateDir };

  const ovInit = runHelper(["state-init", cleanWs, "--stdin"], envOverride, run2Json);
  assert.equal(ovInit.status, 0, ovInit.stderr);
  const ovState = JSON.parse(ovInit.stdout);
  assert.equal(fs.existsSync(path.join(cleanWs, ".agents", ".agy-loop")), false);
  assert.equal(
    fs.existsSync(path.join(customStateDir, "loops", ovState.loop_id, "state.json")),
    true
  );
  const ovList = JSON.parse(runHelper(["state-list", cleanWs, "--active"], envOverride).stdout);
  assert.equal(ovList.loops.length, 1);
  assert.equal(ovList.loops[0].loop_id, ovState.loop_id);

  // 6. Preserve exit code 2 on state-init, state-update, and state-stop errors
  const badInitJson = runHelper(["state-init", cleanWs, "--stdin"], envWithMockAgy, "{invalid");
  assert.equal(badInitJson.status, 2);
  assert.ok(JSON.parse(badInitJson.stdout).error);

  const badInitAction = runHelper(
    ["state-init", cleanWs, "--stdin"],
    envWithMockAgy,
    JSON.stringify({ action: "status" })
  );
  assert.equal(badInitAction.status, 2);
  assert.ok(JSON.parse(badInitAction.stdout).error);

  const cleanLoopRes = runHelper(["state-init", cleanWs, "--stdin"], envWithMockAgy, run2Json);
  assert.equal(cleanLoopRes.status, 0, cleanLoopRes.stderr);
  const cleanLoop = JSON.parse(cleanLoopRes.stdout);

  for (const [args, stdinPayload] of [
    [["state-update", cleanWs, cleanLoop.loop_id, "--status", "bogus"], undefined],
    [["state-update", cleanWs, cleanLoop.loop_id, "--unknown-flag"], undefined],
    [["state-update", cleanWs, cleanLoop.loop_id, "--stdin"], "not-json"],
  ]) {
    const updErr = runHelper(args, envWithMockAgy, stdinPayload);
    assert.equal(updErr.status, 2, `Expected exit 2 for ${args.join(" ")}`);
    assert.ok(JSON.parse(updErr.stdout).error);
  }

  const corruptId = "lp_20261121T000000Z_dead";
  const corruptDir = path.join(cleanWs, ".agents", ".agy-loop", "loops", corruptId);
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, "state.json"), "{corrupt");
  const stopCorruptRes = runHelper(["state-stop", cleanWs, corruptId]);
  assert.equal(stopCorruptRes.status, 2);
  assert.ok(JSON.parse(stopCorruptRes.stdout).error);

  // 7. state-stop with glob-metacharacter workspace directory (ws[1] alongside sibling ws1)
  const globRoot = path.join(root, "glob-test");
  const wsBracket = path.join(globRoot, "ws[1]");
  const wsSibling = path.join(globRoot, "ws1");
  fs.mkdirSync(wsBracket, { recursive: true });
  fs.mkdirSync(wsSibling, { recursive: true });

  const brInitRes = runHelper(["state-init", wsBracket, "--stdin"], envWithMockAgy, run2Json);
  assert.equal(brInitRes.status, 0, brInitRes.stderr);
  const brLoop = JSON.parse(brInitRes.stdout);

  // Create identical loop_id state in sibling ws1 to prove ws[1] never globs into ws1
  const siblingLoopDir = path.join(wsSibling, ".agents", ".agy-loop", "loops", brLoop.loop_id);
  fs.mkdirSync(siblingLoopDir, { recursive: true });
  fs.writeFileSync(
    path.join(siblingLoopDir, "state.json"),
    JSON.stringify({ ...brLoop, workspace_dir: wsSibling }) + "\n"
  );

  const stopBrSingle = runHelper(["state-stop", wsBracket, brLoop.loop_id]);
  assert.equal(stopBrSingle.status, 0, stopBrSingle.stderr);
  assert.equal(JSON.parse(stopBrSingle.stdout).stopped.length, 1);
  assert.equal(JSON.parse(runHelper(["state-list", wsBracket, "--active"]).stdout).loops.length, 0);
  assert.equal(JSON.parse(runHelper(["state-list", wsSibling, "--active"]).stdout).loops.length, 1);

  const brInit2 = JSON.parse(runHelper(["state-init", wsBracket, "--stdin"], envWithMockAgy, run2Json).stdout);
  const stopBrAll = runHelper(["state-stop", wsBracket, "all"]);
  assert.equal(stopBrAll.status, 0, stopBrAll.stderr);
  assert.equal(JSON.parse(stopBrAll.stdout).stopped.length, 1);
  assert.equal(JSON.parse(stopBrAll.stdout).stopped[0].loop_id, brInit2.loop_id);
  assert.equal(JSON.parse(runHelper(["state-list", wsBracket, "--active"]).stdout).loops.length, 0);
  assert.equal(JSON.parse(runHelper(["state-list", wsSibling, "--active"]).stdout).loops.length, 1);
});

test("v1.1 3-way UTC backup parity, skills.json regex matrix, SessionStart protojson, and upgraded doctor diagnostics", (t) => {
  const { root, home, workspace, envWithMockAgy } = makeSandbox(t);
  const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");
  const installSh = path.join(REPO_ROOT, "install.sh");
  const utcBackupRegex = /^\.agy-loop-backup-\d{8}-\d{6}Z$/;

  // 1. UTC backup timestamp parity across bin/agy-loop.mjs, loop-helper.sh, and install.sh
  const seedShadow = (targetHome) => {
    const dir = path.join(targetHome, ".gemini", "config", "skills", "loop");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), "shadow\n");
  };

  // 1a. bin/agy-loop.mjs
  const sbCli = makeSandbox(t);
  seedShadow(sbCli.home);
  const cliClean = spawnSync(process.execPath, [cliPath, "doctor", "--clean-shadow", "--json"], {
    cwd: sbCli.workspace,
    env: sbCli.envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(cliClean.status, 0, cliClean.stderr);
  assert.match(path.basename(JSON.parse(cliClean.stdout).backupDir), utcBackupRegex);

  // 1b. loop-helper.sh
  const sbHelper = makeSandbox(t);
  seedShadow(sbHelper.home);
  const helperClean = spawnSync("sh", [helperShPath, "doctor", "--clean-shadow", sbHelper.workspace], {
    cwd: sbHelper.workspace,
    env: sbHelper.envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(helperClean.status, 0, helperClean.stderr);
  assert.match(path.basename(JSON.parse(helperClean.stdout).backup_dir), utcBackupRegex);

  // 1c. install.sh
  const sbInstall = makeSandbox(t);
  seedShadow(sbInstall.home);
  const shClean = spawnSync("sh", [installSh, "--clean-shadow"], {
    cwd: sbInstall.workspace,
    env: sbInstall.envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(shClean.status, 0, shClean.stderr);
  const installBackups = fs
    .readdirSync(path.join(sbInstall.home, ".gemini", "config"))
    .filter((n) => n.startsWith(".agy-loop-backup-"));
  assert.equal(installBackups.length, 1);
  assert.match(installBackups[0], utcBackupRegex);

  // 2. skills.json regex & depth parity across bin/agy-loop.mjs and loop-helper.sh
  assert.equal(
    spawnSync(process.execPath, [cliPath, "install", "--json"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    }).status,
    0
  );

  fs.mkdirSync(path.join(workspace, ".agents"), { recursive: true });
  const skillsJsonPath = path.join(workspace, ".agents", "skills.json");
  const regexParityMatrix = [
    {
      name: "include_only ^loop$",
      content: JSON.stringify({ include_only: ["^loop$"] }),
      expectWarning: false,
    },
    {
      name: "exclude ^loop$",
      content: JSON.stringify({ exclude: ["^loop$"] }),
      expectWarning: true,
    },
    {
      name: "include_only agy-.*",
      content: JSON.stringify({ include_only: ["agy-.*"] }),
      expectWarning: false,
    },
    {
      name: "exclude agy-.*",
      content: JSON.stringify({ exclude: ["agy-.*"] }),
      expectWarning: true,
    },
    {
      name: "include_only (foo|loop)",
      content: JSON.stringify({ include_only: ["(foo|loop)"] }),
      expectWarning: false,
    },
    {
      name: "exclude (foo|loop)",
      content: JSON.stringify({ exclude: ["(foo|loop)"] }),
      expectWarning: true,
    },
    {
      name: "nested unrelated include_only/exclude ignored",
      content: JSON.stringify({
        nested: { deep: { include_only: ["lint"], exclude: ["loop"] } },
        entries: [{ path: "skills", metadata: { exclude: ["loop"] } }],
      }),
      expectWarning: false,
    },
    {
      name: "malformed regexes in include_only do not crash awk",
      content: JSON.stringify({ include_only: ["[", "(", "*bad"] }),
      expectWarning: true,
    },
    {
      name: "malformed regexes in exclude do not crash awk",
      content: JSON.stringify({ exclude: ["[", "(", "*bad"] }),
      expectWarning: false,
    },
    {
      name: "escaped caret class [\\^] in exclude does not crash awk or match",
      content: JSON.stringify({ exclude: ["[\\^]"] }),
      expectWarning: false,
    },
    {
      name: "escaped caret class [\\^a]oop in exclude does not invert or match loop",
      content: JSON.stringify({ exclude: ["[\\^a]oop"] }),
      expectWarning: false,
    },
    {
      name: "escaped caret class [\\^a]oop in include_only omits loop",
      content: JSON.stringify({ include_only: ["[\\^a]oop"] }),
      expectWarning: true,
    },
    {
      name: "large bounded quantifier l{300} in exclude does not crash RE_DUP_MAX",
      content: JSON.stringify({ exclude: ["l{300}"] }),
      expectWarning: false,
    },
  ];

  for (const sc of regexParityMatrix) {
    fs.writeFileSync(skillsJsonPath, sc.content);
    const cliRes = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(cliRes.status, 0, `${sc.name}: ${cliRes.stderr}`);
    const cliDoc = JSON.parse(cliRes.stdout);
    assert.equal(
      cliDoc.skillFilterWarnings.length > 0,
      sc.expectWarning,
      `bin/agy-loop.mjs mismatch for ${sc.name}`
    );

    const helperRes = spawnSync("sh", [helperShPath, "doctor", workspace], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(helperRes.status, 0, `${sc.name}: ${helperRes.stderr}`);
    const helperDoc = JSON.parse(helperRes.stdout);
    assert.equal(
      helperDoc.skill_filter_warnings.length > 0,
      sc.expectWarning,
      `loop-helper.sh mismatch for ${sc.name}`
    );
  }
  fs.rmSync(skillsJsonPath, { force: true });

  // 3. SessionStart hook with full agy v1.5.13 stdin payload (strict protojson, zero leaked keys)
  const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
  const sessionStartCmd = hooksConfig["agy-loop-shadow-check"].SessionStart[0].command;
  const v1513Stdin = JSON.stringify({
    artifactDirectoryPath: path.join(home, ".gemini", "antigravity-cli", "brain", "conv-1513"),
    conversationId: "00000000-0000-0000-0000-000000001513",
    hookEventName: "SessionStart",
    modelName: "gemini-4-neon-xhigh",
    lastUserInput: "SENTINEL_USER_INPUT_NEVER_LEAK",
    cwd: workspace,
    workspacePaths: [workspace],
  });
  const runSessionStart = () =>
    spawnSync("sh", ["-c", sessionStartCmd], {
      cwd: REPO_ROOT,
      env: { ...envWithMockAgy, PLUGIN_ROOT: REPO_ROOT },
      input: v1513Stdin,
      encoding: "utf8",
    });
  const assertNoLeakedStdin = (rawStdout, parsed) => {
    for (const key of [
      "artifactDirectoryPath",
      "conversationId",
      "hookEventName",
      "modelName",
      "lastUserInput",
      "cwd",
      "workspacePaths",
    ]) {
      assert.equal(key in parsed, false, `SessionStart leaked stdin key '${key}'`);
    }
    assert.equal(rawStdout.includes("SENTINEL_USER_INPUT_NEVER_LEAK"), false);
  };

  // 3a. Clean -> {}
  const ssClean = runSessionStart();
  assert.equal(ssClean.status, 0, ssClean.stderr);
  const ssCleanJson = JSON.parse(ssClean.stdout);
  assert.deepEqual(ssCleanJson, {});
  assertNoLeakedStdin(ssClean.stdout, ssCleanJson);

  // 3b. skills.json block only (no shadows) -> injectSteps warning about skills.json
  fs.writeFileSync(skillsJsonPath, JSON.stringify({ include_only: ["lint"] }));
  const ssFilterOnly = runSessionStart();
  assert.equal(ssFilterOnly.status, 0, ssFilterOnly.stderr);
  const ssFilterJson = JSON.parse(ssFilterOnly.stdout);
  assert.deepEqual(Object.keys(ssFilterJson), ["injectSteps"]);
  assert.equal(ssFilterJson.injectSteps.length, 1);
  assert.match(ssFilterJson.injectSteps[0].systemMessage.systemMessage, /skills\.json/);
  assertNoLeakedStdin(ssFilterOnly.stdout, ssFilterJson);

  // 3c. Shadows + skills.json -> emits both warnings with zero leaked stdin keys
  const shadowSkill = path.join(home, ".gemini", "config", "skills", "loop");
  fs.mkdirSync(shadowSkill, { recursive: true });
  fs.writeFileSync(path.join(shadowSkill, "SKILL.md"), "shadow\n");
  const ssBoth = runSessionStart();
  assert.equal(ssBoth.status, 0, ssBoth.stderr);
  const ssBothJson = JSON.parse(ssBoth.stdout);
  assert.deepEqual(Object.keys(ssBothJson), ["injectSteps"]);
  const bothText = ssBothJson.injectSteps[0].systemMessage.systemMessage;
  assert.match(bothText, /Shadow warning/);
  assert.match(bothText, /skills\.json/);
  assertNoLeakedStdin(ssBoth.stdout, ssBothJson);

  fs.rmSync(shadowSkill, { recursive: true, force: true });
  fs.rmSync(skillsJsonPath, { force: true });

  // 3d. #27 #2 edge regexes ([\^], [\^a]oop, l{300}, [[:lower:]]+) keep SessionStart protojson & doctor crash-free
  for (const [pat, expectedSessionSteps] of [
    ["[\\^]", false],
    ["[\\^a]oop", false],
    ["l{300}", false],
    ["[[:lower:]]+", true],
  ]) {
    fs.writeFileSync(skillsJsonPath, JSON.stringify({ exclude: [pat] }));
    const ssEdge = runSessionStart();
    assert.equal(ssEdge.status, 0, `SessionStart crashed for exclude '${pat}': ${ssEdge.stderr}`);
    const ssEdgeJson = JSON.parse(ssEdge.stdout);
    assertNoLeakedStdin(ssEdge.stdout, ssEdgeJson);
    if (expectedSessionSteps) {
      assert.deepEqual(Object.keys(ssEdgeJson), ["injectSteps"]);
    } else {
      assert.deepEqual(ssEdgeJson, {});
    }

    const helperEdge = spawnSync("sh", [helperShPath, "doctor", workspace], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(helperEdge.status, 0, `doctor crashed for exclude '${pat}': ${helperEdge.stderr}`);
    assert.equal(JSON.parse(helperEdge.stdout).skill_filter_warnings.length > 0, expectedSessionSteps);

    const cliEdge = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(cliEdge.status, 0, cliEdge.stderr);
  }

  fs.writeFileSync(skillsJsonPath, JSON.stringify({ include_only: ["[[:lower:]]+"] }));
  const ssLowerInc = runSessionStart();
  assert.equal(ssLowerInc.status, 0, ssLowerInc.stderr);
  assert.deepEqual(JSON.parse(ssLowerInc.stdout), {});
  const helperLowerInc = spawnSync("sh", [helperShPath, "doctor", workspace], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  });
  assert.equal(helperLowerInc.status, 0, helperLowerInc.stderr);
  assert.deepEqual(JSON.parse(helperLowerInc.stdout).skill_filter_warnings, []);

  fs.rmSync(skillsJsonPath, { force: true });

  // 4. Upgraded bin/agy-loop.mjs doctor --json checks
  // 4a. Capabilities matrix for mock agy 1.5.9 vs 1.5.13 + hookSelfTest + agentToolsCheck + activeLoops
  const activeRun = spawnSync("sh", [helperShPath, "parse", "1m run checks"], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  }).stdout;
  const activeLoop = JSON.parse(
    spawnSync("sh", [helperShPath, "state-init", workspace, "--stdin"], {
      cwd: workspace,
      env: envWithMockAgy,
      input: activeRun,
      encoding: "utf8",
    }).stdout
  );

  const doc159 = JSON.parse(
    spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: { ...envWithMockAgy, MOCK_AGY_VERSION: "1.5.9" },
      encoding: "utf8",
    }).stdout
  );
  assert.equal(doc159.ok, true);
  assert.equal(doc159.agy.capabilities.parsedVersion, "1.5.9");
  assert.equal(doc159.agy.capabilities.dynamicWorkflows, true);
  assert.equal(doc159.agy.capabilities.githubUrlValidate, false);
  assert.equal(doc159.agy.capabilities.strictProtojsonHooks, false);
  assert.equal(doc159.hookSelfTest.ok, true);
  assert.equal(doc159.agentToolsCheck.ok, true);
  assert.equal(doc159.verifierToolsCheck.ok, true);
  assert.equal(doc159.workflowBundleCheck.ok, true);
  assert.equal(doc159.activeLoops.length, 1);
  assert.equal(doc159.activeLoops[0].loopId, activeLoop.loop_id);

  const doc1513 = JSON.parse(
    spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: { ...envWithMockAgy, MOCK_AGY_VERSION: "1.5.13" },
      encoding: "utf8",
    }).stdout
  );
  assert.equal(doc1513.ok, true);
  assert.equal(doc1513.agy.capabilities.parsedVersion, "1.5.13");
  assert.equal(doc1513.agy.capabilities.githubUrlValidate, true);
  assert.equal(doc1513.agy.capabilities.strictProtojsonHooks, true);

  // 4b. admin_settings.json pluginsDisabled: true -> ok: false + warning
  const adminSettingsPath = path.join(home, ".gemini", "config", "admin_settings.json");
  fs.mkdirSync(path.dirname(adminSettingsPath), { recursive: true });
  fs.writeFileSync(
    adminSettingsPath,
    JSON.stringify({ pluginControls: { pluginsDisabled: true } })
  );
  const docAdmin = JSON.parse(
    spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    }).stdout
  );
  assert.equal(docAdmin.ok, false);
  assert.equal(docAdmin.environment.adminSettings.pluginsDisabled, true);
  assert.ok(docAdmin.environmentWarnings.some((w) => /pluginsDisabled/.test(w)));
  fs.rmSync(adminSettingsPath, { force: true });

  // 4c. settings.json toolPermission: "strict" + secrets never echoed
  const cliSettingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(cliSettingsPath), { recursive: true });
  fs.writeFileSync(
    cliSettingsPath,
    JSON.stringify({
      toolPermission: "strict",
      apiKey: "SECRET_SHOULD_NEVER_LEAK_1",
      oauthToken: "SECRET_SHOULD_NEVER_LEAK_2",
    })
  );
  const docSettingsRaw = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: workspace,
    env: envWithMockAgy,
    encoding: "utf8",
  }).stdout;
  assert.equal(docSettingsRaw.includes("SECRET_SHOULD_NEVER_LEAK"), false);
  const docSettings = JSON.parse(docSettingsRaw);
  assert.equal(docSettings.environment.cliSettings.toolPermission, "strict");
  assert.ok(docSettings.environmentWarnings.some((w) => /toolPermission="strict"/.test(w)));
  fs.rmSync(cliSettingsPath, { force: true });

  // 4c-ii. Malformed settings.json and admin_settings.json never echo raw secret tokens via JSON.parse() excerpts
  fs.writeFileSync(cliSettingsPath, '{"apiKey": SECRET_RAW_TOKEN_XYZ');
  fs.mkdirSync(path.dirname(adminSettingsPath), { recursive: true });
  fs.writeFileSync(adminSettingsPath, '{"gatewaySecret": ADMIN_SECRET_ABC_999');
  for (const args of [
    ["doctor", "--json"],
    ["doctor"],
  ]) {
    const malformedDoc = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });
    assert.equal(malformedDoc.status, 0, malformedDoc.stderr);
    const combinedOut = `${malformedDoc.stdout}\n${malformedDoc.stderr}`;
    assert.equal(combinedOut.includes("SECRET_RAW_TOKEN_XYZ"), false);
    assert.equal(combinedOut.includes("ADMIN_SECRET_ABC_999"), false);
    assert.match(combinedOut, /syntax details redacted/);
    if (args.includes("--json")) {
      const parsedMal = JSON.parse(malformedDoc.stdout);
      assert.ok(parsedMal.environmentWarnings.some((w) => /CLI settings/.test(w)));
      assert.ok(parsedMal.environmentWarnings.some((w) => /Admin settings/.test(w)));
    }
  }
  fs.rmSync(cliSettingsPath, { force: true });
  fs.rmSync(adminSettingsPath, { force: true });

  // 4d. User hooks.json flat PreToolUse triggers advisory warning
  const userHooksPath = path.join(home, ".gemini", "config", "hooks.json");
  fs.writeFileSync(
    userHooksPath,
    JSON.stringify({ PreToolUse: [{ type: "command", command: "echo flat" }] })
  );
  const docFlatHooks = JSON.parse(
    spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    }).stdout
  );
  assert.equal(docFlatHooks.environment.hooksFiles.user.valid, false);
  assert.ok(docFlatHooks.environmentWarnings.some((w) => /PreToolUse/.test(w)));
  fs.rmSync(userHooksPath, { force: true });

  // 4e. runAgy timeout handling via sleeping mock agy + small AGY_LOOP_AGY_TIMEOUT_MS
  const timeoutRes = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: workspace,
    env: {
      ...envWithMockAgy,
      MOCK_AGY_SLEEP_MS: "2000",
      AGY_LOOP_AGY_TIMEOUT_MS: "100",
    },
    encoding: "utf8",
  });
  assert.equal(timeoutRes.status, 124, timeoutRes.stderr);
  const timeoutJson = JSON.parse(timeoutRes.stdout);
  assert.equal(timeoutJson.ok, false);
  assert.equal(timeoutJson.timedOut, true);
  assert.equal(timeoutJson.agy.timedOut, true);
});

test("agents/loop-verifier.md enforces model: pro, sandbox, strict read-only tools, and fail-closed contract", () => {
  assert.equal(fs.existsSync(verifierAgentMdPath), true, "agents/loop-verifier.md must exist");
  const raw = fs.readFileSync(verifierAgentMdPath, "utf8");
  const { rawFrontmatter, body } = parseFrontmatter(raw);

  assert.match(rawFrontmatter, /^name:\s*["']?loop-verifier["']?\s*$/m);
  assert.match(rawFrontmatter, /^subagent:\s*true\s*$/m);
  assert.match(rawFrontmatter, /^mainAgent:\s*false\s*$/m);
  assert.match(rawFrontmatter, /^model:\s*["']?pro["']?\s*$/m);
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

  const READ_ONLY_VERIFIER_TOOLS = ["view_file", "run_command", "search_web"];
  const WRITE_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content"];
  assert.deepEqual([...toolLines].sort(), [...READ_ONLY_VERIFIER_TOOLS].sort());
  for (const t of toolLines) {
    assert.ok(VERIFIED_CORTEX_TOOLS.has(t), `Unverified tool '${t}' in loop-verifier.md`);
    assert.equal(BROKEN_ONEHARNESS_TOOLS.includes(t), false);
    assert.equal(WRITE_TOOLS.includes(t), false, `loop-verifier.md must NOT declare write tool '${t}'`);
  }

  assert.match(body, /"passed":\s*true/);
  assert.match(body, /"summary":/);
  assert.match(body, /"issues":/);
  assert.match(body, /read-only/i);
});

test("loop-helper.sh v1.3 parser flags, engine auto-routing, conflicts, nudge/wake, inbox-push, and dual-write state-stop", (t) => {
  const { workspace, envWithMockAgy } = makeSandbox(t);
  const runHelper = (args, stdinText = undefined) =>
    spawnSync("sh", [helperShPath, ...args], {
      cwd: workspace,
      env: envWithMockAgy,
      input: stdinText,
      encoding: "utf8",
    });

  // 1. Auto-routing: plain loop -> schedule; workflow flag or --engine workflow -> workflow
  const schedDefault = JSON.parse(runHelper(["parse", "30s check ci"]).stdout);
  assert.equal(schedDefault.engine, "schedule");
  assert.equal(schedDefault.verify, false);
  assert.deepEqual(schedDefault.targets, []);

  const explicitSchedule = JSON.parse(runHelper(["parse", "--engine", "schedule", "30s check ci"]).stdout);
  assert.equal(explicitSchedule.engine, "schedule");

  const explicitWorkflow = JSON.parse(runHelper(["parse", "--engine=workflow", "30s check ci"]).stdout);
  assert.equal(explicitWorkflow.engine, "workflow");

  // #72 2.1: --verify-cmd="..." and --probe="..." preserve inner quotes without double-stripping
  const innerQuotesParsed = JSON.parse(
    runHelper([
      "parse",
      `--verify-cmd="'a' && 'b'" --probe="'echo' 'ok'" run inner quote check`,
    ]).stdout
  );
  assert.equal(innerQuotesParsed.verify_cmd, "'a' && 'b'");
  assert.equal(innerQuotesParsed.probe_cmd, "'echo' 'ok'");

  const innerQuotesStdin = JSON.parse(
    runHelper(
      ["parse", "--stdin"],
      `--verify-cmd="'a' && 'b'" --probe="'echo' 'ok'" run inner quote check`
    ).stdout
  );
  assert.equal(innerQuotesStdin.verify_cmd, "'a' && 'b'");
  assert.equal(innerQuotesStdin.probe_cmd, "'echo' 'ok'");

  const fullWf = JSON.parse(
    runHelper([
      "parse",
      '--stateful --reset-every 3 --verify --verifier-model=pro --verify-cmd="npm test" --verify-timeout 45s --probe "git status" --probe-timeout 15s --probe-until-pass --targets "pkg/a, pkg/b" --max-tokens 80000 --max-duration 2h fix CI',
    ]).stdout
  );
  assert.equal(fullWf.action, "run");
  assert.equal(fullWf.engine, "workflow");
  assert.equal(fullWf.state_mode, "stateful");
  assert.equal(fullWf.reset_every, 3);
  assert.equal(fullWf.verify, true);
  assert.equal(fullWf.verifier_model, "pro");
  assert.equal(fullWf.verify_cmd, "npm test");
  assert.equal(fullWf.verify_timeout_sec, 45);
  assert.equal(fullWf.probe_cmd, "git status");
  assert.equal(fullWf.probe_timeout_sec, 15);
  assert.equal(fullWf.probe_until_pass, true);
  assert.deepEqual(fullWf.targets, ["pkg/a", "pkg/b"]);
  assert.equal(fullWf.max_tokens, 80000);
  assert.equal(fullWf.max_duration_sec, 7200);
  assert.equal(fullWf.prompt, "fix CI");

  for (const wfTrigger of [
    "--verify check",
    "--verifier-model flash check",
    '--verify-cmd "true" check',
    '--probe "true" check',
    "--targets a,b check",
    "--max-tokens 1000 check",
    "--max-duration 10m check",
    "--stateful --reset-every 2 check",
  ]) {
    const parsed = JSON.parse(runHelper(["parse", wfTrigger]).stdout);
    assert.equal(parsed.engine, "workflow", `Expected engine=workflow for '${wfTrigger}'`);
  }

  // 2. All v1.3 conflict & invalid flag errors (Exit 2)
  const conflictInputs = [
    "5m check --cron --engine workflow",
    "5m check --exact --verify",
    "5m check --daemon --targets a,b",
    "check --engine schedule --verify",
    'check --engine schedule --verify-cmd "true"',
    'check --engine schedule --probe "true"',
    "check --engine schedule --targets a,b",
    "check --engine schedule --max-tokens 100",
    "check --engine schedule --max-duration 5m",
    "check --engine schedule --stateful --reset-every 2",
    "check --reset-every 2",
    "check --probe-until-pass",
    "check --engine bogus",
    "check --verifier-model ultra",
    'check --verify-cmd ""',
    "check --verify-timeout 0s",
    "check --probe-timeout 1.5m",
    "check --verify-timeout 30s --engine schedule",
    "check --probe-timeout 30s --engine schedule",
    "check --verify-timeout 30s",
    "check --probe-timeout 30s",
    'check --targets ""',
    "check --targets a,,b",
    "check --max-tokens 0",
    "check --max-duration 0m",
    "check --verify=true",
    "check --probe-until-pass=true",
    "check --verify-command true",
  ];
  for (const bad of conflictInputs) {
    const res = runHelper(["parse", bad]);
    assert.equal(res.status, 2, `Expected exit 2 for '${bad}', got ${res.status}: ${res.stdout}`);
    assert.ok(JSON.parse(res.stdout).error);
  }

  // 3. nudge / wake parse actions
  const nudgeParsed = JSON.parse(runHelper(["parse", "nudge latest check auth --wake"]).stdout);
  assert.deepEqual(nudgeParsed, {
    action: "nudge",
    target: "latest",
    message: "check auth",
    wake: true,
  });

  const nudgeQuoted = JSON.parse(
    runHelper(["parse", 'nudge lp_20261122T000000Z_aaaa "check $(id)"']).stdout
  );
  assert.equal(nudgeQuoted.action, "nudge");
  assert.equal(nudgeQuoted.target, "lp_20261122T000000Z_aaaa");
  assert.equal(nudgeQuoted.message, "check $(id)");
  assert.equal(nudgeQuoted.wake, false);

  const wakeParsed = JSON.parse(runHelper(["parse", "/agy-loop:loop wake latest"]).stdout);
  assert.deepEqual(wakeParsed, { action: "wake", target: "latest" });

  for (const badNw of ["nudge", "nudge latest", "nudge --bad latest hi", "wake", "wake a b", "wake --bad"]) {
    const res = runHelper(["parse", badNw]);
    assert.equal(res.status, 2, `Expected exit 2 for '${badNw}'`);
    assert.ok(JSON.parse(res.stdout).error);
  }

  // 4. inbox-push atomic enqueue + latest resolution + state-stop dual write & field preservation
  const wfParseJson = runHelper([
    "parse",
    '--verify --verify-cmd "npm test" --targets api,web --max-tokens 5000 run tests',
  ]).stdout;
  const st1 = JSON.parse(runHelper(["state-init", workspace, "--stdin"], wfParseJson).stdout);
  assert.equal(st1.engine, "workflow");
  assert.equal(st1.verify, true);
  assert.equal(st1.verify_cmd, "npm test");
  assert.deepEqual(st1.targets, ["api", "web"]);
  assert.equal(st1.max_tokens, 5000);

  // Add extra custom fields to st1 to verify state-stop preserves them
  const st1Path = path.join(workspace, ".agents", ".agy-loop", "loops", st1.loop_id, "state.json");
  const st1Data = JSON.parse(fs.readFileSync(st1Path, "utf8"));
  st1Data.usage_totals = { total_tokens: 321 };
  fs.writeFileSync(st1Path, JSON.stringify(st1Data) + "\n", "utf8");

  // Create second running loop (stopped shortly) so `latest` picks active running st1
  const st2 = JSON.parse(runHelper(["state-init", workspace, "--stdin"], wfParseJson).stdout);
  assert.equal(runHelper(["state-stop", workspace, st2.loop_id]).status, 0);

  // #72 2.2: Create running schedule loop and dead-PID headless loop; inbox-push must reject both & `latest` picks active workflow st1
  const schedParseJson = runHelper(["parse", "30s schedule only"]).stdout;
  const stSched = JSON.parse(runHelper(["state-init", workspace, "--stdin"], schedParseJson).stdout);
  const stDeadHeadless = JSON.parse(runHelper(["state-init", workspace, "--stdin"], wfParseJson).stdout);
  const stDeadPath = path.join(workspace, ".agents", ".agy-loop", "loops", stDeadHeadless.loop_id, "state.json");
  const stDeadObj = JSON.parse(fs.readFileSync(stDeadPath, "utf8"));
  stDeadObj.engine = "headless";
  stDeadObj.pid = 99999999;
  stDeadObj.updated_at = "2099-01-01T00:00:00Z";
  fs.writeFileSync(stDeadPath, JSON.stringify(stDeadObj) + "\n", "utf8");

  const rejectSched = runHelper(["inbox-push", workspace, stSched.loop_id, "wake"]);
  assert.equal(rejectSched.status, 2);
  assert.match(JSON.parse(rejectSched.stdout).error, /do not consume inbox/i);

  const rejectDead = runHelper(["inbox-push", workspace, stDeadHeadless.loop_id, "wake"]);
  assert.equal(rejectDead.status, 2);
  assert.match(JSON.parse(rejectDead.stdout).error, /not alive/i);

  // Check st2 dual-wrote control.json and inbox/ stop message
  const loopDir2 = path.join(workspace, ".agents", ".agy-loop", "loops", st2.loop_id);
  const ctrl2 = JSON.parse(fs.readFileSync(path.join(loopDir2, "control.json"), "utf8"));
  assert.equal(ctrl2.stop_requested, true);
  assert.equal(ctrl2.mode, "immediate");
  const inboxFiles2 = fs.readdirSync(path.join(loopDir2, "inbox")).filter((f) => f.endsWith(".json"));
  assert.equal(inboxFiles2.length, 1);
  const inboxStop2 = JSON.parse(fs.readFileSync(path.join(loopDir2, "inbox", inboxFiles2[0]), "utf8"));
  assert.equal(inboxStop2.type, "stop");
  assert.equal(inboxStop2.mode, "immediate");

  // inbox-push latest nudge --wake --stdin (metacharacters untouched, resolves to active st1)
  const pwnMarker = path.join(workspace, "inbox-pwned");
  const pushNudge = runHelper(
    ["inbox-push", workspace, "latest", "nudge", "--wake", "--stdin"],
    `Inspect $(touch ${pwnMarker}) & \`id\``
  );
  assert.equal(pushNudge.status, 0, pushNudge.stdout + pushNudge.stderr);
  assert.equal(fs.existsSync(pwnMarker), false);
  const pushNudgeJson = JSON.parse(pushNudge.stdout);
  assert.equal(pushNudgeJson.ok, true);
  assert.equal(pushNudgeJson.loop_id, st1.loop_id);
  assert.equal(pushNudgeJson.type, "nudge");
  assert.equal(fs.existsSync(pushNudgeJson.file), true);
  const pushedNudgeObj = JSON.parse(fs.readFileSync(pushNudgeJson.file, "utf8"));
  assert.equal(pushedNudgeObj.type, "nudge");
  assert.equal(pushedNudgeObj.wake, true);
  assert.match(pushedNudgeObj.message, /\$\(touch/);

  const pushWake = runHelper(["inbox-push", workspace, st1.loop_id, "wake", "--message", "go"]);
  assert.equal(pushWake.status, 0, pushWake.stdout + pushWake.stderr);
  const pushWakeJson = JSON.parse(pushWake.stdout);
  assert.equal(pushWakeJson.type, "wake");
  assert.equal(JSON.parse(fs.readFileSync(pushWakeJson.file, "utf8")).reason, "go");

  // Also verify live-PID headless loop beats older st1 on `latest`
  const stLiveHeadless = JSON.parse(runHelper(["state-init", workspace, "--stdin"], wfParseJson).stdout);
  const stLivePath = path.join(workspace, ".agents", ".agy-loop", "loops", stLiveHeadless.loop_id, "state.json");
  const stLiveObj = JSON.parse(fs.readFileSync(stLivePath, "utf8"));
  stLiveObj.engine = "headless";
  stLiveObj.pid = process.pid;
  stLiveObj.updated_at = "2098-01-01T00:00:00Z";
  fs.writeFileSync(stLivePath, JSON.stringify(stLiveObj) + "\n", "utf8");
  const pushLatestLive = runHelper(["inbox-push", workspace, "latest", "wake"]);
  assert.equal(pushLatestLive.status, 0, pushLatestLive.stdout + pushLatestLive.stderr);
  assert.equal(JSON.parse(pushLatestLive.stdout).loop_id, stLiveHeadless.loop_id);
  assert.equal(runHelper(["state-stop", workspace, stLiveHeadless.loop_id]).status, 0);

  // Reject inbox-push on stopped st2 or empty nudge message
  assert.equal(runHelper(["inbox-push", workspace, st2.loop_id, "wake"]).status, 2);
  assert.equal(runHelper(["inbox-push", workspace, st1.loop_id, "nudge"]).status, 2);
  assert.equal(runHelper(["inbox-push", workspace, st1.loop_id, "bogus"]).status, 2);

  // Stop st1 with --after-current and verify extra usage_totals survived + dual-write mode=after_current
  const stop1 = runHelper(["state-stop", workspace, st1.loop_id, "--after-current"]);
  assert.equal(stop1.status, 0, stop1.stderr);
  const st1After = JSON.parse(fs.readFileSync(st1Path, "utf8"));
  assert.deepEqual(st1After.usage_totals, { total_tokens: 321 });
  assert.equal(st1After.stop_mode, "after_current");
  const ctrl1 = JSON.parse(
    fs.readFileSync(path.join(workspace, ".agents", ".agy-loop", "loops", st1.loop_id, "control.json"), "utf8")
  );
  assert.equal(ctrl1.mode, "after_current");
});

test("doctor --json flips verifierToolsCheck and workflowBundleCheck to ok: false when broken in installed plugin dir", (t) => {
  const { home, workspace, envWithMockAgy } = makeSandbox(t);
  const cliPath = path.join(REPO_ROOT, "bin", "agy-loop.mjs");
  const runCli = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      cwd: workspace,
      env: envWithMockAgy,
      encoding: "utf8",
    });

  // Mark plugin installed at ${home}/.gemini/config/plugins/agy-loop
  assert.equal(runCli(["install", "--json"]).status, 0);
  const installedDir = path.join(home, ".gemini", "config", "plugins", "agy-loop");

  // Baseline ok (installedDir doesn't exist on disk yet, falls back to PLUGIN_ROOT)
  const baseDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(baseDoc.ok, true);
  assert.equal(baseDoc.verifierToolsCheck.ok, true);
  assert.equal(baseDoc.workflowBundleCheck.ok, true);

  // Seed complete valid installed plugin dir on disk first
  const installedWorker = path.join(installedDir, "agents", "loop-worker.md");
  const installedVerifier = path.join(installedDir, "agents", "loop-verifier.md");
  const installedWfDir = path.join(installedDir, "workflows", "loop-runner");
  fs.mkdirSync(path.dirname(installedWorker), { recursive: true });
  fs.mkdirSync(installedWfDir, { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, "agents", "loop-worker.md"), installedWorker);
  fs.copyFileSync(path.join(REPO_ROOT, "agents", "loop-verifier.md"), installedVerifier);
  fs.copyFileSync(path.join(REPO_ROOT, "workflows", "loop-runner", "workflow.json"), path.join(installedWfDir, "workflow.json"));
  fs.copyFileSync(path.join(REPO_ROOT, "workflows", "loop-runner", "workflow.py"), path.join(installedWfDir, "workflow.py"));

  const validInstalledDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(validInstalledDoc.ok, true);
  assert.equal(validInstalledDoc.agentToolsCheck.ok, true);
  assert.equal(validInstalledDoc.verifierToolsCheck.ok, true);
  assert.equal(validInstalledDoc.workflowBundleCheck.ok, true);

  // 1a. Missing agents/loop-verifier.md in existing installed dir -> verifierToolsCheck.ok === false & ok === false (no silent repo fallback!)
  fs.rmSync(installedVerifier, { force: true });
  const missingVerDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(missingVerDoc.verifierToolsCheck.ok, false);
  assert.equal(missingVerDoc.ok, false);

  // 1b. Break installed loop-verifier.md by adding write_to_file -> verifierToolsCheck.ok === false & ok === false
  fs.writeFileSync(
    installedVerifier,
    "---\nname: loop-verifier\nmodel: pro\ntools:\n  - view_file\n  - write_to_file\n---\nBroken verifier\n",
    "utf8"
  );
  const badVerDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(badVerDoc.verifierToolsCheck.ok, false);
  assert.deepEqual(badVerDoc.verifierToolsCheck.writeTools, ["write_to_file"]);
  assert.equal(badVerDoc.ok, false);

  // Restore valid installedVerifier before isolating workflowBundleCheck
  fs.copyFileSync(path.join(REPO_ROOT, "agents", "loop-verifier.md"), installedVerifier);

  // 2a. Missing workflows/loop-runner/workflow.json in existing installed dir -> workflowBundleCheck.ok === false & ok === false
  fs.rmSync(path.join(installedWfDir, "workflow.json"), { force: true });
  const missingWfDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(missingWfDoc.verifierToolsCheck.ok, true);
  assert.equal(missingWfDoc.workflowBundleCheck.ok, false);
  assert.equal(missingWfDoc.ok, false);

  // 2b. Restore workflow.json and seed forbidden .md inside workflows/ -> workflowBundleCheck.ok === false & ok === false
  fs.copyFileSync(path.join(REPO_ROOT, "workflows", "loop-runner", "workflow.json"), path.join(installedWfDir, "workflow.json"));
  fs.writeFileSync(path.join(installedDir, "workflows", "FORBIDDEN.md"), "# nope\n", "utf8");

  const badWfDoc = JSON.parse(runCli(["doctor", "--json"]).stdout);
  assert.equal(badWfDoc.verifierToolsCheck.ok, true);
  assert.equal(badWfDoc.workflowBundleCheck.ok, false);
  assert.deepEqual(badWfDoc.workflowBundleCheck.mdFiles, ["FORBIDDEN.md"]);
  assert.equal(badWfDoc.ok, false);
});

test("loop-helper.sh v2.0: --profile/--file/--singleton/--on-conflict, profiles action, resolve-task frontmatter stripping, list-profiles, and state-init", (t) => {
  const { home, workspace, envWithMockAgy } = makeSandbox(t);
  const runHelper = (args, stdinText = undefined, cwd = workspace) =>
    spawnSync("sh", [helperShPath, ...args], {
      cwd,
      env: envWithMockAgy,
      input: stdinText,
      encoding: "utf8",
    });

  // 1. Parse v2 flags & additive fields
  const parsedProfile = JSON.parse(
    runHelper([
      "parse",
      "--profile ci --singleton profile --on-conflict wake --max 5",
    ]).stdout
  );
  assert.equal(parsedProfile.action, "run");
  assert.equal(parsedProfile.engine, "workflow");
  assert.equal(parsedProfile.profile, "ci");
  assert.equal(parsedProfile.profile_file, null);
  assert.equal(parsedProfile.singleton, "profile");
  assert.equal(parsedProfile.on_conflict, "wake");
  assert.equal(parsedProfile.max_iterations, 5);

  const parsedFile = JSON.parse(
    runHelper(["parse", "--file=.agents/custom.md --singleton=workspace --on-conflict=skip"]).stdout
  );
  assert.equal(parsedFile.engine, "workflow");
  assert.equal(parsedFile.profile, null);
  assert.equal(parsedFile.profile_file, ".agents/custom.md");
  assert.equal(parsedFile.singleton, "workspace");
  assert.equal(parsedFile.on_conflict, "skip");

  // Lifecycle `profiles` action
  assert.deepEqual(JSON.parse(runHelper(["parse", "profiles"]).stdout), { action: "profiles" });
  assert.deepEqual(JSON.parse(runHelper(["parse", "/agy-loop:loop profiles --json"]).stdout), {
    action: "profiles",
    json: true,
  });
  assert.equal(runHelper(["parse", "profiles bogus"]).status, 2);

  // 2. v2 parse conflicts & typo rejections (Exit 2)
  const v2Conflicts = [
    "parse --profile ci --file custom.md",
    "parse --profile ci check inline prompt",
    "parse --file custom.md check inline prompt",
    "parse --profile ../evil",
    "parse --profile a/b",
    "parse --singleton profile --engine schedule check",
    "parse --on-conflict wake --engine schedule check",
    "parse 5m check --cron --singleton profile",
    "parse --singleton bogus check",
    "parse --on-conflict bogus check",
    "parse --profiles ci",
    "parse --on_conflict wake",
  ];
  for (const raw of v2Conflicts) {
    const res = runHelper(raw.split(" "));
    assert.equal(res.status, 2, `Expected exit 2 for '${raw}', got ${res.status}: ${res.stdout}`);
    assert.ok(JSON.parse(res.stdout).error);
  }

  // 3. resolve-task multi-profile precedence, YAML frontmatter stripping, body-only 25k UTF-8 cap, and blocked_frontmatter_commands
  const wsLoopsDir = path.join(workspace, ".agents", "loops");
  const globalLoopsDir = path.join(home, ".gemini", "config", "loops");
  fs.mkdirSync(wsLoopsDir, { recursive: true });
  fs.mkdirSync(globalLoopsDir, { recursive: true });

  fs.writeFileSync(
    path.join(globalLoopsDir, "ci.md"),
    "---\ninterval: 5m\n---\nGlobal ci body\n",
    "utf8"
  );
  const resolvedGlobal = JSON.parse(runHelper(["resolve-task", workspace, "--profile", "ci"]).stdout);
  assert.equal(resolvedGlobal.source, "~/.gemini/config/loops/ci.md");
  assert.equal(resolvedGlobal.has_frontmatter, true);
  assert.equal(resolvedGlobal.blocked_frontmatter_commands, false);
  assert.match(resolvedGlobal.prompt, /Global ci body/);

  // Workspace overrides global; frontmatter commands are blocked & omitted; body-only 25k cap holds
  const largeBody = "中".repeat(9000); // 27,000 bytes
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    [
      "---",
      "name: ci",
      "interval: 30s",
      "max_iterations: 9",
      "worktree: true",
      'targets: ["api", "web"]',
      'probe_cmd: "echo PWN"',
      'verify_cmd: "echo PWN2"',
      "---",
      "",
      largeBody,
    ].join("\n"),
    "utf8"
  );
  const resolvedWs = JSON.parse(runHelper(["resolve-task", workspace, "--profile", "ci"]).stdout);
  assert.equal(resolvedWs.source, ".agents/loops/ci.md");
  assert.equal(resolvedWs.profile_name, "ci");
  assert.equal(resolvedWs.has_frontmatter, true);
  assert.equal(resolvedWs.blocked_frontmatter_commands, true);
  assert.equal(resolvedWs.frontmatter.interval, "30s");
  assert.equal(resolvedWs.frontmatter.max_iterations, 9);
  assert.equal(resolvedWs.frontmatter.worktree, true);
  assert.deepEqual(resolvedWs.frontmatter.targets, ["api", "web"]);
  assert.equal(resolvedWs.frontmatter.probe_cmd, undefined);
  assert.equal(resolvedWs.frontmatter.verify_cmd, undefined);
  assert.equal(resolvedWs.truncated, true);
  assert.ok(Buffer.byteLength(resolvedWs.prompt, "utf8") <= 25000);
  assert.equal(resolvedWs.prompt.includes("probe_cmd"), false);
  assert.equal(resolvedWs.prompt.includes("\uFFFD"), false);

  // Explicit --file resolution
  fs.writeFileSync(path.join(workspace, "custom.md"), "---\nonce: true\n---\nCustom prompt\n", "utf8");
  const resolvedFile = JSON.parse(
    runHelper(["resolve-task", workspace, "--file", "custom.md"]).stdout
  );
  assert.equal(resolvedFile.source, "custom.md");
  assert.equal(resolvedFile.has_frontmatter, true);
  assert.equal(resolvedFile.frontmatter.once, true);
  assert.match(resolvedFile.prompt, /Custom prompt/);

  // 4. list-profiles enumerates default, workspace, and global profiles cleanly
  fs.writeFileSync(path.join(workspace, ".agents", "loop.md"), "Default body\n", "utf8");
  fs.writeFileSync(path.join(wsLoopsDir, "broken.md"), "---\nunclosed: true\n", "utf8");
  const listed = JSON.parse(runHelper(["list-profiles", workspace]).stdout);
  assert.equal(listed.ok, true);
  assert.equal(listed.active_default_source, ".agents/loop.md");
  assert.equal(
    listed.profiles.some(
      (p) => p.name === "ci" && p.scope === "workspace" && p.blocked_frontmatter_commands === true
    ),
    true
  );
  assert.equal(
    listed.profiles.some((p) => p.name === "broken" && p.ok === false),
    true
  );

  // 5. state-init preserves profile_name, profile_path, and singleton
  const initProfile = JSON.parse(
    runHelper(["state-init", workspace, "--stdin"], JSON.stringify(parsedProfile)).stdout
  );
  assert.equal(initProfile.profile_name, "ci");
  assert.equal(initProfile.singleton, "profile");
  const initFile = JSON.parse(
    runHelper(["state-init", workspace, "--stdin"], JSON.stringify(parsedFile)).stdout
  );
  assert.equal(initFile.profile_path, ".agents/custom.md");
  assert.equal(initFile.singleton, "workspace");

  // 6. #95 regressions: explicit_flags in parse, a..b rejection, and zero-indented YAML block lists
  assert.deepEqual(parsedProfile.explicit_flags, [
    "max_iterations",
    "profile",
    "singleton",
    "on_conflict",
  ]);
  const parsedBare = JSON.parse(runHelper(["parse", "--profile ci"]).stdout);
  assert.deepEqual(parsedBare.explicit_flags, ["profile"]);
  assert.equal(parsedBare.explicit_flags.includes("pacing"), false);
  assert.equal(parsedBare.explicit_flags.includes("state_mode"), false);
  assert.equal(parsedBare.explicit_flags.includes("targets"), false);

  for (const dotCmd of [
    ["parse", "--profile", "a..b"],
    ["resolve-task", workspace, "--profile", "a..b"],
  ]) {
    const dotRes = runHelper(dotCmd);
    assert.equal(dotRes.status, 2, `Expected exit 2 for ${dotCmd.join(" ")}, got ${dotRes.status}`);
    assert.ok(JSON.parse(dotRes.stdout).error);
  }
  fs.writeFileSync(path.join(wsLoopsDir, "a..b.md"), "Bad double dot\n", "utf8");
  const listedWithDots = JSON.parse(runHelper(["list-profiles", workspace]).stdout);
  const dotEntry = listedWithDots.profiles.find((p) => p.name === "a..b");
  assert.ok(dotEntry && dotEntry.ok === false);

  fs.writeFileSync(
    path.join(wsLoopsDir, "zeroindent.md"),
    "---\ntargets:\n- pkgA\n- pkgB\n---\nZero indent targets\n",
    "utf8"
  );
  const resolvedZeroIndent = JSON.parse(
    runHelper(["resolve-task", workspace, "--profile", "zeroindent"]).stdout
  );
  assert.deepEqual(resolvedZeroIndent.frontmatter.targets, ["pkgA", "pkgB"]);
});


