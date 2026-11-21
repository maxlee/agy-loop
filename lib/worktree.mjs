import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VALID_LOOP_ID_RE = /^lp_[A-Za-z0-9_-]{4,64}$/;
const GIT_TIMEOUT_MS = 15000;

/**
 * Run a git subcommand synchronously with bounded timeout.
 */
export function runGit(args, { cwd, env = process.env } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });

  if (res.error) {
    return {
      ok: false,
      status: res.status ?? 1,
      stdout: res.stdout || "",
      stderr: res.stderr || res.error.message,
      error: res.error,
    };
  }

  return {
    ok: res.status === 0,
    status: res.status ?? 1,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    error: null,
  };
}

function ensureStateGitignore(stateRoot) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const gitignorePath = path.join(stateRoot, ".gitignore");
  try {
    fs.writeFileSync(gitignorePath, "*\n", { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }
}

/**
 * Create an isolated git worktree and branch `agy-loop/<loopId>` under `<stateRoot>/worktrees/<loopId>`.
 */
export function createHeadlessWorktree({
  workspaceDir,
  stateRoot,
  loopId,
  env = process.env,
}) {
  if (typeof loopId !== "string" || !VALID_LOOP_ID_RE.test(loopId)) {
    throw new Error(`Invalid loop_id for worktree: ${String(loopId)}`);
  }

  const ws = path.resolve(workspaceDir || process.cwd());
  const topRes = runGit(["rev-parse", "--show-toplevel"], { cwd: ws, env });
  if (!topRes.ok) {
    const detail = (topRes.stderr || topRes.stdout || "git rev-parse failed").trim();
    throw new Error(`Cannot create --worktree: not a git repository (${ws}): ${detail}`);
  }
  const repoRoot = topRes.stdout.trim();

  const headRes = runGit(["rev-parse", "HEAD"], { cwd: repoRoot, env });
  if (!headRes.ok) {
    const detail = (headRes.stderr || headRes.stdout || "unborn HEAD").trim();
    throw new Error(
      `Cannot create --worktree: repository has no commits (unborn HEAD) in ${repoRoot}: ${detail}`
    );
  }
  const baseSha = headRes.stdout.trim();

  ensureStateGitignore(stateRoot);
  const worktreesDir = path.join(stateRoot, "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });

  const worktreePath = path.join(worktreesDir, loopId);
  const branch = `agy-loop/${loopId}`;

  const addRes = runGit(
    ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
    { cwd: repoRoot, env }
  );
  if (!addRes.ok) {
    const detail = (addRes.stderr || addRes.stdout || "git worktree add failed").trim();
    throw new Error(`Failed to create git worktree at ${worktreePath}: ${detail}`);
  }

  return {
    worktreePath,
    branch,
    baseSha,
    repoRoot,
  };
}

/**
 * Inspect commit ahead count, dirty working tree status, and diff stats for a headless worktree.
 */
export function inspectHeadlessWorktree({
  worktreePath,
  baseSha,
  env = process.env,
}) {
  const headRes = runGit(["rev-parse", "HEAD"], { cwd: worktreePath, env });
  if (!headRes.ok) {
    const detail = (headRes.stderr || headRes.stdout || "git rev-parse HEAD failed").trim();
    throw new Error(`Failed to inspect worktree ${worktreePath}: ${detail}`);
  }
  const headSha = headRes.stdout.trim();

  let aheadCount = 0;
  if (baseSha) {
    const countRes = runGit(["rev-list", "--count", `${baseSha}..HEAD`], {
      cwd: worktreePath,
      env,
    });
    if (!countRes.ok) {
      const detail = (countRes.stderr || countRes.stdout || "git rev-list failed").trim();
      throw new Error(`Failed to count commits in worktree ${worktreePath}: ${detail}`);
    }
    const parsedCount = Number.parseInt(countRes.stdout.trim(), 10);
    aheadCount = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  }

  const statusRes = runGit(["status", "--porcelain"], { cwd: worktreePath, env });
  if (!statusRes.ok) {
    const detail = (statusRes.stderr || statusRes.stdout || "git status failed").trim();
    throw new Error(`Failed to check status in worktree ${worktreePath}: ${detail}`);
  }
  const gitStatus = statusRes.stdout.replace(/[\r\n]+$/, "");
  const dirty = gitStatus.length > 0;

  const diffParts = [];
  if (baseSha) {
    const committedDiff = runGit(["diff", "--stat", `${baseSha}..HEAD`], {
      cwd: worktreePath,
      env,
    });
    if (committedDiff.ok && committedDiff.stdout.trim()) {
      diffParts.push(committedDiff.stdout.trim());
    }
  }
  if (dirty) {
    const dirtyDiff = runGit(["diff", "--stat"], { cwd: worktreePath, env });
    if (dirtyDiff.ok && dirtyDiff.stdout.trim()) {
      diffParts.push(dirtyDiff.stdout.trim());
    }
  }
  const diffStat = diffParts.join("\n");

  return {
    headSha,
    aheadCount,
    dirty,
    gitStatus,
    diffStat,
  };
}

/**
 * Clean up an untouched worktree or preserve it with merge and cleanup hints when changed/requested.
 */
export function finalizeHeadlessWorktree({
  workspaceDir,
  worktreePath,
  branch,
  baseSha,
  keepWorktree = false,
  env = process.env,
}) {
  const info = inspectHeadlessWorktree({ worktreePath, baseSha, env });

  if (!keepWorktree && info.aheadCount === 0 && !info.dirty) {
    const ws = path.resolve(workspaceDir || process.cwd());
    const removeRes = runGit(["worktree", "remove", "--force", worktreePath], {
      cwd: ws,
      env,
    });
    if (!removeRes.ok) {
      const detail = (removeRes.stderr || removeRes.stdout || "git worktree remove failed").trim();
      throw new Error(`Failed to remove worktree ${worktreePath}: ${detail}`);
    }

    if (branch) {
      const branchRes = runGit(["branch", "-d", branch], { cwd: ws, env });
      if (!branchRes.ok) {
        const detail = (branchRes.stderr || branchRes.stdout || "git branch -d failed").trim();
        throw new Error(`Failed to delete worktree branch ${branch}: ${detail}`);
      }
    }

    return {
      preserved: false,
      removed: true,
      ...info,
      mergeHint: null,
      cleanupHint: null,
    };
  }

  const shortBase = (baseSha || "HEAD").slice(0, 8);
  return {
    preserved: true,
    removed: false,
    ...info,
    mergeHint: `git merge ${branch}  # or: git cherry-pick ${shortBase}..${branch}`,
    cleanupHint: `git worktree remove ${JSON.stringify(worktreePath)} && git branch -D ${branch}`,
  };
}
