/**
 * CLI argument parser and help formatter for `agy-loop run`.
 * Parity with loop-helper.sh interval grammar plus headless runner options.
 */

import {
  isUnitWord,
  parseDurationStrict,
  tryParseCompactDuration,
  tryParseSplitDuration,
} from "./duration.mjs";
import { VALID_PROFILE_NAME_RE, validateProfileName } from "./profile-parser.mjs";

const UNIT_SECONDS = Object.freeze({
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
});

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const VALID_MODES = new Set(["auto", "accept-edits", "plan"]);
const VALID_SINGLETONS = new Set(["profile", "workspace", "none"]);
const VALID_ON_CONFLICT = new Set(["wake", "skip", "fail"]);

const FLAG_ALIASES = Object.freeze({
  "--statefull": "--stateful",
  "--stateless": "--fresh",
  "--state-full": "--stateful",
  "--work-tree": "--worktree",
  "--worktrees": "--worktree",
  "--work_tree": "--worktree",
  "--max-iter": "--max",
  "--max-iters": "--max",
  "--max-iteration": "--max",
  "--max-iterations": "--max",
  "--max-runs": "--max",
  "--models": "--model",
  "--onces": "--once",
  "--freshes": "--fresh",
  "--freshs": "--fresh",
  "--verify-command": "--verify-cmd",
  "--verify_cmd": "--verify-cmd",
  "--verify_timeout": "--verify-timeout",
  "--verify-timeouts": "--verify-timeout",
  "--profiles": "--profile",
  "--files": "--file",
  "--singletons": "--singleton",
  "--on_conflict": "--on-conflict",
  "--on-conflicts": "--on-conflict",
  "--trust_profile_commands": "--trust-profile-commands",
  "--relay_on_wake": "--relay-on-wake",
});

function stripTrailingComma(token) {
  if (token.length > 1 && token.endsWith(",")) {
    return token.slice(0, -1);
  }
  return token;
}

function parsePositiveInt(raw, flagName) {
  const trimmed = String(raw ?? "").trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid ${flagName} value: '${trimmed}' (expected integer >= 1)`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${flagName} value: '${trimmed}' (expected safe integer >= 1)`);
  }
  return parsed;
}

function parseNonNegInt(raw, flagName) {
  const trimmed = String(raw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${flagName} value: '${trimmed}' (expected integer >= 0)`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName} value: '${trimmed}' (expected safe integer >= 0)`);
  }
  return parsed;
}

function requireNonEmptyValue(raw, flagName) {
  const val = String(raw ?? "").trim();
  if (!val) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return val;
}

/**
 * Formats usage and options help text for `agy-loop run`.
 *
 * @returns {string}
 */
export function formatRunHelp() {
  return `Usage:
  agy-loop run [interval] [prompt...] [options]

Interval Grammar:
  30s, 5m, 1h30m, 2m30s, 1d12h   Fixed interval before prompt
  5 minutes                      Split number + unit before prompt
  every 5m / every hour          Leading or trailing fixed interval
  in 20m / in 2 hours            Delayed one-shot execution (implies --once)
  (omit prompt)                  Live-reloads .agents/loop.md -> loop.md -> ~/.gemini/config/loop.md -> built-in

Scheduling & Budgets:
  --max <N>                      Maximum iterations (default: 20, or 1 with --once)
  --once                         Run a single iteration and exit
  --fresh                        Start a fresh agy invocation every turn (default)
  --stateful                     Reuse a persistent stream-json session across turns
  --reset-every <N>              Rotate stateful session every N iterations (requires --stateful)
  --max-duration <dur>           Hard wall-clock budget (e.g. 30m, 2h)
  --max-tokens <N>               Hard cumulative token budget across turns
  --max-retries <N>              Max retries for retryable turn failures (default: 3)
  --max-errors <N>               Circuit breaker threshold for consecutive errors (default: 3)

Model & Permissions:
  --model <slug|label>           Primary worker model slug or display name
  --effort <level>               Reasoning effort: low|medium|high|xhigh|max (omitted for Orchestrator)
  --fallback-model <slug|label>  Fallback model on quota/rate-limit/capacity errors
  --verifier-model <slug|label>  Independent read-only verifier model when worker reports DONE
  --mode <mode>                  Execution mode: auto|accept-edits|plan (default: inherit agy config)
  --sandbox                      Run agy turns inside sandbox mode
  --dangerously-skip-permissions Auto-approve tool permission prompts
  --allow-slash-commands         Allow slash command and skill expansion in print mode
  --settings <json|path>         Session-only settings JSON or file path
  --add-dir <dir>                Add extra workspace directory (repeatable)
  --worktree                     Run in an isolated Git worktree (<state>/worktrees/<loop_id>)
  --keep-worktree                Preserve isolated worktree even if clean with 0 commits
  --turn-timeout <dur>           Per-turn timeout passed to agy --print-timeout (default: 10m)
  --fail-on-denied               Treat soft-denied headless tool calls as BLOCKED (exit 3)

Verification, Probe & Output:
  --verify-cmd <cmd>             Deterministic verification command on DONE (0 LLM tokens)
  --verify-timeout <dur>         Timeout for --verify-cmd command (default: 60s)
  --probe <cmd>                  Run shell pre-check before each turn (0 tokens on --probe-until-pass)
  --probe-timeout <dur>          Timeout for --probe command (default: 60s)
  --probe-until-pass             Finish DONE (exit 0) as soon as --probe exits 0 (requires --probe)
  --cwd <dir>                    Target workspace directory (default: current directory)
  --json                         Emit final structured summary JSON to stdout
  --quiet                        Suppress non-error progress lines
  -h, --help                     Show this help message
  --                             End of options; remaining tokens are literal prompt text

Profiles & Single-Instance Lease Lock:
  --profile <name>               Load named profile (.agents/loops/<name>.md or ~/.gemini/config/loops/<name>.md)
  --file <path>                  Load explicit Markdown task/profile file (mutually exclusive with --profile)
  --singleton <scope>            Lease lock scope: profile|workspace|none (default: profile with --profile/--file, else none)
  --on-conflict <action>         Action when active lock exists: fail|wake|skip (default: fail)
  --trust-profile-commands       Allow executing probe_cmd/verify_cmd declared in profile frontmatter
  --relay-on-wake                Continue into another turn if a wake arrives right as DONE completes

Exit Codes:
  0    DONE (or --once completing cleanly)
  1    Runtime error or circuit broken
  2    CLI argument or configuration error
  3    BLOCKED (worker blocked, hard quota, or --fail-on-denied)
  4    Budget exhausted (max iterations, max duration, or max tokens)
  5    LOCK_CONFLICT (active singleton lease held and --on-conflict fail)
  130  Stopped by SIGINT/SIGTERM or 'agy-loop stop'
`;
}

/**
 * Parses `agy-loop run` CLI arguments into normalized options or a structured exit-code-2 error.
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseRunArgs(argv) {
  if (!Array.isArray(argv)) {
    return { ok: false, error: "Invalid arguments array", exitCode: 2 };
  }

  const explicitFlags = new Set();

  let maxSet = false;
  let maxVal = 20;
  let once = false;
  let statefulFlag = false;
  let freshFlag = false;
  let stateMode = "fresh";
  let resetEvery = null;
  let maxDurationSec = null;
  let maxTokens = null;
  let maxRetries = 3;
  let maxErrors = 3;

  let model = null;
  let effort = null;
  let fallbackModel = null;
  let verifierModel = null;
  let mode = null;
  let sandbox = false;
  let dangerouslySkipPermissions = false;
  let allowSlashCommands = false;
  let settingsArg = null;
  const addDirs = [];
  let worktree = false;
  let keepWorktree = false;
  let turnTimeoutSec = 600;
  let failOnDenied = false;

  let verifyCmd = null;
  let verifyTimeoutSec = 60;
  let probeCmd = null;
  let probeTimeoutSec = 60;
  let probeUntilPass = false;
  let json = false;
  let quiet = false;
  let cwd = null;

  let profile = null;
  let profileFile = null;
  let singleton = null;
  let onConflict = null;
  let trustProfileCommands = false;
  let relayOnWake = false;

  let endOfOptions = false;
  const positionalBeforeEnd = [];
  const positionalAfterEnd = [];

  try {
    for (let i = 0; i < argv.length; i += 1) {
      const arg = String(argv[i]);

      if (endOfOptions) {
        positionalAfterEnd.push(arg);
        continue;
      }

      if (arg === "--") {
        endOfOptions = true;
        continue;
      }

      if (arg === "-h" || arg === "--help") {
        return { ok: true, help: true };
      }

      const eqIdx = arg.indexOf("=");
      const flag = eqIdx > 0 && arg.startsWith("-") ? arg.slice(0, eqIdx) : arg;
      const hasInlineVal = eqIdx > 0 && arg.startsWith("-");
      const inlineVal = hasInlineVal ? arg.slice(eqIdx + 1) : null;

      const readValue = () => {
        if (hasInlineVal) {
          return requireNonEmptyValue(inlineVal, flag);
        }
        if (i + 1 >= argv.length) {
          throw new Error(`Missing value for ${flag}`);
        }
        i += 1;
        return requireNonEmptyValue(argv[i], flag);
      };

      const ensureBooleanOnly = () => {
        if (hasInlineVal) {
          throw new Error(`Option ${flag} does not take a value`);
        }
      };

      switch (flag) {
        case "--once":
          ensureBooleanOnly();
          once = true;
          explicitFlags.add("once");
          break;
        case "--stateful":
          ensureBooleanOnly();
          if (freshFlag) {
            throw new Error("Conflicting flags: --stateful and --fresh cannot be combined");
          }
          statefulFlag = true;
          stateMode = "stateful";
          explicitFlags.add("stateMode");
          break;
        case "--fresh":
          ensureBooleanOnly();
          if (statefulFlag) {
            throw new Error("Conflicting flags: --stateful and --fresh cannot be combined");
          }
          freshFlag = true;
          stateMode = "fresh";
          explicitFlags.add("stateMode");
          break;
        case "--sandbox":
          ensureBooleanOnly();
          sandbox = true;
          explicitFlags.add("sandbox");
          break;
        case "--dangerously-skip-permissions":
          ensureBooleanOnly();
          dangerouslySkipPermissions = true;
          explicitFlags.add("dangerouslySkipPermissions");
          break;
        case "--allow-slash-commands":
          ensureBooleanOnly();
          allowSlashCommands = true;
          explicitFlags.add("allowSlashCommands");
          break;
        case "--worktree":
          ensureBooleanOnly();
          worktree = true;
          explicitFlags.add("worktree");
          break;
        case "--keep-worktree":
          ensureBooleanOnly();
          keepWorktree = true;
          explicitFlags.add("keepWorktree");
          break;
        case "--fail-on-denied":
          ensureBooleanOnly();
          failOnDenied = true;
          explicitFlags.add("failOnDenied");
          break;
        case "--probe-until-pass":
          ensureBooleanOnly();
          probeUntilPass = true;
          explicitFlags.add("probeUntilPass");
          break;
        case "--json":
          ensureBooleanOnly();
          json = true;
          explicitFlags.add("json");
          break;
        case "--quiet":
          ensureBooleanOnly();
          quiet = true;
          explicitFlags.add("quiet");
          break;
        case "--trust-profile-commands":
          ensureBooleanOnly();
          trustProfileCommands = true;
          explicitFlags.add("trustProfileCommands");
          break;
        case "--relay-on-wake":
          ensureBooleanOnly();
          relayOnWake = true;
          explicitFlags.add("relayOnWake");
          break;
        case "--max":
          maxVal = parsePositiveInt(readValue(), "--max");
          maxSet = true;
          explicitFlags.add("maxIterations");
          break;
        case "--reset-every":
          resetEvery = parsePositiveInt(readValue(), "--reset-every");
          explicitFlags.add("resetEvery");
          break;
        case "--max-duration":
          maxDurationSec = parseDurationStrict(readValue(), "--max-duration").seconds;
          explicitFlags.add("maxDurationSec");
          break;
        case "--max-tokens":
          maxTokens = parsePositiveInt(readValue(), "--max-tokens");
          explicitFlags.add("maxTokens");
          break;
        case "--max-retries":
          maxRetries = parseNonNegInt(readValue(), "--max-retries");
          explicitFlags.add("maxRetries");
          break;
        case "--max-errors":
          maxErrors = parsePositiveInt(readValue(), "--max-errors");
          explicitFlags.add("maxErrors");
          break;
        case "--model":
          model = readValue();
          explicitFlags.add("model");
          break;
        case "--effort": {
          const val = readValue().toLowerCase();
          if (!VALID_EFFORTS.has(val)) {
            throw new Error(
              `Invalid --effort value: '${val}' (expected low, medium, high, xhigh, or max)`
            );
          }
          effort = val;
          explicitFlags.add("effort");
          break;
        }
        case "--fallback-model":
          fallbackModel = readValue();
          explicitFlags.add("fallbackModel");
          break;
        case "--verifier-model":
          verifierModel = readValue();
          explicitFlags.add("verifierModel");
          break;
        case "--mode": {
          const val = readValue().toLowerCase();
          if (!VALID_MODES.has(val)) {
            throw new Error(
              `Invalid --mode value: '${val}' (expected auto, accept-edits, or plan)`
            );
          }
          mode = val;
          explicitFlags.add("mode");
          break;
        }
        case "--settings":
          settingsArg = readValue();
          explicitFlags.add("settingsArg");
          break;
        case "--add-dir":
          addDirs.push(readValue());
          explicitFlags.add("addDirs");
          break;
        case "--turn-timeout":
          turnTimeoutSec = parseDurationStrict(readValue(), "--turn-timeout").seconds;
          explicitFlags.add("turnTimeoutSec");
          break;
        case "--verify-cmd":
          verifyCmd = readValue();
          explicitFlags.add("verifyCmd");
          break;
        case "--verify-timeout":
          verifyTimeoutSec = parseDurationStrict(readValue(), "--verify-timeout").seconds;
          explicitFlags.add("verifyTimeoutSec");
          break;
        case "--probe":
          probeCmd = readValue();
          explicitFlags.add("probeCmd");
          break;
        case "--probe-timeout":
          probeTimeoutSec = parseDurationStrict(readValue(), "--probe-timeout").seconds;
          explicitFlags.add("probeTimeoutSec");
          break;
        case "--cwd":
          cwd = readValue();
          explicitFlags.add("cwd");
          break;
        case "--profile": {
          const val = readValue();
          if (profileFile !== null) {
            throw new Error("Conflicting options: --profile and --file cannot be combined");
          }
          if (!validateProfileName(val)) {
            throw new Error(
              `Invalid --profile name '${val}': must match ${VALID_PROFILE_NAME_RE} (no '/', '\\\\', '..', or whitespace)`
            );
          }
          profile = val;
          explicitFlags.add("profile");
          break;
        }
        case "--file": {
          const val = readValue();
          if (profile !== null) {
            throw new Error("Conflicting options: --profile and --file cannot be combined");
          }
          profileFile = val;
          explicitFlags.add("profileFile");
          break;
        }
        case "--singleton": {
          const val = readValue().toLowerCase();
          if (!VALID_SINGLETONS.has(val)) {
            throw new Error(
              `Invalid --singleton value: '${val}' (expected profile, workspace, or none)`
            );
          }
          singleton = val;
          explicitFlags.add("singleton");
          break;
        }
        case "--on-conflict": {
          const val = readValue().toLowerCase();
          if (!VALID_ON_CONFLICT.has(val)) {
            throw new Error(
              `Invalid --on-conflict value: '${val}' (expected wake, skip, or fail)`
            );
          }
          onConflict = val;
          explicitFlags.add("onConflict");
          break;
        }
        default: {
          if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
            const alias = FLAG_ALIASES[flag.toLowerCase()];
            const suggestion = alias ? ` (did you mean ${alias}?)` : "";
            throw new Error(
              `Unknown option: ${flag}${suggestion}. Put '--' before prompt text if literal.`
            );
          }
          positionalBeforeEnd.push(arg);
          break;
        }
      }
    }

    // Parse leading / trailing interval grammar strictly from tokens before `--`.
    let hasInterval = false;
    let intervalSec = null;
    let intervalLabel = null;
    let startIdx = 0;
    let endIdx = positionalBeforeEnd.length;

    const firstLower = positionalBeforeEnd[0]?.toLowerCase() ?? "";
    const secondLower = positionalBeforeEnd[1]?.toLowerCase() ?? "";

    if (positionalBeforeEnd.length >= 2 && firstLower === "in") {
      const compact = tryParseCompactDuration(positionalBeforeEnd[1]);
      if (compact) {
        once = true;
        hasInterval = true;
        intervalSec = compact.seconds;
        intervalLabel = compact.label;
        startIdx = 2;
      } else if (positionalBeforeEnd.length >= 3) {
        const split = tryParseSplitDuration(positionalBeforeEnd[1], positionalBeforeEnd[2]);
        if (split) {
          once = true;
          hasInterval = true;
          intervalSec = split.seconds;
          intervalLabel = split.label;
          startIdx = 3;
        } else if (secondLower === "a" || secondLower === "an") {
          const unit = isUnitWord(positionalBeforeEnd[2]);
          if (unit) {
            once = true;
            hasInterval = true;
            intervalSec = UNIT_SECONDS[unit];
            intervalLabel = `1${unit}`;
            startIdx = 3;
          }
        }
      }
    } else if (positionalBeforeEnd.length >= 2 && firstLower === "every") {
      const compact = tryParseCompactDuration(positionalBeforeEnd[1]);
      if (compact) {
        hasInterval = true;
        intervalSec = compact.seconds;
        intervalLabel = compact.label;
        startIdx = 2;
      } else if (
        positionalBeforeEnd.length >= 3 &&
        tryParseSplitDuration(positionalBeforeEnd[1], positionalBeforeEnd[2])
      ) {
        const split = tryParseSplitDuration(positionalBeforeEnd[1], positionalBeforeEnd[2]);
        hasInterval = true;
        intervalSec = split.seconds;
        intervalLabel = split.label;
        startIdx = 3;
      } else {
        const unit = isUnitWord(positionalBeforeEnd[1]);
        if (unit) {
          hasInterval = true;
          intervalSec = UNIT_SECONDS[unit];
          intervalLabel = `1${unit}`;
          startIdx = 2;
        }
      }
    } else if (positionalBeforeEnd.length >= 1) {
      const compact = tryParseCompactDuration(positionalBeforeEnd[0]);
      if (compact) {
        hasInterval = true;
        intervalSec = compact.seconds;
        intervalLabel = compact.label;
        startIdx = 1;
      } else if (positionalBeforeEnd.length >= 2) {
        const split = tryParseSplitDuration(positionalBeforeEnd[0], positionalBeforeEnd[1]);
        if (split) {
          hasInterval = true;
          intervalSec = split.seconds;
          intervalLabel = split.label;
          startIdx = 2;
        }
      }
    }

    if (!hasInterval) {
      const n = positionalBeforeEnd.length;
      if (
        n >= 3 &&
        positionalBeforeEnd[n - 3].toLowerCase() === "every"
      ) {
        const split = tryParseSplitDuration(
          positionalBeforeEnd[n - 2],
          positionalBeforeEnd[n - 1]
        );
        if (split) {
          hasInterval = true;
          intervalSec = split.seconds;
          intervalLabel = split.label;
          endIdx = n - 3;
        }
      }
      if (
        !hasInterval &&
        n >= 2 &&
        positionalBeforeEnd[n - 2].toLowerCase() === "every"
      ) {
        const compact = tryParseCompactDuration(positionalBeforeEnd[n - 1]);
        if (compact) {
          hasInterval = true;
          intervalSec = compact.seconds;
          intervalLabel = compact.label;
          endIdx = n - 2;
        } else {
          const unit = isUnitWord(positionalBeforeEnd[n - 1]);
          if (unit) {
            hasInterval = true;
            intervalSec = UNIT_SECONDS[unit];
            intervalLabel = `1${unit}`;
            endIdx = n - 2;
          }
        }
      }

      if (hasInterval && endIdx > startIdx) {
        positionalBeforeEnd[endIdx - 1] = stripTrailingComma(positionalBeforeEnd[endIdx - 1]);
      }
    }

    if (hasInterval) {
      explicitFlags.add("interval");
      explicitFlags.add("intervalSec");
      explicitFlags.add("pacing");
      if (once) {
        explicitFlags.add("once");
      }
    }

    if (once && maxSet && maxVal > 1) {
      throw new Error(
        "Conflicting flags: one-shot mode (--once or in <delay>) cannot use --max > 1"
      );
    }

    if (resetEvery !== null && !statefulFlag) {
      throw new Error("Conflicting flags: --reset-every requires --stateful");
    }

    if (probeUntilPass && !probeCmd) {
      throw new Error("Conflicting flags: --probe-until-pass requires --probe <cmd>");
    }

    const promptTokens = [
      ...positionalBeforeEnd.slice(startIdx, endIdx),
      ...positionalAfterEnd,
    ];
    const prompt = promptTokens.join(" ").trim();
    if ((profile !== null || profileFile !== null) && prompt) {
      throw new Error(
        "Conflicting options: --profile and --file cannot be combined with an inline prompt"
      );
    }

    const maxIterations = maxSet ? maxVal : once ? 1 : 20;

    return {
      ok: true,
      help: false,
      pacing: hasInterval ? "fixed" : "dynamic",
      once,
      intervalSec,
      intervalLabel,
      maxIterations,
      stateMode,
      resetEvery,
      maxDurationSec,
      maxTokens,
      maxRetries,
      maxErrors,
      model,
      effort,
      fallbackModel,
      verifierModel,
      mode,
      sandbox,
      dangerouslySkipPermissions,
      allowSlashCommands,
      settingsArg,
      addDirs,
      worktree,
      keepWorktree,
      workspace: worktree ? "branch" : "inherit",
      turnTimeoutSec,
      failOnDenied,
      verifyCmd,
      verifyTimeoutSec,
      probeCmd,
      probeTimeoutSec,
      probeUntilPass,
      json,
      quiet,
      cwd,
      profile,
      profileFile,
      singleton,
      onConflict,
      trustProfileCommands,
      relayOnWake,
      explicitFlags,
      taskSource: prompt ? "inline" : "loop_md_or_default",
      prompt,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      exitCode: 2,
    };
  }
}
