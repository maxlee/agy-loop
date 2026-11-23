/**
 * Zero-dependency persistent daemon manager for agy-loop v2.0.0:
 * - Native Antigravity Sidecar (`sidecar.json` with CRON_TZ + agentapi, never editing user_config.json)
 * - macOS LaunchAgent (`~/Library/LaunchAgents/com.maxlee.<slug>.plist`)
 * - Linux systemd --user (`~/.config/systemd/user/<slug>.{service,timer}`)
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveProfileTask,
  validateCronExpression,
  validateIanaTimezone,
  validateSidecarGrants,
} from "./profile-parser.mjs";
import {
  readDaemonRegistry,
  removeDaemonEntry,
  resolveHome,
  resolveStateRoot,
  upsertDaemonEntry,
} from "./state-store.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_AGY_LOOP_BIN = path.resolve(__dirname, "..", "bin", "agy-loop.mjs");

export const VALID_DAEMON_SLUG_RE = /^agy-loop-[a-z0-9][a-z0-9-]{0,80}$/;

const EPHEMERAL_PREFIXES = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
  "/google/src/cloud",
];

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = new Map([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);
const DOW_NAMES = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

export { validateCronExpression };

/**
 * Validate a managed daemon slug (`agy-loop-*`, preventing path traversal and directory escapes).
 *
 * @param {unknown} slug
 * @returns {string}
 */
export function validateDaemonSlug(slug) {
  if (typeof slug !== "string" || !VALID_DAEMON_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid daemon slug '${String(slug)}': must match ${VALID_DAEMON_SLUG_RE}`
    );
  }
  return slug;
}

function assertContainedPath(baseDir, targetPath, label = "artifact") {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Unsafe ${label} path '${resolvedTarget}' escapes managed directory '${resolvedBase}'`
    );
  }
  return resolvedTarget;
}

function rejectControlChars(val, label) {
  const s = String(val ?? "");
  if (/[\r\n\0]/.test(s)) {
    throw new Error(
      `Invalid ${label} for systemd unit: newline and NUL characters are forbidden`
    );
  }
  return s;
}

function escapeSystemdValue(val, label, { flattenNewlines = false } = {}) {
  let s = String(val ?? "");
  if (/\0/.test(s)) {
    throw new Error(`Invalid ${label} for systemd unit: NUL byte is forbidden`);
  }
  if (flattenNewlines) {
    s = s.replace(/[\r\n]+/g, " ").trim();
  } else if (/[\r\n]/.test(s)) {
    throw new Error(
      `Invalid ${label} for systemd unit: newline characters are forbidden`
    );
  }
  return s.replace(/%/g, "%%");
}

function escapeSystemdEnvArg(arg, label = "Environment") {
  const s = rejectControlChars(arg, label);
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

function escapeSystemdExecArg(arg) {
  const s = rejectControlChars(arg, "ExecStart argument");
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => "$$");
  return `"${escaped}"`;
}

function resolveRealOrAbs(targetPath) {
  const abs = path.resolve(targetPath || process.cwd());
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function toKebabSegment(raw, fallback, maxLen = 20) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

function writePrettyJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(2).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(2).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

function defaultExec(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: opts.env || process.env,
    timeout: opts.timeoutMs ?? 15000,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: res.error || null,
  };
}

function isUnderPrefix(candidatePath, prefix) {
  return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Compute deterministic kebab-case daemon slug: `agy-loop-<repo>-<profile>-<4hex>`.
 *
 * @param {string} workspaceDir
 * @param {string | null} [profileName]
 * @returns {string}
 */
export function computeDaemonSlug(workspaceDir, profileName = null) {
  const wsReal = resolveRealOrAbs(workspaceDir);
  const repoBase = path.basename(wsReal) || "workspace";
  const kebabRepo = toKebabSegment(repoBase, "repo", 22);
  const profRaw =
    typeof profileName === "string" && profileName.trim() ? profileName.trim() : "default";
  const kebabProfile = toKebabSegment(profRaw, "default", 18);
  const hex4 = crypto
    .createHash("sha256")
    .update(`${wsReal}\0${profRaw}`, "utf8")
    .digest("hex")
    .slice(0, 4);
  return `agy-loop-${kebabRepo}-${kebabProfile}-${hex4}`;
}

/**
 * Detect or validate an IANA timezone string (rejects abbreviations like `PST` and offsets like `+08:00`).
 *
 * @param {string | null} [explicitTz]
 * @returns {string}
 */
export function detectHostTimezone(explicitTz = null) {
  if (explicitTz !== null && explicitTz !== undefined && String(explicitTz).trim() !== "") {
    return validateIanaTimezone(String(explicitTz).trim());
  }

  let detected = "";
  try {
    detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    detected = "";
  }
  if (detected) {
    try {
      return validateIanaTimezone(detected);
    } catch {
      // Fallback below
    }
  }

  if (typeof process.env.TZ === "string" && process.env.TZ.trim()) {
    try {
      return validateIanaTimezone(process.env.TZ.trim());
    } catch {
      // Fallback to UTC
    }
  }

  return "UTC";
}

/**
 * Map a fixed interval in seconds to a 5-field cron expression when evenly representable.
 * Throws a descriptive error directing to `--cron` or `--mode os` otherwise.
 *
 * @param {number} intervalSec
 * @returns {string}
 */
export function intervalToCron(intervalSec) {
  if (!Number.isInteger(intervalSec) || intervalSec < 1) {
    throw new Error(`Invalid interval seconds: '${String(intervalSec)}' (expected integer >= 1)`);
  }

  if (intervalSec < 60 || intervalSec % 60 !== 0) {
    throw new Error(
      `Interval ${intervalSec}s cannot be represented as a 5-field cron expression (minimum cron resolution is 1m/60s). Pass --cron "<expr>" explicitly or use --mode os.`
    );
  }

  const totalMinutes = intervalSec / 60;
  if (totalMinutes === 1) {
    return "* * * * *";
  }
  if (totalMinutes < 60) {
    if (60 % totalMinutes === 0) {
      return `*/${totalMinutes} * * * *`;
    }
    throw new Error(
      `Interval ${totalMinutes}m (${intervalSec}s) does not divide 60m evenly for 5-field cron. Pass --cron "<expr>" explicitly or use --mode os.`
    );
  }

  if (intervalSec === 3600) {
    return "0 * * * *";
  }

  if (intervalSec < 86400 && intervalSec % 3600 === 0) {
    const hours = intervalSec / 3600;
    if (24 % hours === 0) {
      return `0 */${hours} * * *`;
    }
    throw new Error(
      `Interval ${hours}h (${intervalSec}s) does not divide 24h evenly for 5-field cron. Pass --cron "<expr>" explicitly or use --mode os.`
    );
  }

  if (intervalSec === 86400) {
    return "0 0 * * *";
  }

  throw new Error(
    `Interval ${intervalSec}s cannot be mapped evenly to a 5-field cron expression. Pass --cron "<expr>" explicitly or use --mode os.`
  );
}

/**
 * Validate that `workspaceDir` exists, is a directory, and is not an ephemeral path
 * (`/tmp`, `/var/folders`, `/google/src/cloud/`) unless `allowTempWorkspace` is true.
 *
 * @param {string} workspaceDir
 * @param {{ allowTempWorkspace?: boolean }} [opts]
 * @returns {string} realpath of workspaceDir
 */
export function validatePersistentWorkspace(
  workspaceDir,
  { allowTempWorkspace = false } = {}
) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) {
    throw new Error("Workspace directory is required for daemon installation");
  }
  const resolved = path.resolve(workspaceDir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Workspace directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }

  const realWs = fs.realpathSync(resolved);
  if (!allowTempWorkspace) {
    for (const prefix of EPHEMERAL_PREFIXES) {
      if (isUnderPrefix(resolved, prefix) || isUnderPrefix(realWs, prefix)) {
        throw new Error(
          `Refusing to register persistent daemon for ephemeral workspace '${realWs}' (under '${prefix}'). Move the repo to a persistent directory or pass --allow-temp-workspace for testing.`
        );
      }
    }
  }

  return realWs;
}

/**
 * Build the official Antigravity `sidecar.json` configuration (`builtin: "schedule"`,
 * `CRON_TZ=<tz> <cron>` + `agentapi new-conversation`, `restart_policy: "always"`,
 * validated `agent_permissions`).
 *
 * @param {object} opts
 * @returns {object}
 */
export function buildSidecarConfig({
  slug = null,
  workspaceDir,
  profileResult = null,
  cronExpr = null,
  timezone = null,
  model = null,
  title = null,
  description = null,
  accessGrants = undefined,
  includeWorkspaceUri = true,
} = {}) {
  const realWs = resolveRealOrAbs(workspaceDir);
  const fm = profileResult?.frontmatter ?? profileResult?.config ?? {};
  const effectiveProfileName = profileResult?.profileName || fm.name || null;
  const effectiveSlug = validateDaemonSlug(
    slug || computeDaemonSlug(realWs, effectiveProfileName)
  );

  const rawCron =
    cronExpr || fm.cron || (fm.interval_sec ? intervalToCron(fm.interval_sec) : null);
  if (!rawCron) {
    throw new Error(
      "Sidecar configuration requires a 5-field cron expression (--cron) or a cron-mappable interval"
    );
  }
  const normalizedCron = validateCronExpression(rawCron);
  const tz = detectHostTimezone(timezone || fm.timezone || null);

  const rawGrants =
    accessGrants !== undefined
      ? accessGrants
      : Array.isArray(fm.access_grants)
        ? fm.access_grants
        : [];
  const validatedGrants = validateSidecarGrants(rawGrants);

  const prompt =
    typeof profileResult?.prompt === "string" && profileResult.prompt.trim()
      ? profileResult.prompt.trim()
      : "";
  if (!prompt) {
    throw new Error("Cannot build Sidecar config with an empty task prompt");
  }

  const effectiveModel =
    typeof model === "string" && model.trim()
      ? model.trim()
      : typeof fm.worker_model === "string" && fm.worker_model.trim()
        ? fm.worker_model.trim()
        : null;

  const repoName = path.basename(realWs) || "workspace";
  const labelSuffix = effectiveProfileName || repoName;
  const effectiveTitle =
    typeof title === "string" && title.trim()
      ? title.trim()
      : `agy-loop: ${labelSuffix}`;
  const effectiveDisplayName =
    typeof title === "string" && title.trim()
      ? title.trim()
      : `agy-loop (${effectiveProfileName ? `${repoName}/${effectiveProfileName}` : repoName})`;
  const effectiveDescription =
    typeof description === "string" && description.trim()
      ? description.trim()
      : typeof fm.description === "string" && fm.description.trim()
        ? fm.description.trim()
        : `Scheduled agy-loop automation (${effectiveSlug}) for ${realWs}`;

  const args = [
    `CRON_TZ=${tz} ${normalizedCron}`,
    "agentapi",
    "new-conversation",
    ...(effectiveModel ? [`--model=${effectiveModel}`] : []),
    `--title=${effectiveTitle}`,
    "--",
    prompt,
  ];

  const agentPermissions = {};
  if (includeWorkspaceUri !== false) {
    agentPermissions.workspace_uris = [pathToFileURL(realWs).href];
  }
  if (validatedGrants.length > 0) {
    agentPermissions.access_grants = validatedGrants;
  }

  return {
    builtin: "schedule",
    args,
    restart_policy: "always",
    display_name: effectiveDisplayName,
    description: effectiveDescription,
    agent_permissions: agentPermissions,
  };
}

/**
 * Install (or dry-run preview) a native Antigravity Sidecar schedule config at
 * `<homeDir>/.gemini/config/sidecars/<slug>/sidecar.json` and update the daemon registry.
 * Never modifies `user_config.json` or `config.json`.
 *
 * @param {object} opts
 * @returns {object}
 */
export function installSidecarDaemon({
  workspaceDir,
  homeDir = null,
  env = process.env,
  profile = null,
  file = null,
  profileResult = null,
  cron = null,
  cronExpr = null,
  intervalSec = null,
  timezone = null,
  tz = null,
  model = null,
  title = null,
  description = null,
  accessGrants = [],
  includeWorkspaceUri = true,
  allowTempWorkspace = false,
  dryRun = false,
  slug = null,
} = {}) {
  const resolvedHome = homeDir || resolveHome(env);
  const realWs = validatePersistentWorkspace(workspaceDir, { allowTempWorkspace });
  const resolvedProfile =
    profileResult || resolveProfileTask({ workspaceDir: realWs, homeDir: resolvedHome, profile, file });

  const fm = resolvedProfile?.frontmatter ?? {};
  const effectiveSlug = validateDaemonSlug(
    slug || computeDaemonSlug(realWs, resolvedProfile.profileName)
  );

  const effectiveCron =
    cronExpr ||
    cron ||
    (Number.isInteger(intervalSec) ? intervalToCron(intervalSec) : null) ||
    fm.cron ||
    (Number.isInteger(fm.interval_sec) ? intervalToCron(fm.interval_sec) : null);

  if (!effectiveCron) {
    throw new Error(
      "Sidecar daemon requires '--cron \"<5-field>\"' or a cron-mappable interval in CLI or profile frontmatter"
    );
  }

  const effectiveTz = detectHostTimezone(timezone || tz || fm.timezone || null);

  const combinedGrants = [];
  const seenGrants = new Set();
  for (const grantList of [fm.access_grants, accessGrants]) {
    if (!Array.isArray(grantList)) {
      continue;
    }
    for (const g of grantList) {
      const normalized = typeof g === "string" ? g.trim() : g;
      if (!seenGrants.has(normalized)) {
        seenGrants.add(normalized);
        combinedGrants.push(normalized);
      }
    }
  }

  const sidecarConfig = buildSidecarConfig({
    slug: effectiveSlug,
    workspaceDir: realWs,
    profileResult: resolvedProfile,
    cronExpr: effectiveCron,
    timezone: effectiveTz,
    model,
    title,
    description,
    accessGrants: combinedGrants,
    includeWorkspaceUri,
  });

  const sidecarsRoot = path.join(resolvedHome, ".gemini", "config", "sidecars");
  const sidecarDir = assertContainedPath(
    sidecarsRoot,
    path.join(sidecarsRoot, effectiveSlug),
    "sidecar directory"
  );
  const configPath = assertContainedPath(
    sidecarDir,
    path.join(sidecarDir, "sidecar.json"),
    "sidecar config"
  );

  if (!dryRun) {
    writePrettyJsonAtomic(configPath, sidecarConfig);
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    upsertDaemonEntry(
      {
        slug: effectiveSlug,
        mode: "sidecar",
        platform: "sidecar",
        workspace_dir: realWs,
        profile_name: resolvedProfile.profileName || null,
        profile_path: resolvedProfile.path || null,
        cron_expr: validateCronExpression(effectiveCron),
        timezone: effectiveTz,
        interval_sec: null,
        model: model || fm.worker_model || null,
        display_name: sidecarConfig.display_name,
        config_path: configPath,
        artifact_paths: [configPath],
        service_label: effectiveSlug,
        installed_at: nowIso,
        updated_at: nowIso,
      },
      { homeDir: resolvedHome, env }
    );
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    mode: "sidecar",
    slug: effectiveSlug,
    configPath,
    config: sidecarConfig,
    dashboardUrl: "sidecar://dashboard",
    workspaceDir: realWs,
    profileName: resolvedProfile.profileName || null,
    cronExpr: validateCronExpression(effectiveCron),
    timezone: effectiveTz,
  };
}

function expandCronFieldValues(field, min, max, namesMap) {
  if (field === "*") {
    return null;
  }
  const values = new Set();
  for (const tok of field.split(",")) {
    const m = tok.match(/^([^/]+)(?:\/(\d+))?$/);
    const base = m[1];
    const step = m[2] ? Number.parseInt(m[2], 10) : 1;

    const parseAtom = (atom) => {
      const lower = atom.toLowerCase();
      if (namesMap && namesMap.has(lower)) {
        return namesMap.get(lower);
      }
      return Number.parseInt(atom, 10);
    };

    let start;
    let end;
    if (base === "*") {
      if (step === 1) {
        return null;
      }
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const [sStr, eStr] = base.split("-");
      start = parseAtom(sStr);
      end = parseAtom(eStr);
    } else {
      start = parseAtom(base);
      end = m[2] ? max : start;
    }

    for (let v = start; v <= end; v += step) {
      values.add(max === 7 && v === 7 ? 0 : v);
    }
  }
  return Array.from(values).sort((a, b) => a - b);
}

function cronToLaunchdCalendarIntervals(cronExpr) {
  const normalized = validateCronExpression(cronExpr);
  const [minF, hourF, domF, monF, dowF] = normalized.split(" ");

  const minutes = expandCronFieldValues(minF, 0, 59, null);
  const hours = expandCronFieldValues(hourF, 0, 23, null);
  const days = expandCronFieldValues(domF, 1, 31, null);
  const months = expandCronFieldValues(monF, 1, 12, MONTH_NAMES);
  const weekdays = expandCronFieldValues(dowF, 0, 7, DOW_NAMES);

  const dims = [
    { key: "Month", vals: months },
    { key: "Day", vals: days },
    { key: "Weekday", vals: weekdays },
    { key: "Hour", vals: hours },
    { key: "Minute", vals: minutes },
  ].filter((d) => Array.isArray(d.vals));

  let combos = [{}];
  for (const dim of dims) {
    const next = [];
    for (const base of combos) {
      for (const v of dim.vals) {
        next.push({ ...base, [dim.key]: v });
        if (next.length > 512) {
          throw new Error(
            `Cron expression '${normalized}' expands to >512 macOS LaunchAgent StartCalendarInterval entries; simplify the schedule or use --interval.`
          );
        }
      }
    }
    combos = next;
  }

  return combos;
}

function buildRunnerArgs({
  workspaceDir,
  profileName = null,
  profileFile = null,
  singleton = "profile",
  model = null,
  trustProfileCommands = false,
  once = false,
  extraArgs = [],
}) {
  const args = ["run", "--cwd", workspaceDir];
  if (profileFile) {
    args.push("--file", profileFile);
  } else if (profileName) {
    args.push("--profile", profileName);
  }
  args.push("--singleton", singleton || "profile", "--on-conflict", "wake", "--relay-on-wake");
  if (trustProfileCommands) {
    args.push("--trust-profile-commands");
  }
  if (model) {
    args.push("--model", model);
  }
  if (once) {
    args.push("--once");
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs.map(String));
  }
  return args;
}

function renderPlistDict(dictObj, indent = "    ") {
  const keys = Object.keys(dictObj);
  if (keys.length === 0) {
    return `${indent}<dict/>`;
  }
  const lines = [`${indent}<dict>`];
  for (const key of keys) {
    lines.push(`${indent}  <key>${escapeXml(key)}</key>`);
    lines.push(`${indent}  <integer>${dictObj[key]}</integer>`);
  }
  lines.push(`${indent}</dict>`);
  return lines.join("\n");
}

/**
 * Build a macOS `LaunchAgent` plist (`~/Library/LaunchAgents/com.maxlee.<slug>.plist`).
 *
 * @param {object} opts
 * @returns {{ label: string, plistPath: string, plistContent: string, logPath: string, programArguments: string[] }}
 */
export function buildLaunchAgentPlist({
  slug,
  workspaceDir,
  homeDir = null,
  env = process.env,
  nodeBin = process.execPath,
  agyLoopBin = DEFAULT_AGY_LOOP_BIN,
  profileName = null,
  profileFile = null,
  singleton = "profile",
  model = null,
  trustProfileCommands = false,
  once = false,
  extraArgs = [],
  intervalSec = null,
  cronExpr = null,
  logPath = null,
  runAtLoad = false,
} = {}) {
  const cleanSlug = validateDaemonSlug(slug);
  const resolvedHome = homeDir || resolveHome(env);
  const realWs = resolveRealOrAbs(workspaceDir);
  const stateRoot = resolveStateRoot(realWs, env);
  const daemonsDir = path.join(stateRoot, "daemons");
  const resolvedLogPath = logPath
    ? path.resolve(logPath)
    : assertContainedPath(daemonsDir, path.join(daemonsDir, `${cleanSlug}.log`), "daemon log");
  const label = `com.maxlee.${cleanSlug}`;
  const agentsDir = path.join(resolvedHome, "Library", "LaunchAgents");
  const plistPath = assertContainedPath(
    agentsDir,
    path.join(agentsDir, `${label}.plist`),
    "LaunchAgent plist"
  );

  if (!cronExpr && !(Number.isInteger(intervalSec) && intervalSec >= 1)) {
    throw new Error("LaunchAgent plist requires either 'intervalSec' (>= 1) or 'cronExpr'");
  }

  const runnerArgs = buildRunnerArgs({
    workspaceDir: realWs,
    profileName,
    profileFile,
    singleton,
    model,
    trustProfileCommands,
    once,
    extraArgs,
  });
  const programArguments = [nodeBin, agyLoopBin, ...runnerArgs];

  let scheduleXml;
  if (cronExpr) {
    const intervals = cronToLaunchdCalendarIntervals(cronExpr);
    if (intervals.length === 1) {
      scheduleXml = `  <key>StartCalendarInterval</key>\n${renderPlistDict(intervals[0], "  ")}`;
    } else {
      const dicts = intervals.map((item) => renderPlistDict(item, "    ")).join("\n");
      scheduleXml = `  <key>StartCalendarInterval</key>\n  <array>\n${dicts}\n  </array>`;
    }
  } else {
    scheduleXml = `  <key>StartInterval</key>\n  <integer>${intervalSec}</integer>`;
  }

  const pathEnv = env?.PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const programArgsXml = programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(realWs)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(resolvedHome)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
${scheduleXml}
  <key>RunAtLoad</key>
  <${runAtLoad ? "true" : "false"}/>
  <key>StandardOutPath</key>
  <string>${escapeXml(resolvedLogPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(resolvedLogPath)}</string>
</dict>
</plist>
`;

  return {
    label,
    plistPath,
    plistContent,
    logPath: resolvedLogPath,
    programArguments,
  };
}

function cronFieldToSystemd(field, minVal = 0, namesMap = null, zeroPad = false) {
  if (field === "*") {
    return "*";
  }
  const mapVal = (atom) => {
    const lower = atom.toLowerCase();
    if (namesMap && namesMap.has(lower)) {
      const v = namesMap.get(lower);
      return zeroPad ? String(v).padStart(2, "0") : String(v);
    }
    const n = Number.parseInt(atom, 10);
    return zeroPad ? String(n).padStart(2, "0") : String(n);
  };

  return field
    .split(",")
    .map((tok) => {
      const m = tok.match(/^([^/]+)(?:\/(\d+))?$/);
      const base = m[1];
      const step = m[2];
      let outBase;
      if (base === "*") {
        outBase = step
          ? zeroPad
            ? String(minVal).padStart(2, "0")
            : String(minVal)
          : "*";
      } else if (base.includes("-")) {
        const [a, b] = base.split("-");
        outBase = `${mapVal(a)}..${mapVal(b)}`;
      } else {
        outBase = mapVal(base);
      }
      return step ? `${outBase}/${step}` : outBase;
    })
    .join(",");
}

function cronDowToSystemd(field) {
  if (field === "*") {
    return "";
  }
  if (field.includes("/")) {
    const vals = expandCronFieldValues(field, 0, 7, DOW_NAMES);
    if (!vals || vals.length === 0) {
      return "";
    }
    return vals.map((v) => WEEKDAY_NAMES[v]).join(",");
  }

  const toDayNum = (atom) => {
    const lower = atom.toLowerCase();
    if (DOW_NAMES.has(lower)) {
      return DOW_NAMES.get(lower);
    }
    return Number.parseInt(atom, 10);
  };

  const parts = [];
  for (const tok of field.split(",")) {
    if (tok.includes("-")) {
      const [aStr, bStr] = tok.split("-");
      const a = toDayNum(aStr);
      const b = toDayNum(bStr);
      if (a <= b && b <= 6) {
        parts.push(`${WEEKDAY_NAMES[a]}..${WEEKDAY_NAMES[b]}`);
      } else {
        const vals = expandCronFieldValues(tok, 0, 7, DOW_NAMES) || [];
        parts.push(...vals.map((v) => WEEKDAY_NAMES[v]));
      }
    } else {
      const n = toDayNum(tok);
      parts.push(WEEKDAY_NAMES[n === 7 ? 0 : n]);
    }
  }

  return parts.filter(Boolean).join(",");
}

function cronToSystemdOnCalendar(cronExpr, timezone = null) {
  const normalized = validateCronExpression(cronExpr);
  const [minF, hourF, domF, monF, dowF] = normalized.split(" ");
  const dowPart = cronDowToSystemd(dowF);
  const monPart = cronFieldToSystemd(monF, 1, MONTH_NAMES, true);
  const domPart = cronFieldToSystemd(domF, 1, null, true);
  const hourPart = cronFieldToSystemd(hourF, 0, null, true);
  const minPart = cronFieldToSystemd(minF, 0, null, true);

  const calendar = `${dowPart ? `${dowPart} ` : ""}*-${monPart}-${domPart} ${hourPart}:${minPart}:00`;
  return timezone ? `${calendar} ${timezone}` : calendar;
}

/**
 * Build Linux `systemd --user` `.service` (`Type=oneshot`) and `.timer` (`Persistent=true`) unit files.
 *
 * @param {object} opts
 * @returns {{ serviceName: string, timerName: string, servicePath: string, timerPath: string, serviceContent: string, timerContent: string, logPath: string, execStartArgs: string[] }}
 */
export function buildSystemdUnits({
  slug,
  workspaceDir,
  homeDir = null,
  env = process.env,
  nodeBin = process.execPath,
  agyLoopBin = DEFAULT_AGY_LOOP_BIN,
  profileName = null,
  profileFile = null,
  singleton = "profile",
  model = null,
  trustProfileCommands = false,
  once = false,
  extraArgs = [],
  intervalSec = null,
  cronExpr = null,
  timezone = null,
  logPath = null,
  description = null,
} = {}) {
  const cleanSlug = validateDaemonSlug(slug);
  const resolvedHome = homeDir || resolveHome(env);
  const realWs = resolveRealOrAbs(workspaceDir);
  const stateRoot = resolveStateRoot(realWs, env);
  const daemonsDir = path.join(stateRoot, "daemons");
  const resolvedLogPath = logPath
    ? path.resolve(logPath)
    : assertContainedPath(daemonsDir, path.join(daemonsDir, `${cleanSlug}.log`), "daemon log");

  if (!cronExpr && !(Number.isInteger(intervalSec) && intervalSec >= 1)) {
    throw new Error("systemd units require either 'intervalSec' (>= 1) or 'cronExpr'");
  }

  const unitDir = path.join(resolvedHome, ".config", "systemd", "user");
  const serviceName = `${cleanSlug}.service`;
  const timerName = `${cleanSlug}.timer`;
  const servicePath = assertContainedPath(
    unitDir,
    path.join(unitDir, serviceName),
    "systemd service"
  );
  const timerPath = assertContainedPath(
    unitDir,
    path.join(unitDir, timerName),
    "systemd timer"
  );

  const runnerArgs = buildRunnerArgs({
    workspaceDir: realWs,
    profileName,
    profileFile,
    singleton,
    model,
    trustProfileCommands,
    once,
    extraArgs,
  });
  const execStartArgs = [nodeBin, agyLoopBin, ...runnerArgs];
  const execStartLine = execStartArgs.map(escapeSystemdExecArg).join(" ");
  const pathEnv = env?.PATH || process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const rawDesc =
    typeof description === "string" && description.trim()
      ? description.trim()
      : `agy-loop scheduled runner (${cleanSlug})`;
  const safeDesc = escapeSystemdValue(rawDesc, "Description", { flattenNewlines: true });
  const safeWorkDir = escapeSystemdValue(realWs, "WorkingDirectory");
  const safeLogPath = escapeSystemdValue(resolvedLogPath, "StandardOutput/StandardError");

  const serviceContent = `[Unit]
Description=${safeDesc}

[Service]
Type=oneshot
WorkingDirectory=${safeWorkDir}
Environment=${escapeSystemdEnvArg(`HOME=${resolvedHome}`, "Environment HOME")}
Environment=${escapeSystemdEnvArg(`PATH=${pathEnv}`, "Environment PATH")}
ExecStart=${execStartLine}
StandardOutput=append:${safeLogPath}
StandardError=append:${safeLogPath}
`;

  const scheduleLine = cronExpr
    ? `OnCalendar=${cronToSystemdOnCalendar(cronExpr, timezone ? validateIanaTimezone(timezone) : null)}`
    : `OnBootSec=30s\nOnUnitActiveSec=${intervalSec}s`;

  const timerContent = `[Unit]
Description=${safeDesc} timer

[Timer]
${scheduleLine}
Persistent=true

[Install]
WantedBy=timers.target
`;

  return {
    serviceName,
    timerName,
    servicePath,
    timerPath,
    serviceContent,
    timerContent,
    logPath: resolvedLogPath,
    execStartArgs,
  };
}

/**
 * Install (or dry-run preview) a native OS daemon (macOS `LaunchAgent` or Linux `systemd --user`).
 * Supports `platform` override, `dryRun`, `noLoad`, and injectable `execFn`.
 *
 * @param {object} opts
 * @returns {object}
 */
export function installOsDaemon({
  workspaceDir,
  homeDir = null,
  env = process.env,
  platform = process.platform,
  profile = null,
  file = null,
  profileResult = null,
  cron = null,
  cronExpr = null,
  intervalSec = null,
  timezone = null,
  tz = null,
  model = null,
  singleton = null,
  trustProfileCommands = false,
  once = false,
  extraArgs = [],
  nodeBin = process.execPath,
  agyLoopBin = DEFAULT_AGY_LOOP_BIN,
  allowTempWorkspace = false,
  dryRun = false,
  noLoad = false,
  runAtLoad = false,
  execFn = defaultExec,
  slug = null,
} = {}) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(
      `OS daemon installation is supported on macOS ('darwin') and Linux ('linux'); got '${platform}'.`
    );
  }

  const resolvedHome = homeDir || resolveHome(env);
  const realWs = validatePersistentWorkspace(workspaceDir, { allowTempWorkspace });
  const resolvedProfile =
    profileResult || resolveProfileTask({ workspaceDir: realWs, homeDir: resolvedHome, profile, file });

  const fm = resolvedProfile?.frontmatter ?? {};
  if (!trustProfileCommands && (fm.probe_cmd || fm.verify_cmd)) {
    const blocked = [fm.probe_cmd ? "probe_cmd" : null, fm.verify_cmd ? "verify_cmd" : null]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Refusing to register OS daemon for '${resolvedProfile.source || "profile"}' with untrusted frontmatter command(s) (${blocked}): pass --trust-profile-commands (trustProfileCommands: true) if you trust this repository.`
    );
  }

  const effectiveSlug = validateDaemonSlug(
    slug || computeDaemonSlug(realWs, resolvedProfile.profileName)
  );

  const explicitCronRaw = cronExpr || cron || null;
  const hasExplicitInterval = Number.isInteger(intervalSec) && intervalSec >= 1;
  let effectiveCron = null;
  let effectiveInterval = null;
  if (explicitCronRaw) {
    effectiveCron = validateCronExpression(explicitCronRaw);
  } else if (hasExplicitInterval) {
    effectiveInterval = intervalSec;
  } else if (fm.cron) {
    effectiveCron = validateCronExpression(fm.cron);
  } else if (Number.isInteger(fm.interval_sec) && fm.interval_sec >= 1) {
    effectiveInterval = fm.interval_sec;
  }

  if (!effectiveCron && !effectiveInterval) {
    throw new Error(
      "OS daemon requires a schedule: specify --interval <dur> or --cron \"<5-field>\" (or set interval/cron in profile frontmatter)."
    );
  }

  const effectiveTz =
    timezone || tz || fm.timezone ? detectHostTimezone(timezone || tz || fm.timezone) : null;
  const effectiveModel = model || fm.worker_model || null;
  const effectiveSingleton =
    singleton && singleton !== "none" ? singleton : fm.singleton && fm.singleton !== "none" ? fm.singleton : "profile";
  const effectiveOnce = Boolean(once || fm.once);
  const stateRoot = resolveStateRoot(realWs, env);
  const daemonsDir = path.join(stateRoot, "daemons");
  const logPath = assertContainedPath(
    daemonsDir,
    path.join(daemonsDir, `${effectiveSlug}.log`),
    "daemon log"
  );

  const isDefaultSource =
    resolvedProfile?.explicitlySelected === false ||
    resolvedProfile?.source === ".agents/loop.md" ||
    resolvedProfile?.source === "loop.md" ||
    resolvedProfile?.source === "~/.gemini/config/loop.md" ||
    resolvedProfile?.source === "builtin";
  const runnerProfileName = file
    ? null
    : typeof profile === "string" && profile.trim()
      ? profile.trim()
      : !isDefaultSource &&
          resolvedProfile?.scope !== "file" &&
          resolvedProfile?.profileName
        ? resolvedProfile.profileName
        : null;

  if (platform === "darwin") {
    const built = buildLaunchAgentPlist({
      slug: effectiveSlug,
      workspaceDir: realWs,
      homeDir: resolvedHome,
      env,
      nodeBin,
      agyLoopBin,
      profileName: runnerProfileName,
      profileFile: file || null,
      singleton: effectiveSingleton,
      model: effectiveModel,
      trustProfileCommands,
      once: effectiveOnce,
      extraArgs,
      intervalSec: effectiveCron ? null : effectiveInterval,
      cronExpr: effectiveCron,
      logPath,
      runAtLoad,
    });

    if (!dryRun) {
      fs.mkdirSync(path.dirname(built.logPath), { recursive: true });
      writeTextAtomic(built.plistPath, built.plistContent);

      if (!noLoad) {
        const uid = typeof process.getuid === "function" ? process.getuid() : 501;
        const domain = `gui/${uid}`;
        execFn("launchctl", ["bootout", `${domain}/${built.label}`], { env });
        const bootRes = execFn("launchctl", ["bootstrap", domain, built.plistPath], { env });
        if (bootRes.error || bootRes.status !== 0) {
          const detail =
            bootRes.error?.message || bootRes.stderr?.trim() || bootRes.stdout?.trim() || `exit ${bootRes.status}`;
          throw new Error(`launchctl bootstrap failed for ${built.label}: ${detail}`);
        }
      }

      const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      upsertDaemonEntry(
        {
          slug: effectiveSlug,
          mode: "os",
          platform: "darwin",
          workspace_dir: realWs,
          profile_name: resolvedProfile.profileName || null,
          profile_path: resolvedProfile.path || null,
          profile_file: file || null,
          cron_expr: effectiveCron,
          timezone: effectiveTz,
          interval_sec: effectiveCron ? null : effectiveInterval,
          model: effectiveModel,
          singleton: effectiveSingleton,
          service_label: built.label,
          config_path: built.plistPath,
          artifact_paths: [built.plistPath],
          log_path: built.logPath,
          installed_at: nowIso,
          updated_at: nowIso,
        },
        { homeDir: resolvedHome, env }
      );
    }

    return {
      ok: true,
      dryRun: Boolean(dryRun),
      loaded: Boolean(!dryRun && !noLoad),
      mode: "os",
      platform: "darwin",
      slug: effectiveSlug,
      serviceLabel: built.label,
      configPath: built.plistPath,
      artifactPaths: [built.plistPath],
      logPath: built.logPath,
      files: [{ path: built.plistPath, content: built.plistContent }],
      workspaceDir: realWs,
      profileName: resolvedProfile.profileName || null,
    };
  }

  // Linux systemd --user
  const built = buildSystemdUnits({
    slug: effectiveSlug,
    workspaceDir: realWs,
    homeDir: resolvedHome,
    env,
    nodeBin,
    agyLoopBin,
    profileName: runnerProfileName,
    profileFile: file || null,
    singleton: effectiveSingleton,
    model: effectiveModel,
    trustProfileCommands,
    once: effectiveOnce,
    extraArgs,
    intervalSec: effectiveCron ? null : effectiveInterval,
    cronExpr: effectiveCron,
    timezone: effectiveTz,
    logPath,
    description: fm.description || null,
  });

  if (!dryRun) {
    fs.mkdirSync(path.dirname(built.logPath), { recursive: true });
    writeTextAtomic(built.servicePath, built.serviceContent);
    writeTextAtomic(built.timerPath, built.timerContent);

    if (!noLoad) {
      const reloadRes = execFn("systemctl", ["--user", "daemon-reload"], { env });
      if (reloadRes.error || reloadRes.status !== 0) {
        const detail =
          reloadRes.error?.message || reloadRes.stderr?.trim() || reloadRes.stdout?.trim() || `exit ${reloadRes.status}`;
        throw new Error(`systemctl --user daemon-reload failed: ${detail}`);
      }
      const enableRes = execFn("systemctl", ["--user", "enable", "--now", built.timerName], { env });
      if (enableRes.error || enableRes.status !== 0) {
        const detail =
          enableRes.error?.message || enableRes.stderr?.trim() || enableRes.stdout?.trim() || `exit ${enableRes.status}`;
        throw new Error(`systemctl --user enable --now ${built.timerName} failed: ${detail}`);
      }
    }

    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    upsertDaemonEntry(
      {
        slug: effectiveSlug,
        mode: "os",
        platform: "linux",
        workspace_dir: realWs,
        profile_name: resolvedProfile.profileName || null,
        profile_path: resolvedProfile.path || null,
        profile_file: file || null,
        cron_expr: effectiveCron,
        timezone: effectiveTz,
        interval_sec: effectiveCron ? null : effectiveInterval,
        model: effectiveModel,
        singleton: effectiveSingleton,
        service_label: built.timerName,
        config_path: built.timerPath,
        artifact_paths: [built.servicePath, built.timerPath],
        log_path: built.logPath,
        installed_at: nowIso,
        updated_at: nowIso,
      },
      { homeDir: resolvedHome, env }
    );
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    loaded: Boolean(!dryRun && !noLoad),
    mode: "os",
    platform: "linux",
    slug: effectiveSlug,
    serviceLabel: built.timerName,
    configPath: built.timerPath,
    artifactPaths: [built.servicePath, built.timerPath],
    logPath: built.logPath,
    files: [
      { path: built.servicePath, content: built.serviceContent },
      { path: built.timerPath, content: built.timerContent },
    ],
    workspaceDir: realWs,
    profileName: resolvedProfile.profileName || null,
  };
}

function fileExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function discoverManagedDaemonsOnDisk(homeDir) {
  const discovered = [];

  // 1. Sidecars (strictly agy-loop-* only)
  const sidecarsRoot = path.join(homeDir, ".gemini", "config", "sidecars");
  try {
    for (const entry of fs.readdirSync(sidecarsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !VALID_DAEMON_SLUG_RE.test(entry.name)) {
        continue;
      }
      const configPath = path.join(sidecarsRoot, entry.name, "sidecar.json");
      if (!fileExists(configPath)) {
        continue;
      }
      discovered.push({
        slug: entry.name,
        mode: "sidecar",
        platform: "sidecar",
        config_path: configPath,
        artifact_paths: [configPath],
        service_label: entry.name,
      });
    }
  } catch {
    // Ignore missing directory
  }

  // 2. macOS LaunchAgents (strictly com.maxlee.agy-loop-*.plist)
  const agentsDir = path.join(homeDir, "Library", "LaunchAgents");
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.name.startsWith("com.maxlee.agy-loop-") || !entry.name.endsWith(".plist")) {
        continue;
      }
      const label = entry.name.slice(0, -".plist".length);
      const slug = label.slice("com.maxlee.".length);
      if (!VALID_DAEMON_SLUG_RE.test(slug)) {
        continue;
      }
      const plistPath = path.join(agentsDir, entry.name);
      discovered.push({
        slug,
        mode: "os",
        platform: "darwin",
        config_path: plistPath,
        artifact_paths: [plistPath],
        service_label: label,
      });
    }
  } catch {
    // Ignore missing directory
  }

  // 3. Linux systemd user units (strictly agy-loop-*.timer)
  const systemdDir = path.join(homeDir, ".config", "systemd", "user");
  try {
    for (const entry of fs.readdirSync(systemdDir, { withFileTypes: true })) {
      if (!entry.name.startsWith("agy-loop-") || !entry.name.endsWith(".timer")) {
        continue;
      }
      const slug = entry.name.slice(0, -".timer".length);
      if (!VALID_DAEMON_SLUG_RE.test(slug)) {
        continue;
      }
      const timerPath = path.join(systemdDir, entry.name);
      const servicePath = path.join(systemdDir, `${slug}.service`);
      discovered.push({
        slug,
        mode: "os",
        platform: "linux",
        config_path: timerPath,
        artifact_paths: [servicePath, timerPath].filter(fileExists),
        service_label: entry.name,
      });
    }
  } catch {
    // Ignore missing directory
  }

  return discovered;
}

function probeLoadedStatus(entry, { platform, execFn }) {
  if (!execFn || entry.mode !== "os") {
    return null;
  }
  const effectivePlatform = entry.platform || platform;
  try {
    if (effectivePlatform === "darwin" && entry.service_label) {
      const res = execFn("launchctl", ["list", entry.service_label], {});
      if (res && !res.error) {
        return res.status === 0;
      }
    } else if (effectivePlatform === "linux" && entry.service_label) {
      const res = execFn("systemctl", ["--user", "is-active", entry.service_label], {});
      if (res && !res.error) {
        return res.status === 0;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * List managed `agy-loop-*` daemons from the registry merged with on-disk probes.
 * Never touches non-`agy-loop-*` sidecars or OS services.
 *
 * @param {object} [opts]
 * @returns {Array<object>}
 */
export function listDaemons({
  workspaceDir = null,
  global = false,
  homeDir = null,
  env = process.env,
  platform = process.platform,
  checkStatus = false,
  execFn = null,
} = {}) {
  const resolvedHome = homeDir || resolveHome(env);
  const registryEntries = readDaemonRegistry({ homeDir: resolvedHome, env });
  const diskEntries = discoverManagedDaemonsOnDisk(resolvedHome);

  const byKey = new Map();
  const makeKey = (item) => {
    const m = item.mode || "unknown";
    const p = item.platform || (m === "sidecar" ? "sidecar" : platform);
    return `${item.slug}::${m}::${p}`;
  };

  for (const reg of registryEntries) {
    if (!reg.slug || !VALID_DAEMON_SLUG_RE.test(reg.slug)) {
      continue;
    }
    byKey.set(makeKey(reg), { ...reg, in_registry: true });
  }

  for (const disk of diskEntries) {
    const key = makeKey(disk);
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      byKey.set(key, {
        ...disk,
        ...existing,
        config_path: existing.config_path || disk.config_path,
        artifact_paths:
          Array.isArray(existing.artifact_paths) && existing.artifact_paths.length > 0
            ? existing.artifact_paths
            : disk.artifact_paths,
      });
    } else {
      byKey.set(key, { ...disk, in_registry: false });
    }
  }

  const filterWs = workspaceDir && !global ? resolveRealOrAbs(workspaceDir) : null;
  const probeFn = execFn || (checkStatus ? defaultExec : null);
  const results = [];

  for (const item of byKey.values()) {
    if (filterWs) {
      const itemWs = item.workspace_dir ? resolveRealOrAbs(item.workspace_dir) : null;
      if (itemWs !== filterWs) {
        continue;
      }
    }
    const artifacts = Array.isArray(item.artifact_paths)
      ? item.artifact_paths
      : item.config_path
        ? [item.config_path]
        : [];
    const installed = artifacts.length > 0 && artifacts.every(fileExists);
    const loaded = probeFn ? probeLoadedStatus(item, { platform, execFn: probeFn }) : null;

    results.push({
      ...item,
      installed,
      loaded,
    });
  }

  results.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  return results;
}

/**
 * Remove one (`slug`) or all (`all: true`) managed `agy-loop-*` daemons,
 * unloading OS services unless `noUnload` is true and deleting only managed artifacts.
 *
 * @param {object} [opts]
 * @returns {{ ok: boolean, removed: Array<object> }}
 */
export function removeDaemon({
  slug = null,
  mode = null,
  all = false,
  workspaceDir = null,
  homeDir = null,
  noUnload = false,
  env = process.env,
  platform = process.platform,
  execFn = defaultExec,
} = {}) {
  const resolvedHome = homeDir || resolveHome(env);
  if (!all && (!slug || !String(slug).trim())) {
    throw new Error("removeDaemon requires either 'slug' or 'all: true'");
  }
  let cleanTargetSlug = null;
  if (slug !== null && slug !== undefined) {
    const rawSlug = String(slug).trim();
    if (!rawSlug.startsWith("agy-loop-")) {
      throw new Error(
        `Refusing to remove unmanaged daemon '${slug}': agy-loop only manages 'agy-loop-*' artifacts`
      );
    }
    cleanTargetSlug = validateDaemonSlug(rawSlug);
  }

  const allManaged = listDaemons({
    workspaceDir: all && workspaceDir ? workspaceDir : null,
    global: !workspaceDir,
    homeDir: resolvedHome,
    env,
    platform,
  });

  const targets = (all
    ? allManaged
    : allManaged.filter((item) => item.slug === cleanTargetSlug)
  ).filter((item) => !mode || item.mode === mode);

  if (!all && targets.length === 0) {
    throw new Error(`Managed daemon not found: ${cleanTargetSlug}`);
  }

  const removed = [];
  for (const target of targets) {
    if (!target.slug || !VALID_DAEMON_SLUG_RE.test(target.slug)) {
      continue;
    }

    if (target.mode === "sidecar") {
      const sidecarsRoot = path.join(resolvedHome, ".gemini", "config", "sidecars");
      const sidecarDir = assertContainedPath(
        sidecarsRoot,
        path.join(sidecarsRoot, target.slug),
        "sidecar directory"
      );
      fs.rmSync(sidecarDir, { recursive: true, force: true });
    } else if (target.mode === "os") {
      const targetPlatform = target.platform || platform;
      if (targetPlatform === "darwin") {
        const label = `com.maxlee.${target.slug}`;
        const agentsDir = path.join(resolvedHome, "Library", "LaunchAgents");
        const plistPath = assertContainedPath(
          agentsDir,
          path.join(agentsDir, `${label}.plist`),
          "LaunchAgent plist"
        );
        if (!noUnload && execFn) {
          const uid = typeof process.getuid === "function" ? process.getuid() : 501;
          execFn("launchctl", ["bootout", `gui/${uid}/${label}`], { env });
        }
        fs.rmSync(plistPath, { force: true });
      } else if (targetPlatform === "linux") {
        const timerName = `${target.slug}.timer`;
        const serviceName = `${target.slug}.service`;
        const unitDir = path.join(resolvedHome, ".config", "systemd", "user");
        const timerPath = assertContainedPath(
          unitDir,
          path.join(unitDir, timerName),
          "systemd timer"
        );
        const servicePath = assertContainedPath(
          unitDir,
          path.join(unitDir, serviceName),
          "systemd service"
        );
        if (!noUnload && execFn) {
          execFn("systemctl", ["--user", "disable", "--now", timerName], { env });
          execFn("systemctl", ["--user", "daemon-reload"], { env });
        }
        fs.rmSync(timerPath, { force: true });
        fs.rmSync(servicePath, { force: true });
      }
    }

    removeDaemonEntry(target.slug, {
      mode: target.mode,
      platform: target.platform,
      homeDir: resolvedHome,
      env,
    });
    removed.push({
      slug: target.slug,
      mode: target.mode,
      platform: target.platform || null,
      config_path: target.config_path || null,
    });
  }

  return { ok: true, removed };
}

/**
 * Read trailing log lines for a managed OS daemon (or return dashboard instructions for Sidecar).
 *
 * @param {object} opts
 * @returns {object}
 */
export function readDaemonLogs({
  slug,
  tail = 50,
  workspaceDir = null,
  homeDir = null,
  env = process.env,
} = {}) {
  const cleanSlug = validateDaemonSlug(slug);
  const resolvedHome = homeDir || resolveHome(env);
  const daemons = listDaemons({
    global: true,
    homeDir: resolvedHome,
    env,
  });
  const entry = daemons.find((d) => d.slug === cleanSlug) || null;

  if (entry && entry.mode === "sidecar") {
    return {
      ok: true,
      mode: "sidecar",
      slug: cleanSlug,
      logPath: null,
      exists: false,
      lines: [],
      text: "",
      message:
        "Sidecar daemons are managed by Antigravity. Inspect runs via 'agy remote-control status', 'agy-loop ps', or sidecar://dashboard.",
    };
  }

  let logPath = null;
  const ws = entry?.workspace_dir || workspaceDir;
  if (entry?.log_path) {
    const candidateLog = path.resolve(entry.log_path);
    if (path.basename(candidateLog) !== `${cleanSlug}.log`) {
      throw new Error(
        `Unsafe daemon log path '${candidateLog}' does not match slug '${cleanSlug}'`
      );
    }
    if (ws) {
      const daemonsDir = path.join(resolveStateRoot(ws, env), "daemons");
      logPath = assertContainedPath(daemonsDir, candidateLog, "daemon log");
    } else if (path.basename(path.dirname(candidateLog)) !== "daemons") {
      throw new Error(
        `Unsafe daemon log path '${candidateLog}': must reside in a 'daemons' directory`
      );
    } else {
      logPath = candidateLog;
    }
  } else if (ws) {
    const daemonsDir = path.join(resolveStateRoot(ws, env), "daemons");
    logPath = assertContainedPath(
      daemonsDir,
      path.join(daemonsDir, `${cleanSlug}.log`),
      "daemon log"
    );
  }

  if (!logPath || !fileExists(logPath)) {
    return {
      ok: true,
      mode: entry?.mode || "os",
      slug: cleanSlug,
      logPath,
      exists: false,
      lines: [],
      text: "",
      message: logPath ? `No log output yet at ${logPath}` : `Daemon '${cleanSlug}' log path unknown`,
    };
  }

  const raw = fs.readFileSync(logPath, "utf8");
  const allLines = raw.split(/\r?\n/);
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const limit = Number.isInteger(tail) && tail > 0 ? tail : 50;
  const lines = allLines.slice(-limit);
  return {
    ok: true,
    mode: entry?.mode || "os",
    slug: cleanSlug,
    logPath,
    exists: true,
    lines,
    text: lines.join("\n"),
    message: null,
  };
}
