#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  handleLogs,
  handlePs,
  handleRun,
  handleStatusline,
  handleStop,
} from "../lib/cli-commands.mjs";
import { listLoops, resolveStateRoot } from "../lib/state-store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function readPluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8");
    return JSON.parse(raw).version || "1.2.0";
  } catch {
    return "1.2.0";
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
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
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

const VALID_WORKER_MODELS = new Set(["inherit", "flash_lite", "flash", "pro"]);
const BROKEN_ONEHARNESS_TOOLS = new Set([
  "multi_replace_file_content",
  "list_dir",
  "find_by_name",
  "grep_search",
]);
const VERIFIED_DUAL_ENGINE_TOOLS = new Set([
  "view_file",
  "write_to_file",
  "replace_file_content",
  "run_command",
  "manage_task",
  "search_web",
]);

function resolveAgyTimeoutMs(defaultTimeoutMs) {
  const raw = process.env.AGY_LOOP_AGY_TIMEOUT_MS;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[1-9]\d*$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return defaultTimeoutMs;
}

function runAgy(args, { timeoutMs = 15000 } = {}) {
  const effectiveTimeout = resolveAgyTimeoutMs(timeoutMs);
  const res = spawnSync("agy", args, {
    encoding: "utf8",
    env: process.env,
    timeout: effectiveTimeout,
  });

  if (res.error) {
    if (res.error.code === "ENOENT" || res.error.code === "EACCES") {
      return {
        found: false,
        timedOut: false,
        status: 127,
        stdout: "",
        stderr: res.error.message,
      };
    }
    if (res.error.code === "ETIMEDOUT") {
      return {
        found: true,
        timedOut: true,
        status: 124,
        stdout: res.stdout || "",
        stderr: `agy ${args.join(" ")} timed out after ${effectiveTimeout}ms`,
      };
    }
    throw res.error;
  }

  return {
    found: true,
    timedOut: false,
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

function emitAgyTimeoutError(res, { action = null, jsonMode = false, version = null } = {}) {
  const message = res.stderr || "Antigravity CLI ('agy') timed out.";
  if (jsonMode) {
    const payload = {
      ok: false,
      ...(action ? { action } : {}),
      ...(version ? { version } : {}),
      error: message,
      timedOut: true,
      agy: { found: true, version: null, timedOut: true },
      ...(action === "install" ? { backupDir: null } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.stderr.write(`Error: ${message}\n`);
  process.exit(res.status || 124);
}

function parseAgySemver(rawVersion) {
  if (typeof rawVersion !== "string") {
    return null;
  }
  const match = rawVersion.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    version: `${major}.${minor}.${patch}`,
  };
}

function semverGte(parsed, targetMajor, targetMinor, targetPatch) {
  if (!parsed) {
    return false;
  }
  if (parsed.major !== targetMajor) {
    return parsed.major > targetMajor;
  }
  if (parsed.minor !== targetMinor) {
    return parsed.minor > targetMinor;
  }
  return parsed.patch >= targetPatch;
}

function detectAgyCapabilities(agyVersion) {
  const parsed = parseAgySemver(agyVersion);
  return {
    parsedVersion: parsed ? parsed.version : null,
    printTimeout: semverGte(parsed, 1, 5, 0),
    sidecarHomeExpansion: semverGte(parsed, 1, 5, 0),
    worktreeDirtyCarry: semverGte(parsed, 1, 5, 5),
    autoModeDefault: semverGte(parsed, 1, 5, 7),
    dynamicWorkflows: semverGte(parsed, 1, 5, 9),
    githubUrlValidate: semverGte(parsed, 1, 5, 11),
    strictProtojsonHooks: semverGte(parsed, 1, 5, 13),
  };
}

function readJsoncFile(filePath, { redactError = false } = {}) {
  if (!lstatExists(filePath)) {
    return { exists: false, parsed: null, error: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(stripJsonc(raw));
    return { exists: true, parsed, error: null };
  } catch (err) {
    return {
      exists: true,
      parsed: null,
      error: redactError ? "Invalid JSON/JSONC syntax" : err.message,
    };
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGroupedToolHookEntry(entry) {
  return isPlainObject(entry) && typeof entry.matcher === "string" && Array.isArray(entry.hooks);
}

function inspectHooksConfigFile(filePath, scopeLabel, warnings) {
  const res = readJsoncFile(filePath);
  if (!res.exists) {
    return { exists: false, path: filePath, valid: true };
  }
  if (res.error) {
    warnings.push(`${scopeLabel} (${filePath}) could not be parsed as JSON/JSONC: ${res.error}`);
    return { exists: true, path: filePath, valid: false };
  }
  if (!isPlainObject(res.parsed)) {
    warnings.push(`${scopeLabel} (${filePath}) must be a JSON object mapping hook names to specs.`);
    return { exists: true, path: filePath, valid: false };
  }

  let valid = true;
  const checkEventEntries = (ownerLabel, eventName, entries) => {
    if (!Array.isArray(entries)) {
      warnings.push(
        `${scopeLabel} (${filePath}) "${ownerLabel}.${eventName}" must be an array of { matcher, hooks: [...] } groups.`
      );
      valid = false;
      return;
    }
    if (entries.some((entry) => !isGroupedToolHookEntry(entry))) {
      warnings.push(
        `${scopeLabel} (${filePath}) "${ownerLabel}.${eventName}" contains flat or malformed entries without { matcher, hooks: [...] }.`
      );
      valid = false;
    }
  };

  for (const [hookName, spec] of Object.entries(res.parsed)) {
    if (hookName === "$schema") {
      continue;
    }
    if ((hookName === "PreToolUse" || hookName === "PostToolUse") && Array.isArray(spec)) {
      checkEventEntries("<root>", hookName, spec);
      continue;
    }
    if (!isPlainObject(spec)) {
      continue;
    }
    for (const eventName of ["PreToolUse", "PostToolUse"]) {
      if (spec[eventName] !== undefined) {
        checkEventEntries(hookName, eventName, spec[eventName]);
      }
    }
  }

  return { exists: true, path: filePath, valid };
}

function inspectEnvironment(workspaceDir, homeDir) {
  const warnings = [];

  const adminPath = path.join(homeDir, ".gemini", "config", "admin_settings.json");
  const adminRes = readJsoncFile(adminPath, { redactError: true });
  if (adminRes.error) {
    warnings.push(
      `Admin settings (${adminPath}) could not be parsed as JSON/JSONC (syntax details redacted).`
    );
  }
  const adminObj = isPlainObject(adminRes.parsed) ? adminRes.parsed : null;
  const pluginsDisabled = Boolean(adminObj?.pluginControls?.pluginsDisabled);
  const marketplaceDisabled = Boolean(adminObj?.pluginControls?.marketplaceDisabled);
  const remoteControlRaw = adminObj?.featureControls?.remoteControlEnabled;
  const remoteControlEnabled =
    typeof remoteControlRaw === "boolean" ? remoteControlRaw : null;

  if (pluginsDisabled) {
    warnings.push(
      `Admin policy (${adminPath}) sets pluginControls.pluginsDisabled=true; plugins are blocked.`
    );
  }
  if (marketplaceDisabled) {
    warnings.push(
      `Admin policy (${adminPath}) sets pluginControls.marketplaceDisabled=true; marketplace installs are disabled.`
    );
  }

  const cliSettingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const cliRes = readJsoncFile(cliSettingsPath, { redactError: true });
  if (cliRes.error) {
    warnings.push(
      `CLI settings (${cliSettingsPath}) could not be parsed as JSON/JSONC (syntax details redacted).`
    );
  }
  const cliObj = isPlainObject(cliRes.parsed) ? cliRes.parsed : null;
  const agentMode = typeof cliObj?.agentMode === "string" ? cliObj.agentMode : null;
  const toolPermission = typeof cliObj?.toolPermission === "string" ? cliObj.toolPermission : null;
  const enableTerminalSandbox =
    typeof cliObj?.enableTerminalSandbox === "boolean" ? cliObj.enableTerminalSandbox : null;
  const modelProvider = typeof cliObj?.modelProvider === "string" ? cliObj.modelProvider : null;
  const hasGeminiApiKey = Boolean(process.env.GEMINI_API_KEY);

  if (toolPermission === "strict") {
    warnings.push(
      `CLI settings (${cliSettingsPath}) sets toolPermission="strict", which overrides auto/accept-edits and soft-denies unattended headless tools.`
    );
  }
  if (modelProvider === "gemini" || hasGeminiApiKey) {
    warnings.push(
      `GEMINI_API_KEY / modelProvider="gemini" mode active: /usage, /quota, /credits, and --remote-agent are unavailable in this mode.`
    );
  }

  const userHooks = inspectHooksConfigFile(
    path.join(homeDir, ".gemini", "config", "hooks.json"),
    "User hooks.json",
    warnings
  );
  const workspaceHooks = inspectHooksConfigFile(
    path.join(workspaceDir, ".agents", "hooks.json"),
    "Workspace hooks.json",
    warnings
  );

  return {
    environment: {
      adminSettings: {
        exists: adminRes.exists,
        path: adminPath,
        pluginsDisabled,
        marketplaceDisabled,
        remoteControlEnabled,
      },
      cliSettings: {
        exists: cliRes.exists,
        path: cliSettingsPath,
        agentMode,
        toolPermission,
        enableTerminalSandbox,
        modelProvider,
      },
      hooksFiles: {
        user: userHooks,
        workspace: workspaceHooks,
      },
    },
    environmentWarnings: warnings,
  };
}

function runHookSelfTest(homeDir, workspaceDir) {
  const hooksFile = path.join(PLUGIN_ROOT, "hooks.json");
  const hooksRes = readJsoncFile(hooksFile);
  if (!hooksRes.exists) {
    return {
      ok: false,
      exitStatus: null,
      unexpectedKeys: [],
      error: `Missing plugin hooks.json at ${hooksFile}`,
    };
  }
  if (hooksRes.error) {
    return {
      ok: false,
      exitStatus: null,
      unexpectedKeys: [],
      error: `Failed to parse plugin hooks.json: ${hooksRes.error}`,
    };
  }
  if (!isPlainObject(hooksRes.parsed)) {
    return {
      ok: false,
      exitStatus: null,
      unexpectedKeys: [],
      error: "Plugin hooks.json must be a JSON object",
    };
  }

  let sessionStartCommand = null;
  for (const [hookName, spec] of Object.entries(hooksRes.parsed)) {
    if (hookName === "$schema" || !isPlainObject(spec) || spec.enabled === false) {
      continue;
    }
    if (Array.isArray(spec.SessionStart)) {
      const handler = spec.SessionStart.find(
        (h) =>
          isPlainObject(h) &&
          (h.type === undefined || h.type === "command") &&
          typeof h.command === "string" &&
          h.command.trim().length > 0
      );
      if (handler) {
        sessionStartCommand = handler.command;
        break;
      }
    }
  }

  if (!sessionStartCommand) {
    return {
      ok: false,
      exitStatus: null,
      unexpectedKeys: [],
      error: "No enabled SessionStart command handler found in hooks.json",
    };
  }

  const syntheticPayload = {
    artifactDirectoryPath: path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      "doctor-selftest"
    ),
    conversationId: "00000000-0000-0000-0000-000000000000",
    workspacePaths: [workspaceDir],
    hookEventName: "SessionStart",
    cwd: workspaceDir,
    modelName: "gemini-4-neon-xhigh",
    lastUserInput: "/agy-loop:loop doctor",
  };

  // Isolate env from user tokens/API keys while keeping HOME, PLUGIN_ROOT, and POSIX PATH.
  const hookEnv = {
    HOME: homeDir,
    PLUGIN_ROOT,
    PATH: process.env.PATH || "/usr/bin:/bin",
  };
  for (const key of ["LC_ALL", "LANG", "TMPDIR", "AGY_LOOP_STATE_DIR"]) {
    if (process.env[key]) {
      hookEnv[key] = process.env[key];
    }
  }

  const shellBin = process.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgs =
    process.platform === "win32" ? ["/c", sessionStartCommand] : ["-c", sessionStartCommand];
  const res = spawnSync(shellBin, shellArgs, {
    cwd: PLUGIN_ROOT,
    env: hookEnv,
    input: JSON.stringify(syntheticPayload),
    encoding: "utf8",
    timeout: 5000,
  });

  if (res.error) {
    return {
      ok: false,
      exitStatus: res.status ?? (res.error.code === "ETIMEDOUT" ? 124 : null),
      unexpectedKeys: [],
      error:
        res.error.code === "ETIMEDOUT"
          ? "SessionStart hook timed out after 5000ms"
          : res.error.message,
    };
  }

  if (res.status !== 0) {
    return {
      ok: false,
      exitStatus: res.status ?? 1,
      unexpectedKeys: [],
      error: (res.stderr || res.stdout || `SessionStart exited with status ${res.status}`).trim(),
    };
  }

  const rawOut = (res.stdout || "").trim();
  if (!rawOut) {
    return {
      ok: false,
      exitStatus: 0,
      unexpectedKeys: [],
      error: "SessionStart hook produced empty stdout (expected JSON object)",
    };
  }

  let parsedOut;
  try {
    parsedOut = JSON.parse(rawOut);
  } catch (err) {
    return {
      ok: false,
      exitStatus: 0,
      unexpectedKeys: [],
      error: `SessionStart hook stdout is not valid JSON: ${err.message}`,
    };
  }

  if (!isPlainObject(parsedOut)) {
    return {
      ok: false,
      exitStatus: 0,
      unexpectedKeys: [],
      error: "SessionStart hook stdout must be a JSON object",
    };
  }

  const unexpectedKeys = Object.keys(parsedOut).filter((k) => k !== "injectSteps");
  if (unexpectedKeys.length > 0) {
    return {
      ok: false,
      exitStatus: 0,
      unexpectedKeys,
      error: `SessionStart output leaked unexpected non-protojson key(s): ${unexpectedKeys.join(", ")}`,
    };
  }

  if ("injectSteps" in parsedOut && !Array.isArray(parsedOut.injectSteps)) {
    return {
      ok: false,
      exitStatus: 0,
      unexpectedKeys: [],
      error: 'SessionStart "injectSteps" field must be an array',
    };
  }

  return {
    ok: true,
    exitStatus: 0,
    unexpectedKeys: [],
    error: null,
  };
}

function inspectAgentTools(pluginEntry) {
  let agentPath = path.join(PLUGIN_ROOT, "agents", "loop-worker.md");
  if (pluginEntry?.path) {
    const installedAgentPath = path.join(pluginEntry.path, "agents", "loop-worker.md");
    try {
      fs.accessSync(installedAgentPath, fs.constants.R_OK);
      agentPath = installedAgentPath;
    } catch {
      // Fall back to bundled PLUGIN_ROOT when installed plugin path is not readable.
    }
  }

  let raw;
  try {
    raw = fs.readFileSync(agentPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      path: agentPath,
      model: null,
      tools: [],
      invalidTools: [],
      error: `Failed to read ${agentPath}: ${err.message}`,
    };
  }

  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fmMatch) {
    return {
      ok: false,
      path: agentPath,
      model: null,
      tools: [],
      invalidTools: [],
      error: `Missing YAML frontmatter in ${agentPath}`,
    };
  }

  const frontmatter = fmMatch[1];
  let model = null;
  const modelMatch = frontmatter.match(/^model:\s*(.+?)\s*$/m);
  if (modelMatch) {
    let rawModel = modelMatch[1].replace(/\s+#.*$/, "").trim();
    if (
      (rawModel.startsWith('"') && rawModel.endsWith('"')) ||
      (rawModel.startsWith("'") && rawModel.endsWith("'"))
    ) {
      rawModel = rawModel.slice(1, -1).trim();
    }
    model = rawModel || null;
  }

  const tools = [];
  let inTools = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    if (!inTools) {
      const startMatch = line.match(/^tools:\s*(.*)$/);
      if (startMatch) {
        const rest = startMatch[1].replace(/\s+#.*$/, "").trim();
        if (rest.startsWith("[") && rest.endsWith("]")) {
          const inner = rest.slice(1, -1).trim();
          if (inner) {
            for (const part of inner.split(",")) {
              const cleaned = part.trim().replace(/^["']|["']$/g, "");
              if (cleaned) {
                tools.push(cleaned);
              }
            }
          }
        } else {
          inTools = true;
        }
      }
      continue;
    }

    if (!line.trim() || /^\s*#/.test(line)) {
      continue;
    }
    const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
    if (itemMatch) {
      const cleaned = itemMatch[1]
        .replace(/\s+#.*$/, "")
        .trim()
        .replace(/^["']|["']$/g, "");
      if (cleaned) {
        tools.push(cleaned);
      }
    } else if (/^\S/.test(line)) {
      inTools = false;
    }
  }

  const invalidTools = tools.filter(
    (t) => BROKEN_ONEHARNESS_TOOLS.has(t) || !VERIFIED_DUAL_ENGINE_TOOLS.has(t)
  );
  const errors = [];
  if (!model || !VALID_WORKER_MODELS.has(model)) {
    errors.push(
      `Invalid or missing model '${model ?? ""}' (expected inherit, flash_lite, flash, or pro)`
    );
  }
  if (tools.length === 0) {
    errors.push("No tools declared in frontmatter");
  } else if (invalidTools.length > 0) {
    errors.push(`Incompatible or unverified tool(s): ${invalidTools.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    path: agentPath,
    model,
    tools,
    invalidTools,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

function inspectActiveLoops(workspaceDir) {
  const stateRoot = resolveStateRoot(workspaceDir);
  const loops = listLoops(stateRoot, { includeAll: false });
  return loops.map((item) => ({
    loopId: item.loop_id,
    status: item.status,
    iteration: typeof item.iteration === "number" ? item.iteration : null,
    maxIterations: typeof item.max_iterations === "number" ? item.max_iterations : null,
    pacing: item.pacing ?? null,
    taskId: item.task_id ?? null,
    workerId: item.worker_id ?? null,
    updatedAt: item.updated_at ?? null,
    engine: item.engine || "interactive",
    stale: Boolean(item.stale),
  }));
}

function printHelp(version) {
  process.stdout.write(`AGY Loop (agy-loop) v${version}
Non-blocking /agy-loop:loop scheduler plugin and headless runner for Antigravity Desktop & CLI.

Usage:
  agy-loop [command] [options]

Plugin Commands:
  install, update     Install or update the agy-loop plugin (default)
  uninstall, remove   Uninstall the agy-loop plugin from Antigravity
  validate            Run 'agy plugin validate --strict' on the bundled plugin
  doctor, status      Inspect agy capabilities, plugin, hooks, worker tools, env, loops, and loop.md
  version             Print package version
  help                Show this help message

Headless Runner Commands:
  run [interval] [prompt...]   Run a non-interactive headless loop (run 'agy-loop run --help' for options)
  ps, list                     List active loops (supports --all, --global, --json)
  logs [<id|prefix|latest>]    View or follow (-f) loop event logs
  stop <id|prefix|all>         Stop running interactive or headless loops (--after-current, --all)
  statusline                   Emit compact single-line status for statusLine/HUD (<5ms, zero subprocesses)

Options (Plugin Commands):
  --clean-shadow      Move shadowing user-level loop files into a timestamped backup
  --json              Emit machine-readable JSON output
  -h, --help          Show this help message
  -v, --version       Print package version

Examples:
  npx agy-loop
  npx agy-loop install --clean-shadow
  npx agy-loop doctor --json
  agy-loop run --once --model gemini-4-carbon-low "Check tests and fix failures"
  agy-loop run 2m --stateful --verifier-model gemini-4-neon-xhigh
  agy-loop ps --all
  agy-loop logs latest -f
  agy-loop stop all
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
  if (probe.timedOut) {
    emitAgyTimeoutError(probe, { action: "install", jsonMode: json, version });
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

    const valRes = runAgy(["plugin", "validate", PLUGIN_ROOT], { timeoutMs: 30000 });
    if (valRes.status !== 0) {
      const errMsg = (valRes.stderr || valRes.stdout || "agy plugin validate failed").trim();
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              action: "install",
              ...(valRes.timedOut ? { timedOut: true } : {}),
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
    const installRes = runAgy(["plugin", "install", PLUGIN_ROOT], { timeoutMs: 30000 });
    if (installRes.status !== 0) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: false,
              action: "install",
              ...(installRes.timedOut ? { timedOut: true } : {}),
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
  if (probe.timedOut) {
    emitAgyTimeoutError(probe, { action: "uninstall", jsonMode: json });
  }

  const res = runAgy(["plugin", "uninstall", "agy-loop"], { timeoutMs: 30000 });
  if (res.status !== 0) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            action: "uninstall",
            ...(res.timedOut ? { timedOut: true } : {}),
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
  if (probe.timedOut) {
    emitAgyTimeoutError(probe, { action: "validate", jsonMode: json });
  }

  const args = ["plugin", "validate", "--strict"];
  if (json) {
    args.push("--json");
  }
  args.push(PLUGIN_ROOT);

  const res = runAgy(args, { timeoutMs: 30000 });
  if (res.timedOut && json && !res.stdout.trim()) {
    emitAgyTimeoutError(res, { action: "validate", jsonMode: json });
  }
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
  if (verRes.timedOut) {
    emitAgyTimeoutError(verRes, { action: "doctor", jsonMode: json, version });
  }
  const agyVersion = (verRes.stdout || verRes.stderr).trim() || "unknown";
  const capabilities = detectAgyCapabilities(agyVersion);

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
  const { environment, environmentWarnings } = inspectEnvironment(workspaceDir, homeDir);
  const hookSelfTest = runHookSelfTest(homeDir, workspaceDir);
  const agentToolsCheck = inspectAgentTools(pluginEntry);
  const activeLoops = inspectActiveLoops(workspaceDir);

  const pluginInstalled = Boolean(pluginEntry);
  const pluginEnabled = pluginEntry ? pluginEntry.enabled !== false : false;
  const ok =
    pluginInstalled &&
    pluginEnabled &&
    !pluginListError &&
    shadows.length === 0 &&
    skillFilterWarnings.length === 0 &&
    !environment.adminSettings.pluginsDisabled &&
    hookSelfTest.ok &&
    agentToolsCheck.ok;

  const report = {
    ok,
    version,
    agy: {
      found: true,
      version: agyVersion,
      capabilities,
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
    environment,
    environmentWarnings,
    hookSelfTest,
    agentToolsCheck,
    activeLoops,
    loopMd: {
      active: loopMd.active,
      activeSource: loopMd.activeSource,
      candidates: loopMd.candidates,
    },
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (listRes.timedOut) {
      process.exit(listRes.status || 124);
    }
    return;
  }

  const capLabels = [];
  if (capabilities.worktreeDirtyCarry) capLabels.push("worktree-carry");
  if (capabilities.autoModeDefault) capLabels.push("auto-mode");
  if (capabilities.dynamicWorkflows) capLabels.push("run_workflow");
  if (capabilities.githubUrlValidate) capLabels.push("github-url");
  if (capabilities.strictProtojsonHooks) capLabels.push("strict-protojson");
  const capSummary = capabilities.parsedVersion
    ? `${capabilities.parsedVersion} (${capLabels.length > 0 ? capLabels.join(", ") : "legacy"})`
    : "unknown (unparsed version)";

  process.stdout.write(`AGY Loop Doctor (v${version})\n`);
  process.stdout.write(`  agy CLI:        found (v${agyVersion})\n`);
  process.stdout.write(`  agy features:   ${capSummary}\n`);
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

  if (hookSelfTest.ok) {
    process.stdout.write(`  hook protojson: ok (SessionStart strict schema)\n`);
  } else {
    const detail =
      hookSelfTest.error ||
      (hookSelfTest.unexpectedKeys.length > 0
        ? `unexpected keys: ${hookSelfTest.unexpectedKeys.join(", ")}`
        : "failed");
    process.stdout.write(`  hook protojson: FAILED (${detail})\n`);
  }

  if (agentToolsCheck.ok) {
    process.stdout.write(
      `  loop-worker:    ok (model=${agentToolsCheck.model}, ${agentToolsCheck.tools.length} dual-engine tools)\n`
    );
  } else {
    process.stdout.write(`  loop-worker:    FAILED (${agentToolsCheck.error})\n`);
  }

  if (environmentWarnings.length === 0) {
    process.stdout.write(`  environment:    ok\n`);
  } else {
    process.stdout.write(`  environment:    ${environmentWarnings.length} warning(s)\n`);
    for (const w of environmentWarnings) {
      process.stdout.write(`    - ${w}\n`);
    }
  }

  if (activeLoops.length === 0) {
    process.stdout.write(`  active loops:   0\n`);
  } else {
    process.stdout.write(`  active loops:   ${activeLoops.length} running\n`);
    for (const loop of activeLoops) {
      const staleLabel = loop.stale ? ", STALE" : "";
      process.stdout.write(
        `    - ${loop.loopId} (${loop.engine || "interactive"}, iter ${loop.iteration ?? "?"}/${loop.maxIterations ?? "?"}, pacing=${
          loop.pacing || "?"
        }${staleLabel}, updated=${loop.updatedAt || "?"})\n`
      );
    }
  }

  if (loopMd.active) {
    process.stdout.write(`  active loop.md: ${loopMd.activeSource} (${loopMd.active})\n`);
  } else {
    process.stdout.write(`  active loop.md: none (using built-in maintenance fallback)\n`);
  }

  if (listRes.timedOut) {
    process.exit(listRes.status || 124);
  }
}

async function main() {
  const version = readPluginVersion();
  const rawArgv = process.argv.slice(2);
  const subcommand = rawArgv[0];

  if (subcommand === "run") {
    await handleRun(rawArgv.slice(1), { version });
    return;
  }
  if (subcommand === "ps" || subcommand === "list") {
    await handlePs(rawArgv.slice(1));
    return;
  }
  if (subcommand === "logs") {
    await handleLogs(rawArgv.slice(1));
    return;
  }
  if (subcommand === "stop") {
    await handleStop(rawArgv.slice(1));
    return;
  }
  if (subcommand === "statusline") {
    await handleStatusline(rawArgv.slice(1));
    return;
  }

  const parsed = parseCliArgs(rawArgv);

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

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
});
