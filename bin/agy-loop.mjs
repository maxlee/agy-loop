#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readPluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8");
    return JSON.parse(raw).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function resolveHome() {
  return process.env.HOME || os.homedir();
}

function lstatExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isSameDirectory(dirA, dirB) {
  try {
    return fs.realpathSync(dirA) === fs.realpathSync(dirB);
  } catch {
    return false;
  }
}

function validateLocalManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, "plugin.json");
  if (!lstatExists(manifestPath)) {
    return { ok: false, error: `Missing plugin.json in ${pluginDir}` };
  }
  try {
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(stripJsonc(raw));
    if (!parsed || typeof parsed !== "object" || parsed.name !== "agy-loop") {
      return {
        ok: false,
        error: `Invalid plugin.json in ${pluginDir}: expected "name": "agy-loop"`,
      };
    }
    return { ok: true, manifest: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse plugin.json in ${pluginDir}: ${err.message}`,
    };
  }
}

function stripJsonc(input) {
  let noComments = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      noComments += " ";
      continue;
    }

    noComments += ch;
    i += 1;
  }

  let out = "";
  inString = false;
  escaped = false;
  for (let idx = 0; idx < noComments.length; idx += 1) {
    const ch = noComments[idx];
    if (inString) {
      out += ch;
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
      out += ch;
      continue;
    }

    if (ch === ",") {
      let lookahead = idx + 1;
      while (
        lookahead < noComments.length &&
        /\s/.test(noComments[lookahead])
      ) {
        lookahead += 1;
      }
      if (noComments[lookahead] === "}" || noComments[lookahead] === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function patternMatchesLoop(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return false;
  }
  if (
    pattern === "loop" ||
    pattern === "agy-loop" ||
    pattern === "agy-loop:loop" ||
    pattern === "*" ||
    pattern === ".*"
  ) {
    return true;
  }
  try {
    const re = new RegExp(`^(?:${pattern})$`);
    return re.test("loop") || re.test("agy-loop") || re.test("agy-loop:loop");
  } catch {
    return false;
  }
}

function detectShadowPaths(homeDir) {
  const candidates = [
    {
      relFromGemini: path.join("config", "skills", "loop"),
      label: "~/.gemini/config/skills/loop",
      path: path.join(homeDir, ".gemini", "config", "skills", "loop"),
    },
    {
      relFromGemini: path.join("config", "agents", "loop-worker.md"),
      label: "~/.gemini/config/agents/loop-worker.md",
      path: path.join(homeDir, ".gemini", "config", "agents", "loop-worker.md"),
    },
    {
      relFromGemini: path.join("antigravity-cli", "skills", "loop"),
      label: "~/.gemini/antigravity-cli/skills/loop",
      path: path.join(homeDir, ".gemini", "antigravity-cli", "skills", "loop"),
    },
    {
      relFromGemini: path.join("skills", "loop"),
      label: "~/.gemini/skills/loop",
      path: path.join(homeDir, ".gemini", "skills", "loop"),
    },
  ];

  return candidates.filter((item) => lstatExists(item.path));
}

function inspectSkillsJsonFile(filePath, scopeLabel) {
  if (!lstatExists(filePath)) {
    return [];
  }
  const warnings = [];
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(stripJsonc(raw));
  } catch (err) {
    warnings.push(
      `${scopeLabel} (${filePath}) could not be parsed as JSON/JSONC: ${err.message}`
    );
    return warnings;
  }

  if (!parsed || typeof parsed !== "object") {
    return warnings;
  }

  if (Array.isArray(parsed.include_only)) {
    const allowsLoop = parsed.include_only.some(patternMatchesLoop);
    if (!allowsLoop) {
      warnings.push(
        `${scopeLabel} (${filePath}) has top-level "include_only" omitting "loop".`
      );
    }
  }

  if (Array.isArray(parsed.exclude) && parsed.exclude.some(patternMatchesLoop)) {
    warnings.push(
      `${scopeLabel} (${filePath}) has top-level "exclude" matching "loop".`
    );
  }

  for (const listKey of ["entries", "inherits"]) {
    if (!Array.isArray(parsed[listKey])) {
      continue;
    }
    for (const entry of parsed[listKey]) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (Array.isArray(entry.include_only)) {
        const allowsLoop = entry.include_only.some(patternMatchesLoop);
        if (!allowsLoop) {
          const entryTarget = entry.path ? ` for "${entry.path}"` : "";
          warnings.push(
            `${scopeLabel} (${filePath}) ${listKey} entry${entryTarget} has "include_only" omitting "loop".`
          );
        }
      }
      if (Array.isArray(entry.exclude) && entry.exclude.some(patternMatchesLoop)) {
        const entryTarget = entry.path ? ` for "${entry.path}"` : "";
        warnings.push(
          `${scopeLabel} (${filePath}) ${listKey} entry${entryTarget} has "exclude" matching "loop".`
        );
      }
    }
  }

  return warnings;
}

function detectSkillFilterWarnings(workspaceDir, homeDir) {
  return [
    ...inspectSkillsJsonFile(
      path.join(workspaceDir, ".agents", "skills.json"),
      "Workspace skills.json"
    ),
    ...inspectSkillsJsonFile(
      path.join(homeDir, ".gemini", "config", "skills.json"),
      "Global skills.json"
    ),
  ];
}

function inspectLoopMd(workspaceDir, homeDir) {
  const candidates = [
    {
      source: ".agents/loop.md",
      path: path.join(workspaceDir, ".agents", "loop.md"),
    },
    {
      source: "loop.md",
      path: path.join(workspaceDir, "loop.md"),
    },
    {
      source: "~/.gemini/config/loop.md",
      path: path.join(homeDir, ".gemini", "config", "loop.md"),
    },
  ].map((item) => {
    let isNonEmptyFile = false;
    try {
      const stat = fs.statSync(item.path);
      isNonEmptyFile = stat.isFile() && stat.size > 0;
    } catch {
      isNonEmptyFile = false;
    }
    return {
      ...item,
      exists: isNonEmptyFile,
    };
  });

  const activeItem = candidates.find((c) => c.exists) || null;
  return {
    active: activeItem ? activeItem.path : null,
    activeSource: activeItem ? activeItem.source : "builtin",
    candidates,
  };
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function movePathSafe(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function backupShadowPaths(homeDir, shadows = detectShadowPaths(homeDir)) {
  const baseDir = path.join(homeDir, ".gemini", "config");
  fs.mkdirSync(baseDir, { recursive: true });

  let backupDir = path.join(baseDir, `.agy-loop-backup-${formatBackupTimestamp()}`);
  if (lstatExists(backupDir)) {
    backupDir = `${backupDir}-${process.pid}`;
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const moved = [];
  for (const item of shadows) {
    if (!lstatExists(item.path)) {
      continue;
    }
    const dest = path.join(backupDir, item.relFromGemini);
    movePathSafe(item.path, dest);
    moved.push({ from: item.path, to: dest });
  }

  return { backupDir, moved };
}

function runAgy(args) {
  const res = spawnSync("agy", args, {
    encoding: "utf8",
    env: process.env,
  });

  if (res.error) {
    if (res.error.code === "ENOENT" || res.error.code === "EACCES") {
      return {
        found: false,
        status: 127,
        stdout: "",
        stderr: res.error.message,
      };
    }
    throw res.error;
  }

  return {
    found: true,
    status: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

function emitMissingAgyError(jsonMode) {
  const message =
    "Antigravity CLI ('agy') was not found in PATH. Install Antigravity CLI or add 'agy' to PATH, then try again.";
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: message,
          agy: { found: false, version: null },
        },
        null,
        2
      )}\n`
    );
  }
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function printHelp(version) {
  process.stdout.write(`AGY Loop (agy-loop) v${version}
Non-blocking /agy-loop:loop scheduler plugin for Antigravity Desktop & CLI.

Usage:
  agy-loop [command] [options]

Commands:
  install, update     Install or update the agy-loop plugin (default)
  uninstall, remove   Uninstall the agy-loop plugin from Antigravity
  validate            Run 'agy plugin validate --strict' on the bundled plugin
  doctor, status      Inspect agy CLI, plugin registration, shadow files, and loop.md
  version             Print package version
  help                Show this help message

Options:
  --clean-shadow      Move shadowing user-level loop files into a timestamped backup
  --json              Emit machine-readable JSON output
  -h, --help          Show this help message
  -v, --version       Print package version

Examples:
  npx agy-loop
  npx agy-loop install --clean-shadow
  npx agy-loop doctor --clean-shadow
  npx agy-loop doctor --json
  npx agy-loop uninstall
`);
}

function parseCliArgs(argv) {
  let command = null;
  let cleanShadow = false;
  let json = false;
  let help = false;
  let showVersion = false;
  const unknown = [];

  for (const arg of argv) {
    if (arg === "--clean-shadow") {
      cleanShadow = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      showVersion = true;
    } else if (arg.startsWith("-")) {
      unknown.push(arg);
    } else if (command === null) {
      command = arg;
    } else {
      unknown.push(arg);
    }
  }

  return {
    command: command || "install",
    cleanShadow,
    json,
    help,
    showVersion,
    unknown,
  };
}

function handleInstall({ cleanShadow, json, version }) {
  const homeDir = resolveHome();
  const workspaceDir = process.cwd();
  const installedPluginDir = path.join(homeDir, ".gemini", "config", "plugins", "agy-loop");

  const probe = runAgy(["--version"]);
  if (!probe.found) {
    emitMissingAgyError(json);
  }

  const alreadyInPlace = isSameDirectory(PLUGIN_ROOT, installedPluginDir);
  let installStdout = "";

  if (alreadyInPlace) {
    const manifestCheck = validateLocalManifest(PLUGIN_ROOT);
    if (!manifestCheck.ok) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              action: "install",
              error: manifestCheck.error,
              backupDir: null,
            },
            null,
            2
          )}\n`
        );
      } else {
        process.stderr.write(`Error: ${manifestCheck.error}\n`);
      }
      process.exit(1);
    }

    const valRes = runAgy(["plugin", "validate", PLUGIN_ROOT]);
    if (valRes.status !== 0) {
      const errMsg = (valRes.stderr || valRes.stdout || "agy plugin validate failed").trim();
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              action: "install",
              error: errMsg,
              backupDir: null,
            },
            null,
            2
          )}\n`
        );
      } else {
        if (valRes.stdout) process.stderr.write(valRes.stdout);
        if (valRes.stderr) process.stderr.write(valRes.stderr);
      }
      process.exit(valRes.status || 1);
    }
  } else {
    const installRes = runAgy(["plugin", "install", PLUGIN_ROOT]);
    if (installRes.status !== 0) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              action: "install",
              error: (installRes.stderr || installRes.stdout || "agy plugin install failed").trim(),
              backupDir: null,
            },
            null,
            2
          )}\n`
        );
      } else {
        if (installRes.stdout) process.stderr.write(installRes.stdout);
        if (installRes.stderr) process.stderr.write(installRes.stderr);
      }
      process.exit(installRes.status || 1);
    }
    installStdout = installRes.stdout || "";
  }

  let backupInfo = null;
  const initialShadows = detectShadowPaths(homeDir);
  if (cleanShadow && initialShadows.length > 0) {
    backupInfo = backupShadowPaths(homeDir, initialShadows);
  }

  const remainingShadows = detectShadowPaths(homeDir);
  const skillFilterWarnings = detectSkillFilterWarnings(workspaceDir, homeDir);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          action: "install",
          version,
          pluginRoot: PLUGIN_ROOT,
          alreadyInPlace,
          backupDir: backupInfo ? backupInfo.backupDir : null,
          cleanedShadows: backupInfo ? backupInfo.moved.map((m) => m.from) : [],
          movedShadows: backupInfo ? backupInfo.moved : [],
          shadows: remainingShadows.map((s) => s.path),
          skillFilterWarnings,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  if (installStdout.trim()) {
    process.stdout.write(`${installStdout.trim()}\n`);
  }
  if (alreadyInPlace) {
    process.stdout.write(
      `==> Verified agy-loop v${version} already installed at ${PLUGIN_ROOT} (skipped self-copy)\n`
    );
  } else {
    process.stdout.write(`==> Installed agy-loop v${version} (${PLUGIN_ROOT})\n`);
  }

  if (backupInfo && backupInfo.moved.length > 0) {
    process.stdout.write(
      `==> Backed up ${backupInfo.moved.length} shadowing customization(s) to:\n    ${backupInfo.backupDir}\n`
    );
  } else if (remainingShadows.length > 0) {
    process.stderr.write(
      `\nWarning: Detected user-level customization file(s) that take precedence over plugins and will shadow agy-loop:\n`
    );
    for (const item of remainingShadows) {
      process.stderr.write(`  - ${item.path}\n`);
    }
    process.stderr.write(
      `To archive them into ~/.gemini/config/.agy-loop-backup-<timestamp>/ automatically, run:\n` +
        `  npx agy-loop doctor --clean-shadow\n` +
        `  # or: sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow\n\n`
    );
  }

  if (skillFilterWarnings.length > 0) {
    process.stderr.write(`\nWarning: Detected skills.json filter restriction(s):\n`);
    for (const warning of skillFilterWarnings) {
      process.stderr.write(`  - ${warning}\n`);
    }
    process.stderr.write("\n");
  }

  process.stdout.write(
    `==> Quickstart:\n` +
      `  1. If 'agy' is already open, run: /skills reload\n` +
      `  2. Start a recurring loop:       /agy-loop:loop 1m check local build and tests\n` +
      `  3. Start an adaptive CI loop:    /agy-loop:loop check current PR CI status and fix failures --stateful\n` +
      `  4. Inspect or stop active loops: /agy-loop:loop status  |  /agy-loop:loop stop\n`
  );
}

function handleUninstall({ json }) {
  const probe = runAgy(["--version"]);
  if (!probe.found) {
    emitMissingAgyError(json);
  }

  const res = runAgy(["plugin", "uninstall", "agy-loop"]);
  if (res.status !== 0) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            action: "uninstall",
            error: (res.stderr || res.stdout || "agy plugin uninstall failed").trim(),
          },
          null,
          2
        )}\n`
      );
    } else {
      if (res.stdout) process.stderr.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    process.exit(res.status || 1);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, action: "uninstall", name: "agy-loop" }, null, 2)}\n`
    );
    return;
  }

  if (res.stdout.trim()) {
    process.stdout.write(`${res.stdout.trim()}\n`);
  }
  process.stdout.write(
    `==> Uninstalled agy-loop. If 'agy' is currently open, run '/skills reload' to refresh active skills.\n`
  );
}

function handleValidate({ json }) {
  const probe = runAgy(["--version"]);
  if (!probe.found) {
    emitMissingAgyError(json);
  }

  const args = ["plugin", "validate", "--strict"];
  if (json) {
    args.push("--json");
  }
  args.push(PLUGIN_ROOT);

  const res = runAgy(args);
  if (res.stdout) {
    process.stdout.write(res.stdout);
  }
  if (res.stderr) {
    process.stderr.write(res.stderr);
  }
  process.exit(res.status || 0);
}

function parsePluginListOutput(stdout) {
  if (!stdout || !stdout.trim()) {
    return [];
  }
  const parsed = JSON.parse(stripJsonc(stdout));
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (parsed && Array.isArray(parsed.plugins)) {
    return parsed.plugins;
  }
  return [];
}

function handleDoctor({ cleanShadow = false, json, version }) {
  const homeDir = resolveHome();
  const workspaceDir = process.cwd();

  const verRes = runAgy(["--version"]);
  if (!verRes.found) {
    emitMissingAgyError(json);
  }
  const agyVersion = (verRes.stdout || verRes.stderr).trim() || "unknown";

  const listRes = runAgy(["plugin", "list", "--json"]);
  let pluginEntry = null;
  let pluginListError = null;
  if (listRes.status === 0) {
    try {
      const plugins = parsePluginListOutput(listRes.stdout);
      pluginEntry = plugins.find((p) => p && p.name === "agy-loop") || null;
    } catch (err) {
      pluginListError = `Failed to parse 'agy plugin list --json': ${err.message}`;
    }
  } else {
    pluginListError = (listRes.stderr || listRes.stdout || "agy plugin list failed").trim();
  }

  let backupInfo = null;
  const initialShadows = detectShadowPaths(homeDir);
  if (cleanShadow && initialShadows.length > 0) {
    backupInfo = backupShadowPaths(homeDir, initialShadows);
  }

  const shadows = detectShadowPaths(homeDir);
  const skillFilterWarnings = detectSkillFilterWarnings(workspaceDir, homeDir);
  const loopMd = inspectLoopMd(workspaceDir, homeDir);

  const pluginInstalled = Boolean(pluginEntry);
  const pluginEnabled = pluginEntry ? pluginEntry.enabled !== false : false;
  const ok =
    pluginInstalled &&
    pluginEnabled &&
    !pluginListError &&
    shadows.length === 0 &&
    skillFilterWarnings.length === 0;

  const report = {
    ok,
    version,
    agy: {
      found: true,
      version: agyVersion,
    },
    plugin: {
      installed: pluginInstalled,
      enabled: pluginEnabled,
      version: pluginEntry?.version || null,
      path: pluginEntry?.path || null,
      error: pluginListError,
    },
    backupDir: backupInfo ? backupInfo.backupDir : null,
    cleanedShadows: backupInfo ? backupInfo.moved.map((m) => m.from) : [],
    movedShadows: backupInfo ? backupInfo.moved : [],
    shadows: shadows.map((s) => s.path),
    skillFilterWarnings,
    loopMd: {
      active: loopMd.active,
      activeSource: loopMd.activeSource,
      candidates: loopMd.candidates,
    },
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`AGY Loop Doctor (v${version})\n`);
  process.stdout.write(`  agy CLI:        found (v${agyVersion})\n`);
  if (pluginListError) {
    process.stdout.write(`  plugin status:  error (${pluginListError})\n`);
  } else if (pluginInstalled) {
    process.stdout.write(
      `  plugin status:  installed (${pluginEnabled ? "enabled" : "disabled"}${
        pluginEntry?.version ? `, v${pluginEntry.version}` : ""
      })\n`
    );
    if (pluginEntry?.path) {
      process.stdout.write(`  plugin path:    ${pluginEntry.path}\n`);
    }
  } else {
    process.stdout.write(`  plugin status:  not installed (run 'npx agy-loop install')\n`);
  }

  if (backupInfo && backupInfo.moved.length > 0) {
    process.stdout.write(
      `  cleaned shadow: ${backupInfo.moved.length} archived to ${backupInfo.backupDir}\n`
    );
    for (const item of backupInfo.moved) {
      process.stdout.write(`    - ${item.from}\n`);
    }
    process.stdout.write(
      `  reload hint:    If 'agy' is currently open, run '/skills reload' to refresh skills and subagents.\n`
    );
  }

  if (shadows.length === 0) {
    process.stdout.write(`  shadow files:   none\n`);
  } else {
    process.stdout.write(`  shadow files:   ${shadows.length} detected (shadows plugin!)\n`);
    for (const s of shadows) {
      process.stdout.write(`    - ${s.path}\n`);
    }
    process.stdout.write(
      `    Fix: npx agy-loop doctor --clean-shadow  (or: sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow)\n`
    );
  }

  if (skillFilterWarnings.length === 0) {
    process.stdout.write(`  skills.json:    ok\n`);
  } else {
    process.stdout.write(`  skills.json:    ${skillFilterWarnings.length} warning(s)\n`);
    for (const w of skillFilterWarnings) {
      process.stdout.write(`    - ${w}\n`);
    }
  }

  if (loopMd.active) {
    process.stdout.write(`  active loop.md: ${loopMd.activeSource} (${loopMd.active})\n`);
  } else {
    process.stdout.write(`  active loop.md: none (using built-in maintenance fallback)\n`);
  }
}

function main() {
  const version = readPluginVersion();
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.help || parsed.command === "help") {
    printHelp(version);
    return;
  }

  if (parsed.showVersion || parsed.command === "version") {
    if (parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ name: "agy-loop", version }, null, 2)}\n`
      );
    } else {
      process.stdout.write(`agy-loop ${version}\n`);
    }
    return;
  }

  if (parsed.unknown.length > 0) {
    const msg = `Unknown argument(s): ${parsed.unknown.join(" ")}. Run 'agy-loop --help' for usage.`;
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    }
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(2);
  }

  switch (parsed.command) {
    case "install":
    case "update":
      handleInstall({
        cleanShadow: parsed.cleanShadow,
        json: parsed.json,
        version,
      });
      break;
    case "uninstall":
    case "remove":
      handleUninstall({ json: parsed.json });
      break;
    case "validate":
      handleValidate({ json: parsed.json });
      break;
    case "doctor":
    case "status":
      handleDoctor({
        cleanShadow: parsed.cleanShadow,
        json: parsed.json,
        version,
      });
      break;
    default: {
      const msg = `Unknown command '${parsed.command}'. Run 'agy-loop --help' for usage.`;
      if (parsed.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      }
      process.stderr.write(`Error: ${msg}\n`);
      process.exit(2);
    }
  }
}

main();
