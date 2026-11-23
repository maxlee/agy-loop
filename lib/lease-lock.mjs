/**
 * Four-gate single-instance Lease Lock (`wakeDriver`) with atomic O_EXCL acquisition,
 * dead-PID/TTL reclamation, draining handoff wait, and inbox wake coalescing.
 * Byte-compatible lock key and JSON contract with workflows/loop-runner/workflow.py.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  enqueueInboxMessage,
  isPidAlive,
  validateLoopId,
} from "./state-store.mjs";

const VALID_SINGLETONS = new Set(["none", "workspace", "profile"]);
const VALID_ON_CONFLICT = new Set(["fail", "wake", "skip"]);
const CORRUPT_GRACE_MS = 2000;
const RECLAIM_LOCK_STALE_MS = 5000;

let lockAtomicSeq = 0;

function nowIsoMs() {
  return new Date().toISOString();
}

function writeLockJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  lockAtomicSeq += 1;
  const tmpPath = `${filePath}.tmp.${process.pid}.${lockAtomicSeq}`;
  const content = `${JSON.stringify(obj)}\n`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup failure
    }
    throw err;
  }
}

function resolveRealPathFallback(targetPath) {
  const abs = path.resolve(targetPath || process.cwd());
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLockFileDetailed(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { exists: false, data: null, mtimeMs: null };
    }
    return { exists: true, data: null, mtimeMs: null };
  }

  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { exists: true, data: parsed, mtimeMs: stat.mtimeMs };
    }
    return { exists: true, data: null, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: true, data: null, mtimeMs: stat.mtimeMs };
  }
}

function reclaimLockViaRename(lockPath) {
  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${crypto.randomBytes(2).toString("hex")}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return true;
    }
    return false;
  }
  try {
    fs.unlinkSync(stalePath);
  } catch {
    // Ignore cleanup errors on already-removed stale file.
  }
  return true;
}

async function tryReclaimUnderGuard(lockPath, fnVerifyAndReclaim) {
  const reclaimLockPath = `${lockPath}.reclaim.lock`;
  const maxAttempts = 40;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let rfd = null;
    try {
      rfd = fs.openSync(reclaimLockPath, "wx", 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }

      let reclaimedGuard = false;
      const guardInfo = readLockFileDetailed(reclaimLockPath);
      if (!guardInfo.exists) {
        reclaimedGuard = true;
      } else {
        const gPid = Number.isInteger(guardInfo.data?.pid) ? guardInfo.data.pid : null;
        const deadGuard = gPid !== null && gPid > 0 && !isPidAlive(gPid);
        const acqMs =
          typeof guardInfo.data?.acquired_at === "string"
            ? Date.parse(guardInfo.data.acquired_at)
            : Number.NaN;
        const mtimeExpired =
          guardInfo.mtimeMs !== null && Date.now() - guardInfo.mtimeMs > RECLAIM_LOCK_STALE_MS;
        const tsExpired = !Number.isNaN(acqMs) && Date.now() - acqMs > RECLAIM_LOCK_STALE_MS;
        if (deadGuard || mtimeExpired || tsExpired) {
          try {
            fs.unlinkSync(reclaimLockPath);
            reclaimedGuard = true;
          } catch (unlinkErr) {
            if (unlinkErr && unlinkErr.code === "ENOENT") {
              reclaimedGuard = true;
            }
          }
        }
      }

      if (reclaimedGuard) {
        continue;
      }
      if (attempt + 1 < maxAttempts) {
        await sleepAsync(15 + Math.floor(Math.random() * 25));
      }
      continue;
    }

    try {
      const guardPayload = `${JSON.stringify({ pid: process.pid, acquired_at: nowIsoMs() })}\n`;
      const buf = Buffer.from(guardPayload, "utf8");
      try {
        try {
          fs.fchmodSync(rfd, 0o600);
        } catch {
          // Ignore fchmod on unsupported filesystems
        }
        let offset = 0;
        while (offset < buf.length) {
          offset += fs.writeSync(rfd, buf, offset, buf.length - offset);
        }
      } finally {
        fs.closeSync(rfd);
      }
      return fnVerifyAndReclaim();
    } finally {
      try {
        fs.unlinkSync(reclaimLockPath);
      } catch {
        // Ignore cleanup failure if already removed
      }
    }
  }

  return false;
}

function evaluateHolderState(holder, defaultTtlMs) {
  const pid = Number.isInteger(holder?.pid) ? holder.pid : null;
  const pidAlive = pid !== null && pid > 0 && isPidAlive(pid);
  const hbRaw = holder?.heartbeat_at || holder?.acquired_at;
  const hbMs = typeof hbRaw === "string" ? Date.parse(hbRaw) : Number.NaN;
  const ttlMs =
    Number.isFinite(Number(holder?.lease_ttl_ms)) && Number(holder.lease_ttl_ms) > 0
      ? Number(holder.lease_ttl_ms)
      : defaultTtlMs;
  const expired = Number.isNaN(hbMs) || Date.now() - hbMs > ttlMs;
  const stale = !pidAlive || expired;
  return { pidAlive, expired, stale };
}

/**
 * Compute deterministic lock scope key (`null` for `none`, `ws_<16hex>`, `pf_<16hex>`).
 * Exact byte-for-byte parity with `workflow.py`.
 *
 * @param {{ singleton?: string | null, workspaceDir?: string, profileName?: string | null }} params
 * @returns {string | null}
 */
export function computeLockScope({
  singleton = "none",
  workspaceDir = process.cwd(),
  profileName = null,
} = {}) {
  const scope = singleton || "none";
  if (!VALID_SINGLETONS.has(scope)) {
    throw new Error(`Invalid singleton scope '${scope}': expected profile, workspace, or none`);
  }
  if (scope === "none") {
    return null;
  }

  const wsReal = resolveRealPathFallback(workspaceDir);
  if (scope === "workspace") {
    const digest = crypto.createHash("sha256").update(wsReal, "utf8").digest("hex").slice(0, 16);
    return `ws_${digest}`;
  }

  const profKey = typeof profileName === "string" && profileName ? profileName : "default";
  const digest = crypto
    .createHash("sha256")
    .update(`${wsReal}\0${profKey}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `pf_${digest}`;
}

/**
 * Resolve lock file path inside `<stateRoot>/locks/<scopeKey>.lock.json`.
 */
export function getLeaseLockPath(stateRoot, scopeKey) {
  return path.join(stateRoot, "locks", `${scopeKey}.lock.json`);
}

/**
 * Acquire a single-instance lease lock across four gates:
 * 1. Atomic O_EXCL lock creation
 * 2. Dead PID / heartbeat TTL / sustained corrupt lock reclamation
 * 3. Live holder conflict handling (`fail`, `skip`, or `wake` inbox coalescing)
 * 4. `draining` handoff polling wait
 *
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function acquireLeaseLock({
  stateRoot,
  scope = "profile",
  scopeKey = null,
  loopId,
  pid = process.pid,
  engine = "headless",
  profileName = null,
  workspaceDir = process.cwd(),
  leaseTtlMs = 60000,
  onConflict = "fail",
  drainWaitMs = 3000,
} = {}) {
  if (!VALID_SINGLETONS.has(scope)) {
    throw new Error(`Invalid lock scope '${scope}': expected profile, workspace, or none`);
  }
  if (!VALID_ON_CONFLICT.has(onConflict)) {
    throw new Error(`Invalid onConflict '${onConflict}': expected fail, wake, or skip`);
  }
  if (scope === "none") {
    return { acquired: true, action: "none", handle: null, lockPath: null };
  }

  const resolvedScopeKey =
    scopeKey || computeLockScope({ singleton: scope, workspaceDir, profileName });
  if (!resolvedScopeKey) {
    return { acquired: true, action: "none", handle: null, lockPath: null };
  }
  if (typeof loopId !== "string" || !loopId.trim()) {
    throw new Error("acquireLeaseLock requires a non-empty loopId");
  }

  const ttlMs =
    Number.isFinite(Number(leaseTtlMs)) && Number(leaseTtlMs) > 0
      ? Number(leaseTtlMs)
      : 60000;
  const locksDir = path.join(stateRoot, "locks");
  const lockPath = getLeaseLockPath(stateRoot, resolvedScopeKey);
  const realWs = resolveRealPathFallback(workspaceDir);
  const normalizedProfile = typeof profileName === "string" && profileName ? profileName : null;

  fs.mkdirSync(locksDir, { recursive: true });

  const drainDeadline = Date.now() + Math.max(0, Number(drainWaitMs) || 0);
  let corruptFirstSeenAt = null;
  let attempts = 0;
  const maxAttempts = 250;

  while (attempts < maxAttempts) {
    attempts += 1;

    // Gate 1: atomic O_EXCL lock creation
    let fd = null;
    try {
      fs.mkdirSync(locksDir, { recursive: true });
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
    }

    if (fd !== null) {
      const nowIso = nowIsoMs();
      const payload = {
        scope,
        scope_key: resolvedScopeKey,
        loop_id: loopId,
        pid,
        engine,
        profile: normalizedProfile,
        workspace_dir: realWs,
        acquired_at: nowIso,
        heartbeat_at: nowIso,
        lease_ttl_ms: ttlMs,
        draining: false,
      };
      try {
        try {
          fs.fchmodSync(fd, 0o600);
        } catch {
          // Ignore fchmod on unsupported filesystems
        }
        const buf = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
        let offset = 0;
        while (offset < buf.length) {
          offset += fs.writeSync(fd, buf, offset, buf.length - offset);
        }
      } finally {
        fs.closeSync(fd);
      }

      const handle = {
        stateRoot,
        scope,
        scopeKey: resolvedScopeKey,
        lockPath,
        loopId,
        pid,
        engine,
        profileName: normalizedProfile,
        workspaceDir: realWs,
        leaseTtlMs: ttlMs,
        acquiredAt: nowIso,
      };
      return { acquired: true, action: "acquired", handle, lockPath };
    }

    // Gate 2: inspect existing lock for dead PID, expired heartbeat, or sustained corruption
    const inspected = readLockFileDetailed(lockPath);
    if (!inspected.exists) {
      corruptFirstSeenAt = null;
      continue;
    }

    if (!inspected.data) {
      const now = Date.now();
      if (corruptFirstSeenAt === null) {
        corruptFirstSeenAt = now;
      }
      const fileOldEnough =
        inspected.mtimeMs !== null && now - inspected.mtimeMs > CORRUPT_GRACE_MS;
      const seenLongEnough = now - corruptFirstSeenAt > CORRUPT_GRACE_MS;
      if (fileOldEnough || seenLongEnough) {
        const reclaimed = await tryReclaimUnderGuard(lockPath, () => {
          const latest = readLockFileDetailed(lockPath);
          if (!latest.exists) {
            return true;
          }
          if (latest.data) {
            const { stale: stillStale } = evaluateHolderState(latest.data, ttlMs);
            if (!stillStale) {
              return false;
            }
            return reclaimLockViaRename(lockPath);
          }
          const latestNow = Date.now();
          const stillOldEnough =
            latest.mtimeMs !== null && latestNow - latest.mtimeMs > CORRUPT_GRACE_MS;
          if (stillOldEnough || latestNow - corruptFirstSeenAt > CORRUPT_GRACE_MS) {
            return reclaimLockViaRename(lockPath);
          }
          return false;
        });
        if (reclaimed) {
          corruptFirstSeenAt = null;
          continue;
        }
        await sleepAsync(25);
        continue;
      }
      await sleepAsync(50);
      continue;
    }

    corruptFirstSeenAt = null;
    const holder = inspected.data;
    const { stale } = evaluateHolderState(holder, ttlMs);
    if (stale) {
      const reclaimed = await tryReclaimUnderGuard(lockPath, () => {
        const latest = readLockFileDetailed(lockPath);
        if (!latest.exists) {
          return true;
        }
        if (!latest.data) {
          return false;
        }
        const { stale: stillStale } = evaluateHolderState(latest.data, ttlMs);
        if (!stillStale) {
          return false;
        }
        return reclaimLockViaRename(lockPath);
      });
      if (reclaimed) {
        continue;
      }
      // If another contender already reclaimed and acquired a fresh live lock, re-inspect immediately.
      await sleepAsync(20);
      continue;
    }

    // Gate 4: short async wait if live holder is draining cleanly
    if (holder.draining === true && Date.now() < drainDeadline) {
      const remaining = drainDeadline - Date.now();
      await sleepAsync(Math.min(100, Math.max(10, remaining)));
      continue;
    }

    // Gate 3: live non-draining holder (or drain wait elapsed)
    if (onConflict === "wake") {
      if (!validateLoopId(holder.loop_id)) {
        return {
          acquired: false,
          action: "conflict",
          holder,
          lockPath,
          error: `Live lock holder has invalid loop_id '${String(holder.loop_id)}'`,
        };
      }
      enqueueInboxMessage(stateRoot, holder.loop_id, {
        type: "wake",
        reason: "singleton_coalesced",
        source_pid: pid,
      });
      return { acquired: false, action: "coalesced", holder, lockPath };
    }

    if (onConflict === "skip") {
      return { acquired: false, action: "skipped", holder, lockPath };
    }

    return { acquired: false, action: "conflict", holder, lockPath };
  }

  return {
    acquired: false,
    action: "conflict",
    holder: readLockFileDetailed(lockPath).data,
    lockPath,
    error: `Timed out contending for lease lock at ${lockPath}`,
  };
}

/**
 * Refresh `heartbeat_at` atomically if and only if `handle` still owns the lock.
 *
 * @param {object | null | undefined} handle
 * @returns {boolean}
 */
export function refreshLeaseHeartbeat(handle) {
  if (!handle || !handle.lockPath) {
    return false;
  }
  const inspected = readLockFileDetailed(handle.lockPath);
  if (!inspected.exists || !inspected.data) {
    return false;
  }
  const current = inspected.data;
  if (current.loop_id !== handle.loopId || current.pid !== handle.pid) {
    return false;
  }

  writeLockJsonAtomic(handle.lockPath, {
    ...current,
    heartbeat_at: nowIsoMs(),
  });
  return true;
}

/**
 * Start background `.unref()` heartbeat renewal every `min(ttl / 3, 15000)` ms.
 * Returns an idempotent `stop()` function.
 *
 * @param {object | null | undefined} handle
 * @returns {() => void}
 */
export function startLeaseHeartbeat(handle) {
  if (!handle || !handle.lockPath) {
    return () => {};
  }
  const ttl = Number.isFinite(Number(handle.leaseTtlMs)) && Number(handle.leaseTtlMs) > 0
    ? Number(handle.leaseTtlMs)
    : 60000;
  const intervalMs = Math.max(20, Math.min(Math.floor(ttl / 3), 15000));

  let stopped = false;
  let timer = null;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  timer = setInterval(() => {
    if (stopped) {
      return;
    }
    try {
      const stillOwned = refreshLeaseHeartbeat(handle);
      if (!stillOwned) {
        stop();
      }
    } catch {
      // Best-effort heartbeat tick
    }
  }, intervalMs);

  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return stop;
}

/**
 * Atomically mark the lock as `draining: true` after verifying ownership.
 *
 * @param {object | null | undefined} handle
 * @returns {boolean}
 */
export function markLeaseDraining(handle) {
  if (!handle || !handle.lockPath) {
    return false;
  }
  const inspected = readLockFileDetailed(handle.lockPath);
  if (!inspected.exists || !inspected.data) {
    return false;
  }
  const current = inspected.data;
  if (current.loop_id !== handle.loopId || current.pid !== handle.pid) {
    return false;
  }

  writeLockJsonAtomic(handle.lockPath, {
    ...current,
    draining: true,
    heartbeat_at: nowIsoMs(),
  });
  return true;
}

/**
 * Atomically clear `draining` back to `false` after verifying ownership
 * (used when Gate 4 relays into another iteration).
 *
 * @param {object | null | undefined} handle
 * @returns {boolean}
 */
export function unmarkLeaseDraining(handle) {
  if (!handle || !handle.lockPath) {
    return false;
  }
  const inspected = readLockFileDetailed(handle.lockPath);
  if (!inspected.exists || !inspected.data) {
    return false;
  }
  const current = inspected.data;
  if (current.loop_id !== handle.loopId || current.pid !== handle.pid) {
    return false;
  }

  writeLockJsonAtomic(handle.lockPath, {
    ...current,
    draining: false,
    heartbeat_at: nowIsoMs(),
  });
  return true;
}

/**
 * Verify lock ownership (`loop_id` + `pid`) and unlink the lock file.
 *
 * @param {object | null | undefined} handle
 * @returns {boolean}
 */
export function releaseLeaseLock(handle) {
  if (!handle || !handle.lockPath) {
    return false;
  }
  const inspected = readLockFileDetailed(handle.lockPath);
  if (!inspected.exists || !inspected.data) {
    return false;
  }
  const current = inspected.data;
  if (current.loop_id !== handle.loopId || current.pid !== handle.pid) {
    return false;
  }

  try {
    fs.unlinkSync(handle.lockPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

/**
 * List lease lock files under `<stateRoot>/locks/*.lock.json` tagged with `alive`, `stale`, and `draining`.
 *
 * @param {string} stateRoot
 * @returns {Array<object>}
 */
export function listLeaseLocks(stateRoot) {
  const locksDir = path.join(stateRoot, "locks");
  let entries;
  try {
    entries = fs.readdirSync(locksDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".lock.json") || entry.name.startsWith(".")) {
      continue;
    }
    if (entry.isDirectory()) {
      continue;
    }
    const filePath = path.join(locksDir, entry.name);
    const inspected = readLockFileDetailed(filePath);
    if (!inspected.exists) {
      continue;
    }

    const fallbackScopeKey = entry.name.slice(0, -".lock.json".length);
    if (!inspected.data) {
      results.push({
        scope_key: fallbackScopeKey,
        file: filePath,
        alive: false,
        stale: true,
        draining: false,
        corrupt: true,
      });
      continue;
    }

    const holder = inspected.data;
    const { stale } = evaluateHolderState(holder, 60000);
    results.push({
      ...holder,
      scope_key: holder.scope_key || fallbackScopeKey,
      file: filePath,
      alive: !stale,
      stale,
      draining: Boolean(holder.draining),
      corrupt: false,
    });
  }

  results.sort((a, b) => String(a.scope_key).localeCompare(String(b.scope_key)));
  return results;
}
