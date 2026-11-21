import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  EMPTY_USAGE,
  computeUsageDelta,
  normalizeUsage,
  parseAgyError,
} from "./error-policy.mjs";
import {
  buildAgyCommonFlags,
  forceTerminateChild,
  prepareAgyEnv,
  schedulePipeCloseFallback,
} from "./json-client.mjs";

const MAX_STDERR_CHARS = 262144;

/**
 * Builds `agy` arguments for persistent bidirectional `stream-json` sessions.
 * Never includes `-p` / `--print`.
 */
export function buildStreamArgs({
  schemaPath = null,
  turnTimeoutSec = null,
  model = null,
  effort = null,
  mode = null,
  sandbox = false,
  dangerouslySkipPermissions = false,
  allowSlashCommands = false,
  settingsArg = null,
  addDirs = [],
  conversationId = null,
} = {}) {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    ...buildAgyCommonFlags({
      schemaPath,
      turnTimeoutSec,
      model,
      effort,
      mode,
      sandbox,
      dangerouslySkipPermissions,
      allowSlashCommands,
      settingsArg,
      addDirs,
      conversationId,
    }),
  ];
}

/**
 * Manages a long-lived `agy --input-format stream-json --output-format stream-json`
 * child process across multiple NDJSON turns.
 */
export class StreamSession {
  constructor({
    agyBin = "agy",
    cwd,
    env = process.env,
    schemaPath = null,
    turnTimeoutSec = 600,
    model = null,
    effort = null,
    mode = null,
    sandbox = false,
    dangerouslySkipPermissions = false,
    allowSlashCommands = false,
    settingsArg = null,
    addDirs = [],
    conversationId = null,
    onStepUpdate = null,
    isolateSessionEnv = false,
    outerTimeoutMs = null,
    errorGraceMs = 1500,
  } = {}) {
    this._agyBin = agyBin;
    this._cwd = cwd;
    this._env = env;
    this._schemaPath = schemaPath;
    this._turnTimeoutSec = turnTimeoutSec;
    this._model = model;
    this._effort = effort;
    this._mode = mode;
    this._sandbox = sandbox;
    this._dangerouslySkipPermissions = dangerouslySkipPermissions;
    this._allowSlashCommands = allowSlashCommands;
    this._settingsArg = settingsArg;
    this._addDirs = Array.isArray(addDirs) ? [...addDirs] : [];
    this._onStepUpdate = typeof onStepUpdate === "function" ? onStepUpdate : null;
    this._isolateSessionEnv = Boolean(isolateSessionEnv);
    this._outerTimeoutMs = outerTimeoutMs;
    this._errorGraceMs =
      Number.isFinite(Number(errorGraceMs)) && Number(errorGraceMs) > 0
        ? Number(errorGraceMs)
        : 1500;

    this._child = null;
    this._conversationId = conversationId || null;
    this._prevTotals = { ...EMPTY_USAGE };
    this._alive = false;
    this._stdoutBuf = "";
    this._stderrBuf = "";
    this._pendingTurn = null;
    this._initReceived = false;

    this._started = false;
    this._closed = false;
    this._turnCount = 0;
    this._exitCode = null;
    this._stdoutDecoder = null;
    this._stderrDecoder = null;
    this._spawnError = null;
    this._closePromise = null;
    this._closeWaiters = [];
  }

  get conversationId() {
    return this._conversationId;
  }

  get alive() {
    return this._alive;
  }

  get pid() {
    return this._child?.pid ?? null;
  }

  _appendStderr(text) {
    if (!text) {
      return;
    }
    this._stderrBuf += text;
    if (this._stderrBuf.length > MAX_STDERR_CHARS) {
      this._stderrBuf = this._stderrBuf.slice(-MAX_STDERR_CHARS);
    }
  }

  _drainStdoutLines(flush = false, closeInfo = null) {
    let nlIdx = this._stdoutBuf.indexOf("\n");
    while (nlIdx !== -1) {
      const line = this._stdoutBuf.slice(0, nlIdx).replace(/\r$/, "");
      this._stdoutBuf = this._stdoutBuf.slice(nlIdx + 1);
      this._handleStdoutLine(line, closeInfo);
      nlIdx = this._stdoutBuf.indexOf("\n");
    }
    if (flush && this._stdoutBuf.length > 0) {
      const trailing = this._stdoutBuf.replace(/\r$/, "");
      this._stdoutBuf = "";
      this._handleStdoutLine(trailing, closeInfo);
    }
  }

  _handleStdoutLine(line, closeInfo = null) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") {
      return;
    }

    if (msg.event === "init") {
      this._initReceived = true;
      this._conversationId =
        msg.conversation_id || msg.init?.conversation_id || this._conversationId;
      return;
    }

    if (msg.event === "step_update") {
      const payload = msg.step_update;
      const toolName =
        payload?.tool_name ??
        payload?.tool_info?.name ??
        msg.tool_name ??
        msg.tool_info?.name;
      if (this._pendingTurn && toolName === "finish") {
        this._pendingTurn.sawFinishTool = true;
      }
      if (msg.conversation_id || payload?.conversation_id) {
        this._conversationId =
          msg.conversation_id || payload?.conversation_id || this._conversationId;
      }
      if (this._onStepUpdate) {
        try {
          this._onStepUpdate(payload);
        } catch {
          // Protect stream loop from listener exceptions.
        }
      }
      return;
    }

    if (msg.event === "result") {
      const res = msg.result && typeof msg.result === "object" ? msg.result : msg;
      this._conversationId =
        res.conversation_id || msg.conversation_id || this._conversationId;
      const totals = normalizeUsage(
        res.usage,
        res.duration_seconds,
        res.num_turns
      );
      const { delta, nextTotals } = computeUsageDelta(totals, this._prevTotals);
      this._prevTotals = nextTotals;

      const turn = this._pendingTurn;
      if (!turn || turn.resolved) {
        return;
      }

      const isErrorResult =
        res.status === "ERROR" || res.finished_reason === "error";
      const isPrintTimeout = res.finished_reason === "print_timeout";

      turn.lastResult = res;
      turn.lastUsageDelta = delta;
      if (isErrorResult) {
        turn.sawErrorResult = true;
      }
      if (isPrintTimeout) {
        turn.timedOut = true;
      }

      // If draining on child close, defer resolution to _finalizeChildExit when
      // exit code is non-zero or result indicates an error/timeout.
      if (closeInfo?.fromClose) {
        if (closeInfo.code === 0 && !isErrorResult && !isPrintTimeout) {
          const turnStderr = this._stderrBuf;
          turn.resolve({
            exitCode: 0,
            crashed: false,
            aborted: false,
            timedOut: false,
            result: res,
            agyError: parseAgyError(turnStderr),
            rawStderr: turnStderr,
            sawFinishTool: turn.sawFinishTool,
            usageDelta: delta,
          });
        }
        return;
      }

      if (isErrorResult) {
        // agy typically prints AGY_ERROR/stderr and exits immediately after ERROR result.
        // Wait for _finalizeChildExit to capture real exitCode & full stderr, with a grace fallback.
        if (turn.errorGraceTimer === null) {
          turn.errorGraceTimer = setTimeout(() => {
            if (turn.resolved) {
              return;
            }
            const turnStderr = this._stderrBuf;
            turn.resolve({
              exitCode: 3,
              crashed: true,
              aborted: false,
              timedOut: Boolean(turn.timedOut),
              result: turn.lastResult,
              agyError: parseAgyError(turnStderr),
              rawStderr: turnStderr,
              sawFinishTool: turn.sawFinishTool,
              usageDelta: turn.lastUsageDelta ?? { ...EMPTY_USAGE },
            });
          }, this._errorGraceMs);
          turn.errorGraceTimer.unref?.();
        }
        return;
      }

      const turnStderr = this._stderrBuf;
      if (isPrintTimeout) {
        turn.resolve({
          exitCode: 3,
          crashed: false,
          aborted: false,
          timedOut: true,
          result: res,
          agyError: parseAgyError(turnStderr),
          rawStderr: turnStderr,
          sawFinishTool: turn.sawFinishTool,
          usageDelta: delta,
        });
        return;
      }

      turn.resolve({
        exitCode: 0,
        crashed: false,
        aborted: false,
        timedOut: false,
        result: res,
        agyError: parseAgyError(turnStderr),
        rawStderr: turnStderr,
        sawFinishTool: turn.sawFinishTool,
        usageDelta: delta,
      });
    }
  }

  _finalizeChildExit(code) {
    this._exitCode = code;

    if (this._stderrDecoder) {
      this._appendStderr(this._stderrDecoder.end());
      this._stderrDecoder = null;
    }
    if (this._spawnError && !this._stderrBuf) {
      this._appendStderr(this._spawnError.message || String(this._spawnError));
    }

    if (this._stdoutDecoder) {
      this._stdoutBuf += this._stdoutDecoder.end();
      this._stdoutDecoder = null;
    }
    this._drainStdoutLines(true, { fromClose: true, code });

    this._alive = false;

    const turn = this._pendingTurn;
    if (turn && !turn.resolved) {
      const turnStderr = this._stderrBuf;
      let exitCode;
      if (turn.aborted) {
        exitCode = 130;
      } else if (turn.sawErrorResult) {
        exitCode = typeof code === "number" && code !== 0 ? code : 3;
      } else if (turn.timedOut) {
        exitCode = typeof code === "number" && code !== 0 ? code : 3;
      } else if (typeof code === "number") {
        exitCode = code;
      } else {
        exitCode = 1;
      }

      const crashed =
        turn.aborted ||
        turn.sawErrorResult ||
        typeof code !== "number" ||
        code !== 0;

      turn.resolve({
        exitCode,
        crashed,
        aborted: Boolean(turn.aborted),
        timedOut: Boolean(turn.timedOut),
        result: turn.lastResult ?? null,
        agyError: parseAgyError(turnStderr),
        rawStderr: turnStderr,
        sawFinishTool: turn.sawFinishTool,
        usageDelta: turn.lastUsageDelta ?? { ...EMPTY_USAGE },
      });
    }

    const waiters = this._closeWaiters.splice(0, this._closeWaiters.length);
    for (const wake of waiters) {
      wake();
    }
  }

  async start() {
    if (this._alive && this._child) {
      return;
    }
    if (this._closed || this._started) {
      throw new Error("StreamSession is closed");
    }

    const args = buildStreamArgs({
      schemaPath: this._schemaPath,
      turnTimeoutSec: this._turnTimeoutSec,
      model: this._model,
      effort: this._effort,
      mode: this._mode,
      sandbox: this._sandbox,
      dangerouslySkipPermissions: this._dangerouslySkipPermissions,
      allowSlashCommands: this._allowSlashCommands,
      settingsArg: this._settingsArg,
      addDirs: this._addDirs,
      conversationId: this._conversationId,
    });
    const spawnEnv = prepareAgyEnv(this._env, this._isolateSessionEnv);

    this._started = true;
    this._stdoutBuf = "";
    this._stderrBuf = "";
    this._spawnError = null;
    this._stdoutDecoder = new StringDecoder("utf8");
    this._stderrDecoder = new StringDecoder("utf8");

    const child = spawn(this._agyBin, args, {
      cwd: this._cwd,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this._child = child;
    this._alive = true;

    child.stdin?.on("error", () => {
      // Child exit/close handles broken pipe cleanup without crashing Node.
    });

    child.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._stdoutBuf += this._stdoutDecoder
        ? this._stdoutDecoder.write(buf)
        : buf.toString("utf8");
      this._drainStdoutLines(false);
    });

    child.stderr?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._appendStderr(
        this._stderrDecoder
          ? this._stderrDecoder.write(buf)
          : buf.toString("utf8")
      );
    });

    child.on("error", (err) => {
      this._spawnError = err;
      if (child.pid === undefined) {
        this._finalizeChildExit(1);
      }
    });

    child.on("close", (code) => {
      this._finalizeChildExit(code);
    });
  }

  async sendTurn(prompt, { signal = null } = {}) {
    if (this._closed) {
      throw new Error("StreamSession is closed");
    }
    if (!this._started) {
      await this.start();
    }
    if (!this._alive || !this._child) {
      throw new Error("StreamSession is closed");
    }
    if (this._pendingTurn) {
      throw new Error("StreamSession turn already in progress");
    }

    if (signal?.aborted) {
      await this.close();
      return {
        exitCode: 130,
        crashed: true,
        aborted: true,
        timedOut: false,
        result: null,
        agyError: parseAgyError(this._stderrBuf),
        rawStderr: this._stderrBuf,
        sawFinishTool: false,
        usageDelta: { ...EMPTY_USAGE },
      };
    }

    // Preserve startup stderr emitted during start() before turn 1; reset for subsequent turns.
    if (this._turnCount > 0) {
      this._stderrBuf = "";
    }
    this._turnCount += 1;

    const effectiveOuterMs =
      this._outerTimeoutMs !== null && this._outerTimeoutMs !== undefined
        ? Number(this._outerTimeoutMs)
        : Number.isFinite(Number(this._turnTimeoutSec)) &&
            Number(this._turnTimeoutSec) > 0
          ? (Number(this._turnTimeoutSec) + 60) * 1000
          : 0;

    return new Promise((resolve) => {
      let watchdogTimer = null;
      let stdinFallbackTimer = null;
      let cancelKillFallback = () => {};
      let cancelPipeFallback = () => {};
      let onAbort = null;
      let onChildExit = null;

      const turn = {
        sawFinishTool: false,
        sawErrorResult: false,
        lastResult: null,
        lastUsageDelta: null,
        errorGraceTimer: null,
        aborted: false,
        timedOut: false,
        resolved: false,
        resolve: (outcome) => {
          if (turn.resolved) {
            return;
          }
          turn.resolved = true;
          if (this._pendingTurn === turn) {
            this._pendingTurn = null;
          }
          if (turn.errorGraceTimer !== null) {
            clearTimeout(turn.errorGraceTimer);
            turn.errorGraceTimer = null;
          }
          if (stdinFallbackTimer !== null) {
            clearTimeout(stdinFallbackTimer);
            stdinFallbackTimer = null;
          }
          if (watchdogTimer !== null) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
          if (signal && onAbort) {
            signal.removeEventListener("abort", onAbort);
          }
          if (this._child && onChildExit) {
            this._child.removeListener("exit", onChildExit);
          }
          cancelKillFallback();
          cancelPipeFallback();
          resolve(outcome);
        },
      };

      this._pendingTurn = turn;

      onChildExit = () => {
        if (!turn.resolved && (turn.aborted || turn.timedOut)) {
          cancelPipeFallback();
          cancelPipeFallback = schedulePipeCloseFallback(this._child, 500);
        }
      };
      this._child.once("exit", onChildExit);

      onAbort = () => {
        if (turn.resolved || turn.aborted) {
          return;
        }
        turn.aborted = true;
        this._alive = false;
        cancelKillFallback();
        cancelKillFallback = forceTerminateChild(this._child, { graceMs: 5000 });
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      if (Number.isFinite(effectiveOuterMs) && effectiveOuterMs > 0) {
        watchdogTimer = setTimeout(() => {
          if (turn.resolved || turn.aborted || turn.timedOut) {
            return;
          }
          turn.timedOut = true;
          this._alive = false;
          cancelKillFallback();
          cancelKillFallback = forceTerminateChild(this._child, {
            graceMs: 5000,
          });
        }, effectiveOuterMs);
        watchdogTimer.unref?.();
      }

      const armStdinFailureFallback = (err = null) => {
        if (err && !this._spawnError) {
          this._spawnError = err;
        }
        if (turn.resolved || stdinFallbackTimer !== null) {
          return;
        }
        // If child already finished exiting/closing, resolve immediately with real exitCode/stderr.
        if (
          !this._alive &&
          (this._child.exitCode !== null ||
            this._child.signalCode !== null ||
            this._child.pid === undefined)
        ) {
          const stderrOut =
            this._stderrBuf || (err ? err.message || String(err) : "");
          turn.resolve({
            exitCode: typeof this._exitCode === "number" ? this._exitCode : 1,
            crashed: true,
            aborted: Boolean(turn.aborted),
            timedOut: Boolean(turn.timedOut),
            result: turn.lastResult ?? null,
            agyError: parseAgyError(stderrOut),
            rawStderr: stderrOut,
            sawFinishTool: turn.sawFinishTool,
            usageDelta: turn.lastUsageDelta ?? { ...EMPTY_USAGE },
          });
          return;
        }
        // Wait briefly for child close/_finalizeChildExit so real exitCode & AGY_ERROR are captured.
        stdinFallbackTimer = setTimeout(() => {
          if (turn.resolved) {
            return;
          }
          this._alive = false;
          const stderrOut =
            this._stderrBuf || (err ? err.message || String(err) : "");
          turn.resolve({
            exitCode: typeof this._exitCode === "number" ? this._exitCode : 1,
            crashed: true,
            aborted: Boolean(turn.aborted),
            timedOut: Boolean(turn.timedOut),
            result: turn.lastResult ?? null,
            agyError: parseAgyError(stderrOut),
            rawStderr: stderrOut,
            sawFinishTool: turn.sawFinishTool,
            usageDelta: turn.lastUsageDelta ?? { ...EMPTY_USAGE },
          });
        }, 1000);
        stdinFallbackTimer.unref?.();
      };

      const payload =
        JSON.stringify({ event: "user", message: { content: String(prompt) } }) +
        "\n";

      try {
        if (!this._child.stdin || this._child.stdin.destroyed || !this._child.stdin.writable) {
          armStdinFailureFallback();
          return;
        }
        this._child.stdin.write(payload, (err) => {
          if (err) {
            armStdinFailureFallback(err);
          }
        });
      } catch (err) {
        armStdinFailureFallback(err);
      }
    });
  }

  async close() {
    this._closed = true;
    if (this._closePromise) {
      return this._closePromise;
    }

    this._closePromise = (async () => {
      const child = this._child;
      if (!child || (!this._alive && (child.exitCode !== null || child.signalCode !== null || child.pid === undefined))) {
        this._alive = false;
        return;
      }

      const waitForClose = new Promise((resolve) => {
        this._closeWaiters.push(resolve);
      });

      try {
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
          child.stdin.end();
        }
      } catch {
        // Ignore stdin close errors.
      }

      let gracefulTimer = null;
      let cancelKillFallback = () => {};
      let cancelPipeFallback = () => {};

      const onExit = () => {
        cancelPipeFallback = schedulePipeCloseFallback(child, 500);
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit();
      } else {
        child.once("exit", onExit);
      }

      const timeoutEscalation = new Promise((resolve) => {
        gracefulTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            cancelKillFallback = forceTerminateChild(child, { graceMs: 2000 });
          }
          resolve();
        }, 5000);
        gracefulTimer.unref?.();
      });

      await Promise.race([waitForClose, timeoutEscalation]);
      if (!this._alive && (child.exitCode !== null || child.signalCode !== null)) {
        if (gracefulTimer !== null) {
          clearTimeout(gracefulTimer);
        }
        cancelKillFallback();
        cancelPipeFallback();
        child.removeListener("exit", onExit);
        return;
      }

      // If graceful window elapsed, wait for forced termination to complete close.
      await waitForClose;
      if (gracefulTimer !== null) {
        clearTimeout(gracefulTimer);
      }
      cancelKillFallback();
      cancelPipeFallback();
      child.removeListener("exit", onExit);
    })();

    return this._closePromise;
  }
}
