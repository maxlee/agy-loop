import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, "workflows");
const WORKFLOW_DIR = path.join(WORKFLOWS_DIR, "loop-runner");
const WORKFLOW_JSON_PATH = path.join(WORKFLOW_DIR, "workflow.json");
const WORKFLOW_PY_PATH = path.join(WORKFLOW_DIR, "workflow.py");
const REAL_HOME = os.homedir();

function collectFilesRecursive(dirPath, acc = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

function makeWorkflowSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-loop-wf-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const indexPath = path.join(root, "global-index.json");

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    HOME: home,
    AGY_LOOP_STATE_DIR: stateDir,
    AGY_LOOP_INDEX_PATH: indexPath,
  };
  delete env.ANTIGRAVITY_LS_ADDRESS;
  delete env.ANTIGRAVITY_CSRF_TOKEN;
  assert.notEqual(env.HOME, REAL_HOME);

  return { root, home, workspace, stateDir, indexPath, env };
}

function runPythonHarness(pyBody, { cwd, env, timeoutMs = 30000 } = {}) {
  const prelude = `
import ast, asyncio, inspect, json, os, pathlib, sys, time
WORKFLOW_PY = ${JSON.stringify(WORKFLOW_PY_PATH)}
SRC = pathlib.Path(WORKFLOW_PY).read_text(encoding="utf-8")
NS = {"__file__": WORKFLOW_PY, "__name__": "agy_loop_workflow_test"}
CODE_OBJ = compile(SRC, WORKFLOW_PY, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
read_events = lambda state_root, lid: [
    json.loads(line)
    for line in pathlib.Path(state_root, "loops", lid, "events.jsonl").read_text(encoding="utf-8").splitlines()
    if line.strip()
]
read_state = lambda state_root, lid: json.loads(
    pathlib.Path(state_root, "loops", lid, "state.json").read_text(encoding="utf-8")
)
class MockBudgetExceeded(Exception):
    pass
async def _load_workflow_module():
    res = eval(CODE_OBJ, NS, NS)
    if inspect.iscoroutine(res):
        await res
    return NS["run_loop_workflow"]
`;
  const wrappedBody = pyBody.replace(
    /asyncio\.run\(main\(\)\)\s*$/,
    `async def _entry():\n    global run_loop_workflow\n    run_loop_workflow = await _load_workflow_module()\n    await main()\n\nasyncio.run(_entry())\n`
  );
  const res = spawnSync("python3", ["-c", prelude + "\n" + wrappedBody], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  assert.equal(
    res.status,
    0,
    `Python harness failed (status=${res.status}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  return res;
}

test("workflows/loop-runner/workflow.json satisfies schema contract and workflows/ contains zero .md files", () => {
  assert.equal(fs.existsSync(WORKFLOW_JSON_PATH), true, "workflow.json must exist");
  assert.equal(fs.existsSync(WORKFLOW_PY_PATH), true, "workflow.py must exist");

  const allFiles = collectFilesRecursive(WORKFLOWS_DIR);
  const mdFiles = allFiles
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => path.relative(REPO_ROOT, f));
  assert.deepEqual(mdFiles, [], `workflows/ must contain zero .md files, found: ${mdFiles.join(", ")}`);

  const manifest = JSON.parse(fs.readFileSync(WORKFLOW_JSON_PATH, "utf8"));
  assert.equal(manifest.name, "loop-runner");
  assert.equal(manifest.entry, "workflow.py");
  assert.equal(fs.existsSync(path.join(WORKFLOW_DIR, manifest.entry)), true);
  assert.equal(manifest.args?.type, "object");
  assert.equal(manifest.args?.additionalProperties, false);
  assert.ok(Array.isArray(manifest.args?.required) && manifest.args.required.includes("workspace_dir"));

  const expectedProps = [
    "loop_id",
    "workspace_dir",
    "task_source",
    "prompt",
    "pacing",
    "once",
    "interval_sec",
    "max_iterations",
    "state_mode",
    "reset_every",
    "workspace",
    "model",
    "delegate",
    "verify",
    "verifier_model",
    "verify_cmd",
    "verify_timeout_sec",
    "probe_cmd",
    "probe_timeout_sec",
    "probe_until_pass",
    "targets",
    "max_tokens",
    "max_duration_sec",
    "max_agents",
    "max_errors",
    "include_trajectory",
    "state_dir",
    "profile",
    "profile_file",
    "singleton",
    "on_conflict",
    "relay_on_wake",
  ];
  for (const key of expectedProps) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(manifest.args.properties, key),
      `workflow.json args.properties missing '${key}'`
    );
  }
  assert.deepEqual(manifest.args.properties.singleton.enum, ["profile", "workspace", "none", null]);
  assert.deepEqual(manifest.args.properties.on_conflict.enum, ["wake", "skip", "fail", null]);
  assert.equal(manifest.args.properties.relay_on_wake.type, "boolean");
});

test("workflows/loop-runner/workflow.py compiles with ast.PyCF_ALLOW_TOP_LEVEL_AWAIT", () => {
  const res = spawnSync(
    "python3",
    [
      "-c",
      'import ast, pathlib; compile(pathlib.Path("workflows/loop-runner/workflow.py").read_text(), "workflow.py", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)',
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, "");
});

test("workflow.py: single-target fresh + trajectory + stateful reset_every rotation & telemetry", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    index_path = ${JSON.stringify(sb.indexPath)}

    # 1. Fresh single-target with trajectory & delta telemetry
    token_box = {"total": 0}
    fresh_calls = []
    traj_calls = []
    phases = []

    async def mock_trajectory(tools=None, last=10):
        traj_calls.append({"tools": tools, "last": last})
        return [
            {"index": 1, "status": "DONE", "args": {"CommandLine": "npm test"}, "output": "1 failing test"},
            {"index": 2, "status": "CLEARED", "args": {"CommandLine": "secret"}, "output": "ignored"},
        ]

    def mock_tokens_used(_scope=None):
        return {
            "input_tokens": int(token_box["total"] * 0.6),
            "output_tokens": int(token_box["total"] * 0.4),
            "thinking_tokens": 0,
            "cache_read_tokens": 0,
            "total_tokens": token_box["total"],
        }

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    def mock_agent(prompt, **kwargs):
        async def _run():
            idx = len(fresh_calls) + 1
            fresh_calls.append({"prompt": prompt, "kwargs": kwargs})
            token_box["total"] += (100 if idx == 1 else 150)
            if idx == 1:
                return {
                    "iteration": 1,
                    "loop_status": "CONTINUE",
                    "next_delay_sec": 12,
                    "summary": "Found issue",
                    "next_hint": "Fix auth.py",
                }
            return {
                "iteration": 2,
                "loop_status": "DONE",
                "next_delay_sec": 0,
                "summary": "Fixed issue",
                "next_hint": "None",
                "changed_files": ["auth.py"],
            }
        return _run()

    sleep_calls = []
    clock = {"t": 1000.0}
    async def mock_sleep(sec):
        sleep_calls.append(sec)
        clock["t"] += sec

    rt_fresh = {
        "phase": lambda name: phases.append(name),
        "log": lambda *a: None,
        "agent": mock_agent,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": mock_tokens_used,
        "BudgetExceeded": MockBudgetExceeded,
        "trajectory": mock_trajectory,
        "monotonic_fn": lambda: clock["t"],
        "sleep_fn": mock_sleep,
        "output_fn": lambda *a: None,
    }

    res1 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Fix failing test",
        "state_mode": "fresh",
        "max_iterations": 4,
        "include_trajectory": True,
    }, rt_fresh)

    assert res1["ok"] is True
    assert res1["status"] == "done"
    assert res1["exit_reason"] == "done"
    assert res1["iteration"] == 2
    assert res1["usage_totals"]["total_tokens"] == 250
    assert len(traj_calls) == 1
    assert traj_calls[0]["tools"] == ["run_command"]
    assert traj_calls[0]["last"] == 10
    assert "<<<TRAJECTORY_CONTEXT" in fresh_calls[0]["prompt"]
    assert "1 failing test" in fresh_calls[0]["prompt"]
    assert "<<<TRAJECTORY_CONTEXT" not in fresh_calls[1]["prompt"]
    assert "Fix auth.py" in fresh_calls[1]["prompt"]
    assert sleep_calls == [1.0] * 12

    lid1 = res1["loop_id"]
    st1 = read_state(state_dir, lid1)
    assert st1["status"] == "done"
    assert st1["engine"] == "workflow"
    assert st1["in_flight_iteration"] is None
    assert st1["in_flight_snapshot_hash"] is None
    assert st1["usage_totals"]["total_tokens"] == 250
    evs1 = read_events(state_dir, lid1)
    assert [e["event"] for e in evs1 if e["event"] == "iteration_start"] == ["iteration_start", "iteration_start"]
    assert [e["event"] for e in evs1 if e["event"] == "iteration_end"] == ["iteration_end", "iteration_end"]
    iter_evs = [e for e in evs1 if e["event"] == "iteration"]
    assert [e["usage_delta"]["total_tokens"] for e in iter_evs] == [100, 150]
    idx_entries = json.loads(pathlib.Path(index_path).read_text(encoding="utf-8"))
    assert any(x["loop_id"] == lid1 and x["status"] == "done" for x in idx_entries)

    # 2. Stateful + reset_every=2 rotation across 4 iterations
    token_box2 = {"total": 0}
    agent_spawns = []
    worker_turns = []

    def mock_stateful_agent(standing_prompt, **kwargs):
        spawn_idx = len(agent_spawns) + 1
        agent_spawns.append({"standing_prompt": standing_prompt, "kwargs": kwargs})
        async def _send(turn_prompt, schema=None):
            turn_num = len(worker_turns) + 1
            worker_turns.append({"spawn_idx": spawn_idx, "turn_num": turn_num, "prompt": turn_prompt})
            token_box2["total"] += 50
            if turn_num < 4:
                return {
                    "iteration": turn_num,
                    "loop_status": "CONTINUE",
                    "next_delay_sec": 10,
                    "summary": f"Step {turn_num} ok",
                    "next_hint": f"Do step {turn_num + 1}",
                }
            return {
                "iteration": 4,
                "loop_status": "DONE",
                "next_delay_sec": 0,
                "summary": "All 4 steps done",
                "next_hint": "None",
            }
        return _send

    clock2 = {"t": 2000.0}
    async def mock_sleep_2(sec):
        clock2["t"] += sec

    rt_stateful = {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_stateful_agent,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": token_box2["total"]},
        "BudgetExceeded": MockBudgetExceeded,
        "monotonic_fn": lambda: clock2["t"],
        "sleep_fn": mock_sleep_2,
        "output_fn": lambda *a: None,
    }

    res2 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Stateful work",
        "state_mode": "stateful",
        "reset_every": 2,
        "max_iterations": 5,
    }, rt_stateful)

    assert res2["status"] == "done"
    assert res2["iteration"] == 4
    assert len(agent_spawns) == 2, f"Expected 2 worker spawns with reset_every=2, got {len(agent_spawns)}"
    assert [t["spawn_idx"] for t in worker_turns] == [1, 1, 2, 2]
    assert "Prior session rotated; last summary: Step 2 ok" in worker_turns[2]["prompt"]

    evs2 = read_events(state_dir, res2["loop_id"])
    resets = [e for e in evs2 if e["event"] == "session_reset"]
    assert len(resets) == 1
    assert resets[0]["iteration"] == 3
    assert resets[0]["reason"] == "reset_every"

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: concurrent --targets parallel() isolates per-target Exception and propagates BudgetExceeded", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    calls = []

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # Scenario A: svc-b raises regular Exception on iter 1, siblings svc-a & svc-c finish cleanly
    def mock_agent_fault(prompt, **kwargs):
        role = kwargs.get("role", "")
        calls.append({"role": role, "prompt": prompt})
        async def _run():
            if "svc-b #1" in role:
                raise RuntimeError("network glitch on svc-b")
            if "#1" in role and "svc-a" in role:
                return {
                    "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                    "summary": "svc-a clean", "next_hint": "None", "changed_files": ["a.py", "shared.py"],
                }
            if "#1" in role and "svc-c" in role:
                return {
                    "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                    "summary": "svc-c clean", "next_hint": "None", "changed_files": ["shared.py", "c.py"],
                }
            return {
                "iteration": 2, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": f"{role} done", "next_hint": "None", "changed_files": ["b.py"],
            }
        return _run()

    clock_a = {"t": 1000.0}
    async def sleep_a(sec):
        clock_a["t"] += sec

    res = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Check services",
        "targets": ["svc-a", "svc-b", "svc-c"],
        "max_iterations": 3,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_fault,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": len(calls) * 20},
        "BudgetExceeded": MockBudgetExceeded,
        "monotonic_fn": lambda: clock_a["t"],
        "sleep_fn": sleep_a,
        "output_fn": lambda *a: None,
    })

    assert res["status"] == "done"
    assert res["iteration"] == 2
    assert len(calls) == 6
    evs = read_events(state_dir, res["loop_id"])
    iter_evs = [e for e in evs if e["event"] == "iteration"]
    assert iter_evs[0]["last_status"] == "CONTINUE"
    assert "[svc-a] DONE: svc-a clean" in iter_evs[0]["summary"]
    assert "[svc-b] CONTINUE: target error: network glitch on svc-b" in iter_evs[0]["summary"]
    assert "[svc-c] DONE: svc-c clean" in iter_evs[0]["summary"]
    assert iter_evs[0]["changed_files"] == ["a.py", "shared.py", "c.py"]

    # Scenario B: BudgetExceeded inside parallel target propagates cleanly to max_reached
    def mock_agent_budget(prompt, **kwargs):
        role = kwargs.get("role", "")
        async def _run():
            if "svc-b" in role:
                raise MockBudgetExceeded("token budget limit exceeded")
            await asyncio.sleep(0.02)
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "ok", "next_hint": "None",
            }
        return _run()

    res_b = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Check services budget",
        "targets": ["svc-a", "svc-b"],
        "max_tokens": 500,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_budget,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 100},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res_b["status"] == "max_reached"
    assert res_b["exit_reason"] == "max_tokens"
    st_b = read_state(state_dir, res_b["loop_id"])
    assert st_b["in_flight_iteration"] is None
    assert st_b["status"] == "max_reached"
    evs_b = read_events(state_dir, res_b["loop_id"])
    assert any(e["event"] == "iteration_end" and e["outcome"] == "budget_exceeded" for e in evs_b)

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: two-stage turn-stopping gate (verify_cmd + loop-verifier fail-closed)", (t) => {
  const sb = makeWorkflowSandbox(t);
  const gateFlagPath = path.join(sb.workspace, "stage1-pass.flag");

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    gate_flag = ${JSON.stringify(gateFlagPath)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # Case 1: iter 1 verify_cmd fails -> 0 verifier calls, forces CONTINUE with tail in next_hint
    #         iter 2 verify_cmd passes -> loop-verifier rejects -> forces CONTINUE
    #         iter 3 verify_cmd passes -> loop-verifier approves -> DONE
    worker_prompts = []
    verifier_calls = []

    def mock_agent_2stage(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                verifier_calls.append({"prompt": prompt, "kwargs": kwargs})
                if len(verifier_calls) == 1:
                    return {"passed": False, "summary": "Missing edge test", "issues": ["Add edge test"]}
                return {"passed": True, "summary": "All checks verified", "issues": []}
            worker_prompts.append(prompt)
            it = len(worker_prompts)
            if it == 2:
                pathlib.Path(gate_flag).write_text("ok", encoding="utf-8")
            return {
                "iteration": it, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": f"Worker claim #{it}", "next_hint": "None",
            }
        return _run()

    verify_sh = f"if test -f '{gate_flag}'; then echo STAGE1_GREEN; exit 0; else echo STAGE1_FAIL_DETAIL >&2; exit 1; fi"
    clock_1 = {"t": 1000.0}
    async def sleep_1(sec):
        clock_1["t"] += sec

    res1 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Deliver feature",
        "verify": True,
        "verifier_model": "pro",
        "verify_cmd": verify_sh,
        "max_iterations": 5,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_2stage,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": (len(worker_prompts) + len(verifier_calls)) * 40},
        "BudgetExceeded": MockBudgetExceeded,
        "monotonic_fn": lambda: clock_1["t"],
        "sleep_fn": sleep_1,
        "output_fn": lambda *a: None,
    })

    assert res1["status"] == "done"
    assert res1["iteration"] == 3
    assert len(worker_prompts) == 3
    assert len(verifier_calls) == 2, "Verifier must NOT be called when Stage 1 verify_cmd fails on iter 1"
    assert verifier_calls[0]["kwargs"]["type_name"] == "loop-verifier"
    assert verifier_calls[0]["kwargs"]["model"] == "pro"
    assert "STAGE1_FAIL_DETAIL" in worker_prompts[1]
    assert "STAGE1_GREEN" in verifier_calls[0]["prompt"]
    assert "Verifier rejected DONE: Add edge test" in worker_prompts[2]

    # Case 2: verify_cmd fails at max_iterations -> BLOCKED verify_cmd_failed with 0 verifier calls
    v_calls_2 = []
    def mock_agent_vfail(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                v_calls_2.append(prompt)
                return {"passed": True, "summary": "should not run", "issues": []}
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "Claimed done", "next_hint": "None",
            }
        return _run()

    res2 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "One shot fail verify_cmd",
        "once": True,
        "verify": True,
        "verify_cmd": "echo BROKEN_BUILD >&2; exit 2",
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_vfail,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 50},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res2["status"] == "blocked"
    assert res2["exit_reason"] == "verify_cmd_failed"
    assert len(v_calls_2) == 0

    # Case 3: loop-verifier returns invalid verdict payload at max_iterations -> fail-closed BLOCKED verifier_error
    def mock_agent_invalid_verdict(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                return {"unexpected": "shape"}
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "Claimed done", "next_hint": "None",
            }
        return _run()

    res3 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Invalid verifier output",
        "once": True,
        "verify": True,
        "verify_cmd": "true",
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_invalid_verdict,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 50},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res3["status"] == "blocked"
    assert res3["exit_reason"] == "verifier_error"

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: sticky budget guard (max_tokens & max_duration_sec) and BudgetExceeded terminal handling", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # 1. Sticky max_tokens: worker hits max_tokens on iter 1 DONE -> loop-verifier NOT called -> max_reached
    tok_box = {"total": 0}
    ver_calls_tok = []
    def mock_agent_tok(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                ver_calls_tok.append(prompt)
                return {"passed": True, "summary": "never", "issues": []}
            tok_box["total"] += 500
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "Done at budget limit", "next_hint": "None",
            }
        return _run()

    res_tok = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Sticky token guard",
        "verify": True,
        "max_tokens": 500,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_tok,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": tok_box["total"]},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res_tok["status"] == "max_reached"
    assert res_tok["exit_reason"] == "max_tokens"
    assert len(ver_calls_tok) == 0
    evs_tok = read_events(state_dir, res_tok["loop_id"])
    ver_ev_tok = [e for e in evs_tok if e["event"] == "verifier"]
    assert len(ver_ev_tok) == 1
    assert ver_ev_tok[0]["skipped_due_to_budget"] is True
    assert ver_ev_tok[0]["unverified_due_to_budget"] is True

    # 2. Sticky max_duration_sec: clock advances past max_duration_sec during worker DONE -> verifier skipped -> max_reached
    clock = {"t": 1000.0}
    ver_calls_dur = []
    def mock_agent_dur(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                ver_calls_dur.append(prompt)
                return {"passed": True, "summary": "never", "issues": []}
            clock["t"] += 25.0
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "Done at duration limit", "next_hint": "None",
            }
        return _run()

    res_dur = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Sticky duration guard",
        "verify": True,
        "max_duration_sec": 10.0,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_dur,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 50},
        "BudgetExceeded": MockBudgetExceeded,
        "monotonic_fn": lambda: clock["t"],
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res_dur["status"] == "max_reached"
    assert res_dur["exit_reason"] == "max_duration"
    assert len(ver_calls_dur) == 0
    evs_dur = read_events(state_dir, res_dur["loop_id"])
    assert any(e["event"] == "verifier" and e.get("unverified_due_to_budget") is True for e in evs_dur)

    # 3. Direct BudgetExceeded from with_budget -> max_reached + clean in_flight_iteration: None
    async def mock_with_budget_raise(awaitable, **kw):
        awaitable.close()
        raise MockBudgetExceeded("time limit (max_seconds=5) exceeded")

    res_exc = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "BudgetExceeded catch",
        "max_duration_sec": 5.0,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0))(),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget_raise,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })
    assert res_exc["status"] == "max_reached"
    assert res_exc["exit_reason"] == "max_duration"
    assert read_state(state_dir, res_exc["loop_id"])["in_flight_iteration"] is None

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: inbox steering (nudge injection, wake during sleep, mid-iteration wake skips sleep, stop)", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
def push_inbox(state_root, loop_id, name, obj):
    inbox_dir = pathlib.Path(state_root, "loops", loop_id, "inbox")
    inbox_dir.mkdir(parents=True, exist_ok=True)
    pathlib.Path(inbox_dir, name).write_text(json.dumps(obj) + "\\n", encoding="utf-8")

async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # Scenario A:
    # - Iter 1: mid-iteration wake pushed while worker runs -> skips sleep before iter 2
    # - Iter 2: nudge + wake during sleep after iter 2 -> wakes 30s sleep in 2 slices!
    # - Iter 3: claimed nudge appears in worker prompt -> DONE
    lid_a = "lp_20261122T000001Z_ab12"
    prompts_a = []
    sleep_calls_a = []

    def mock_agent_a(prompt, **kwargs):
        async def _run():
            prompts_a.append(prompt)
            it = len(prompts_a)
            if it == 1:
                # Mid-iteration wake pushed while worker is running
                push_inbox(state_dir, lid_a, "1000_mid_wake.json", {"type": "wake", "created_at": "2026-11-22T00:00:01Z"})
                return {"iteration": 1, "loop_status": "CONTINUE", "next_delay_sec": 30, "summary": "iter1", "next_hint": "go2"}
            if it == 2:
                return {"iteration": 2, "loop_status": "CONTINUE", "next_delay_sec": 30, "summary": "iter2", "next_hint": "go3"}
            return {"iteration": 3, "loop_status": "DONE", "next_delay_sec": 0, "summary": "iter3 done", "next_hint": "None"}
        return _run()

    async def mock_sleep_a(sec):
        sleep_calls_a.append(sec)
        # On the first sleep slice after iter 2, push nudge --wake
        if len(sleep_calls_a) == 1:
            push_inbox(state_dir, lid_a, "2000_nudge_wake.json", {
                "type": "nudge", "message": "Focus on auth edge case", "wake": True, "created_at": "2026-11-22T00:00:02Z"
            })

    res_a = await run_loop_workflow({
        "loop_id": lid_a,
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Inbox steering test",
        "pacing": "fixed",
        "interval_sec": 30,
        "max_iterations": 5,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_a,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": len(prompts_a) * 10},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": mock_sleep_a,
        "output_fn": lambda *a: None,
    })

    assert res_a["status"] == "done"
    assert res_a["iteration"] == 3
    # Only 1 sleep slice happened (iter 1->2 skipped due to mid-iteration wake; iter 2->3 woke on slice 1!)
    assert len(sleep_calls_a) == 1
    assert "<<<OPERATOR_NUDGES" in prompts_a[2]
    assert "Focus on auth edge case" in prompts_a[2]
    inbox_pending = [p.name for p in pathlib.Path(state_dir, "loops", lid_a, "inbox").glob("*.json")]
    assert inbox_pending == []
    claimed_dir = pathlib.Path(state_dir, "loops", lid_a, "inbox", "claimed")
    assert len(list(claimed_dir.glob("*.json"))) == 2
    evs_a = read_events(state_dir, lid_a)
    assert any(e["event"] == "inbox_claim" and e["iteration"] == 3 and "nudge" in e["types"] for e in evs_a)
    assert any(
        e["event"] == "iteration_start" and e["iteration"] == 3 and e.get("nudge_count") == 1 and "nudges_count" not in e
        for e in evs_a
    )

    # Scenario B: stop message in inbox exits cleanly as stopped
    lid_b = "lp_20261122T000002Z_cd34"
    prompts_b = []
    def mock_agent_b(prompt, **kwargs):
        async def _run():
            prompts_b.append(prompt)
            return {"iteration": 1, "loop_status": "CONTINUE", "next_delay_sec": 20, "summary": "iter1", "next_hint": "go2"}
        return _run()

    async def mock_sleep_b(sec):
        push_inbox(state_dir, lid_b, "3000_stop.json", {"type": "stop", "mode": "immediate", "created_at": "2026-11-22T00:00:03Z"})

    res_b = await run_loop_workflow({
        "loop_id": lid_b,
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Inbox stop test",
        "pacing": "fixed",
        "interval_sec": 20,
        "max_iterations": 5,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_b,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": mock_sleep_b,
        "output_fn": lambda *a: None,
    })
    assert res_b["status"] == "stopped"
    assert res_b["exit_reason"] == "stop_requested"
    assert len(prompts_b) == 1
    assert read_state(state_dir, lid_b)["status"] == "stopped"

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: finally double-insurance sets status='error' and clears in_flight_iteration on uncaught exception", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}

    async def mock_parallel_boom(items, fn):
        raise RuntimeError("unhandled parallel crash")

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    res = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Uncaught exception test",
        "targets": ["t1", "t2"],
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0))(),
        "parallel": mock_parallel_boom,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 0},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })

    assert res["ok"] is False
    assert res["status"] == "error"
    assert res["status"] != "done"
    assert res["exit_reason"] == "unhandled_exception"
    st = read_state(state_dir, res["loop_id"])
    assert st["status"] == "error"
    assert st["exit_reason"] == "unhandled_exception"
    assert st["in_flight_iteration"] is None
    assert st["in_flight_snapshot_hash"] is None
    evs = read_events(state_dir, res["loop_id"])
    assert any(e["event"] == "iteration_end" and e["outcome"] == "error" for e in evs)
    assert any(e["event"] == "error" and e["status"] == "error" for e in evs)

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py: explicit probe_until_pass exits DONE at 0 tokens, loop.md never executed as shell, snapshot frozen mid-iteration", (t) => {
  const sb = makeWorkflowSandbox(t);
  const pwnMarker1 = path.join(sb.workspace, "pwn-probe-marker");
  const pwnMarker2 = path.join(sb.workspace, "pwn-verify-marker");
  const agentsDir = path.join(sb.workspace, ".agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const loopMdPath = path.join(agentsDir, "loop.md");
  fs.writeFileSync(
    loopMdPath,
    `INITIAL_FROZEN_TASK $(touch "${pwnMarker1}") \`touch "${pwnMarker2}"\`\n`,
    "utf8"
  );

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    loop_md = ${JSON.stringify(loopMdPath)}
    pwn1 = ${JSON.stringify(pwnMarker1)}
    pwn2 = ${JSON.stringify(pwnMarker2)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # 1. Explicit probe_cmd + probe_until_pass -> exits DONE at 0 tokens with 0 agent calls
    agent_calls_probe = []
    res_probe = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "loop_md_or_default",
        "probe_cmd": "echo PROBE_OK && exit 0",
        "probe_until_pass": True,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda *a, **kw: agent_calls_probe.append(1),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 0},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_probe["ok"] is True
    assert res_probe["status"] == "done"
    assert res_probe["exit_reason"] == "probe_passed"
    assert res_probe["usage_totals"]["total_tokens"] == 0
    assert len(agent_calls_probe) == 0
    assert not pathlib.Path(pwn1).exists()
    assert not pathlib.Path(pwn2).exists()
    evs_probe = read_events(state_dir, res_probe["loop_id"])
    assert any(e["event"] == "probe_skip" for e in evs_probe)

    # 2. Frozen snapshot & loop.md shell safety: mutating loop.md mid-iteration does NOT leak to verifier
    verifier_prompts = []
    def mock_agent_snap(prompt, **kwargs):
        async def _run():
            if kwargs.get("type_name") == "loop-verifier":
                verifier_prompts.append(prompt)
                return {"passed": True, "summary": "Verified against frozen snapshot", "issues": []}
            # Mutate .agents/loop.md mid-iteration after worker starts!
            pathlib.Path(loop_md).write_text("MUTATED_MID_ITERATION_OBJECTIVE\\n", encoding="utf-8")
            return {
                "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0,
                "summary": "Worker done", "next_hint": "None",
            }
        return _run()

    res_snap = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "loop_md_or_default",
        "verify": True,
        "once": True,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_snap,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 30},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_snap["status"] == "done"
    assert len(verifier_prompts) == 1
    assert "INITIAL_FROZEN_TASK" in verifier_prompts[0]
    assert "MUTATED_MID_ITERATION_OBJECTIVE" not in verifier_prompts[0]
    assert not pathlib.Path(pwn1).exists()
    assert not pathlib.Path(pwn2).exists()

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
  assert.equal(fs.existsSync(pwnMarker1), false);
  assert.equal(fs.existsSync(pwnMarker2), false);
});

test("workflow.py #72 regressions: max_agents=2 with 3 targets spawns 0 agents, delayed one-shot capped by max_duration_sec", (t) => {
  const sb = makeWorkflowSandbox(t);

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # 1. max_agents=2 with 3 targets -> stops with max_reached / max_agents and 0 spawned agents
    spawned_1 = []
    def mock_agent_1(*a, **kw):
        spawned_1.append(kw)
        async def _never():
            return {"iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "ok", "next_hint": "None"}
        return _never()

    res1 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Parallel over agent budget",
        "targets": ["t1", "t2", "t3"],
        "max_agents": 2,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_1,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 0},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res1["status"] == "max_reached"
    assert res1["exit_reason"] == "max_agents"
    assert len(spawned_1) == 0, f"Expected 0 spawned agents, got {len(spawned_1)}"

    # 2. Delayed one-shot (once=True, interval_sec=30 > max_duration_sec=5) capped by max_duration_sec -> max_reached/max_duration & 0 agents
    spawned_2 = []
    sleeps_2 = []
    clock_2 = {"t": 5000.0}
    async def mock_sleep_2(sec):
        sleeps_2.append(sec)
        clock_2["t"] += sec

    res2 = await run_loop_workflow({
        "workspace_dir": ws,
        "task_source": "inline",
        "prompt": "Capped delayed one-shot",
        "once": True,
        "interval_sec": 30,
        "max_duration_sec": 5.0,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda *a, **kw: spawned_2.append(1),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 0},
        "BudgetExceeded": MockBudgetExceeded,
        "monotonic_fn": lambda: clock_2["t"],
        "sleep_fn": mock_sleep_2,
        "output_fn": lambda *a: None,
    })
    assert res2["status"] == "max_reached"
    assert res2["exit_reason"] == "max_duration"
    assert len(spawned_2) == 0
    assert sleeps_2 == [1.0] * 5

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
});

test("workflow.py v2.0: multi-profile resolution, frontmatter defaults, STRICT block of frontmatter probe_cmd/verify_cmd, and Gate 4 terminal wake relay", (t) => {
  const sb = makeWorkflowSandbox(t);
  const pwnProbe = path.join(sb.workspace, "pwn-fm-probe");
  const pwnVerify = path.join(sb.workspace, "pwn-fm-verify");
  const pwnReloadProbe = path.join(sb.workspace, "pwn-fm-reload-probe");

  const wsLoopsDir = path.join(sb.workspace, ".agents", "loops");
  const globalLoopsDir = path.join(sb.home, ".gemini", "config", "loops");
  fs.mkdirSync(wsLoopsDir, { recursive: true });
  fs.mkdirSync(globalLoopsDir, { recursive: true });

  fs.writeFileSync(
    path.join(globalLoopsDir, "shared.md"),
    "---\nworker_model: flash\nmax_iterations: 2\n---\nGlobal shared profile body\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    [
      "---",
      "name: ci",
      "interval: 15s",
      "max_iterations: 4",
      "state_mode: stateful",
      "reset_every: 2",
      "worker_model: flash",
      "verify: true",
      "verifier_model: pro",
      "worktree: true",
      "budget_tokens: 5000",
      "max_errors: 2",
      "targets: [api, web]",
      "singleton: profile",
      `probe_cmd: "touch '${pwnProbe}' && exit 0"`,
      "probe_until_pass: true",
      `verify_cmd: "touch '${pwnVerify}' && exit 1"`,
      "---",
      "Workspace CI profile body v1",
    ].join("\n"),
    "utf8"
  );
  const customProfileFile = path.join(sb.workspace, "custom-task.md");
  fs.writeFileSync(
    customProfileFile,
    "---\nmax_iterations: 3\n---\nCustom file body\n",
    "utf8"
  );

  const script = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    ci_path = ${JSON.stringify(path.join(wsLoopsDir, "ci.md"))}
    pwn_probe = ${JSON.stringify(pwnProbe)}
    pwn_verify = ${JSON.stringify(pwnVerify)}
    pwn_reload = ${JSON.stringify(pwnReloadProbe)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))

    async def mock_with_budget(awaitable, **kw):
        return await awaitable

    # 1. Workspace profile overrides global & applies safe frontmatter defaults while NEVER executing frontmatter commands!
    logs_1 = []
    worker_calls_1 = []
    verifier_calls_1 = []

    def mock_agent_1(prompt, **kwargs):
        if kwargs.get("type_name") == "loop-verifier":
            async def _ver():
                verifier_calls_1.append({"prompt": prompt, "kwargs": kwargs})
                return {"passed": True, "summary": "Verified without fm cmds", "issues": []}
            return _ver()
        worker_calls_1.append({"prompt": prompt, "kwargs": kwargs})
        async def _send(turn_prompt, schema=None):
            worker_calls_1.append({"turn_prompt": turn_prompt})
            return {
                "iteration": 1,
                "loop_status": "DONE",
                "next_delay_sec": 0,
                "summary": "Target done",
                "next_hint": "None",
            }
        return _send

    res_ci = await run_loop_workflow({
        "workspace_dir": ws,
        "profile": "ci",
        # Override targets=[] explicitly to run single worker; verify frontmatter defaults for model/verify/max_iterations
        "targets": [],
        "max_iterations": 2,  # Explicit override > frontmatter 4
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: logs_1.append(" ".join(str(x) for x in a)),
        "agent": mock_agent_1,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 30},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })

    assert res_ci["ok"] is True
    assert res_ci["status"] == "done"
    assert res_ci["profile_name"] == "ci"
    assert res_ci["singleton"] == "profile"
    assert res_ci["max_iterations"] == 2
    assert not pathlib.Path(pwn_probe).exists(), "Frontmatter probe_cmd MUST NEVER execute in workflow.py"
    assert not pathlib.Path(pwn_verify).exists(), "Frontmatter verify_cmd MUST NEVER execute in workflow.py"
    assert any("Skipping untrusted frontmatter probe_cmd/verify_cmd" in line for line in logs_1)
    assert len(verifier_calls_1) == 1
    assert verifier_calls_1[0]["kwargs"]["model"] == "pro"
    assert worker_calls_1[0]["kwargs"]["model"] == "flash"
    assert worker_calls_1[0]["kwargs"]["workspace"] == "branch"
    assert "Workspace CI profile body v1" in worker_calls_1[1]["turn_prompt"]
    assert "probe_cmd:" not in worker_calls_1[1]["turn_prompt"]

    # 2. Global profile lookup + profile_file lookup + validation errors
    res_global = await run_loop_workflow({
        "workspace_dir": ws,
        "profile": "shared",
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "ok", "next_hint": "None"
        }))(),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_global["status"] == "done"
    assert res_global["profile_name"] == "shared"
    assert res_global["max_iterations"] == 2

    res_file = await run_loop_workflow({
        "workspace_dir": ws,
        "profile_file": "custom-task.md",
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "file ok", "next_hint": "None"
        }))(),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_file["status"] == "done"
    assert res_file["profile_name"] == "custom-task"
    assert res_file["max_iterations"] == 3

    # Reject traversal and mutually exclusive profile + profile_file
    for bad_args in [
        {"workspace_dir": ws, "profile": "../evil"},
        {"workspace_dir": ws, "profile": "ci", "profile_file": "custom-task.md"},
        {"workspace_dir": ws, "profile": "ci", "prompt": "inline conflict"},
    ]:
        raised = False
        try:
            await run_loop_workflow(bad_args, {
                "agent": lambda *a, **kw: None, "parallel": mock_parallel, "with_budget": mock_with_budget,
            })
        except ValueError:
            raised = True
        assert raised, f"Expected ValueError for {bad_args}"

    # 3. Gate 4 terminal wake_requested relay + live-reloaded frontmatter command never runs
    relay_path = pathlib.Path(ws, ".agents", "loops", "relay.md")
    relay_path.write_text("---\\nsingleton: profile\\nmax_iterations: 3\\n---\\nInitial relay profile v1\\n", encoding="utf-8")
    lid_relay = "lp_20261123T001000Z_rel1"
    prompts_relay = []

    def mock_agent_relay(prompt, **kwargs):
        async def _run():
            prompts_relay.append(prompt)
            it = len(prompts_relay)
            if it == 1:
                # Mutate relay.md with untrusted probe_cmd AND push nudge --wake before DONE finishes!
                relay_path.write_text(
                    f"---\\nprobe_cmd: \\"touch '{pwn_reload}'\\"\\n---\\nReloaded body v2\\n",
                    encoding="utf-8",
                )
                inbox_dir = pathlib.Path(state_dir, "loops", lid_relay, "inbox")
                inbox_dir.mkdir(parents=True, exist_ok=True)
                pathlib.Path(inbox_dir, "9000_wake.json").write_text(
                    json.dumps({"type": "nudge", "message": "Handle relayed work", "wake": True}) + "\\n",
                    encoding="utf-8",
                )
                return {"iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "First pass done", "next_hint": "None"}
            return {"iteration": 2, "loop_status": "DONE", "next_delay_sec": 0, "summary": "Relayed pass done", "next_hint": "None"}
        return _run()

    res_relay = await run_loop_workflow({
        "loop_id": lid_relay,
        "workspace_dir": ws,
        "profile": "relay",
        "state_mode": "fresh",
        "verify": False,
        "max_iterations": 3,
        "relay_on_wake": True,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_relay,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": len(prompts_relay) * 20},
        "BudgetExceeded": MockBudgetExceeded,
        "sleep_fn": lambda _s: asyncio.sleep(0),
        "output_fn": lambda *a: None,
    })

    assert res_relay["ok"] is True
    assert res_relay["status"] == "done"
    assert res_relay["iteration"] == 2
    assert res_relay["relay_count"] == 1
    assert len(prompts_relay) == 2
    assert "Reloaded body v2" in prompts_relay[1]
    assert "Handle relayed work" in prompts_relay[1]
    assert not pathlib.Path(pwn_reload).exists(), "Reloaded frontmatter probe_cmd MUST NOT execute"
    st_relay = read_state(state_dir, lid_relay)
    assert st_relay["relay_count"] == 1
    evs_relay = read_events(state_dir, lid_relay)
    assert any(e["event"] == "relay" and e["relay_count"] == 1 for e in evs_relay)

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });
  assert.equal(fs.existsSync(pwnProbe), false);
  assert.equal(fs.existsSync(pwnVerify), false);
  assert.equal(fs.existsSync(pwnReloadProbe), false);
});

test("workflow.py <-> lib/lease-lock.mjs cross-runtime lock parity, Node<->Python coalescing/blocking, and dead-PID reclaim", async (t) => {
  const sb = makeWorkflowSandbox(t);
  const { computeLockScope, acquireLeaseLock, releaseLeaseLock, getLeaseLockPath } = await import(
    "../lib/lease-lock.mjs"
  );
  const { createLoopState, peekInboxFlags, claimInboxMessages } = await import(
    "../lib/state-store.mjs"
  );

  // 1. Byte-for-byte computeLockScope parity between Node and Python
  const scopePairs = [
    ["none", null],
    ["workspace", null],
    ["profile", null],
    ["profile", "ci"],
    ["profile", "nightly.audit_v2"],
  ];
  const nodeScopes = scopePairs.map(([singleton, profileName]) =>
    computeLockScope({ singleton, workspaceDir: sb.workspace, profileName })
  );

  const parityScript = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    pairs = json.loads(${JSON.stringify(JSON.stringify(scopePairs))})
    expected = json.loads(${JSON.stringify(JSON.stringify(nodeScopes))})
    py_scopes = [NS["compute_lock_scope"](s, ws, p) for s, p in pairs]
    assert py_scopes == expected, f"Scope mismatch: {py_scopes} vs {expected}"
asyncio.run(main())
`;
  runPythonHarness(parityScript, { cwd: sb.workspace, env: sb.env });

  // Ensure ci profile exists in this fresh sandbox for run_loop_workflow lock tests
  const wsLoopsDir = path.join(sb.workspace, ".agents", "loops");
  fs.mkdirSync(wsLoopsDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    "---\nsingleton: profile\n---\nCI cross-runtime parity body\n",
    "utf8"
  );

  // 2. Live Node lock coalesced/skipped/blocked by Python workflow.py + dead-PID reclaim
  const scopeKey = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "ci",
  });
  const nodeLoop = createLoopState(sb.stateDir, {
    loop_id: "lp_20261123T002000Z_node",
    status: "running",
    workspace_dir: sb.workspace,
    engine: "headless",
    pid: process.pid,
  });
  const nodeHandleRes = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: nodeLoop.loop_id,
    pid: process.pid,
    profileName: "ci",
    workspaceDir: sb.workspace,
    leaseTtlMs: 60000,
    onConflict: "fail",
  });
  assert.equal(nodeHandleRes.acquired, true);

  const nodeHoldsPyContends = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    spawned = []
    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))
    async def mock_with_budget(awaitable, **kw):
        return await awaitable
    rt = {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda *a, **kw: spawned.append(1),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 0},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    }

    res_fail = await run_loop_workflow({
        "workspace_dir": ws, "profile": "ci", "singleton": "profile", "on_conflict": "fail",
    }, rt)
    assert res_fail["ok"] is False
    assert res_fail["status"] == "lock_conflict"
    assert res_fail["exit_reason"] == "lock_conflict"
    assert res_fail["active_loop_id"] == ${JSON.stringify(nodeLoop.loop_id)}

    res_skip = await run_loop_workflow({
        "workspace_dir": ws, "profile": "ci", "singleton": "profile", "on_conflict": "skip",
    }, rt)
    assert res_skip["ok"] is True
    assert res_skip["status"] == "skipped"
    assert res_skip["exit_reason"] == "singleton_skipped"

    res_wake = await run_loop_workflow({
        "workspace_dir": ws, "profile": "ci", "singleton": "profile", "on_conflict": "wake",
    }, rt)
    assert res_wake["ok"] is True
    assert res_wake["status"] == "coalesced"
    assert res_wake["exit_reason"] == "singleton_coalesced"
    assert len(spawned) == 0

asyncio.run(main())
`;
  runPythonHarness(nodeHoldsPyContends, { cwd: sb.workspace, env: sb.env });
  assert.equal(peekInboxFlags(sb.stateDir, nodeLoop.loop_id).wake, true);
  const claimedInNode = claimInboxMessages(sb.stateDir, nodeLoop.loop_id);
  assert.equal(claimedInNode.length, 1);
  assert.equal(claimedInNode[0].type, "wake");
  assert.equal(claimedInNode[0].reason, "singleton_coalesced");
  assert.equal(releaseLeaseLock(nodeHandleRes.handle), true);

  // 3. Python workflow.py reclaims dead-PID lock cleanly
  fs.mkdirSync(path.dirname(getLeaseLockPath(sb.stateDir, scopeKey)), { recursive: true });
  fs.writeFileSync(
    getLeaseLockPath(sb.stateDir, scopeKey),
    JSON.stringify({
      scope: "profile",
      scope_key: scopeKey,
      loop_id: "lp_20261123T002001Z_dead",
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
  const pyReclaimScript = `
async def main():
    ws = ${JSON.stringify(sb.workspace)}
    res = await run_loop_workflow({
        "workspace_dir": ws, "profile": "ci", "singleton": "profile", "on_conflict": "fail", "once": True,
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "reclaimed", "next_hint": "None"
        }))(),
        "parallel": lambda items, fn: asyncio.gather(*(fn(x) for x in items)),
        "with_budget": lambda aw, **kw: aw,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res["status"] == "done"
    assert res["lock_scope_key"] == ${JSON.stringify(scopeKey)}
asyncio.run(main())
`;
  runPythonHarness(pyReclaimScript, { cwd: sb.workspace, env: sb.env });
  assert.equal(fs.existsSync(getLeaseLockPath(sb.stateDir, scopeKey)), false);

  // 4. Live Python lock coalesced/blocked by Node lib/lease-lock.mjs
  const pyHolderLoopId = "lp_20261123T002002Z_pyhd";
  const pyHolderSrc = `
import ast, asyncio, inspect, pathlib, sys
SRC = pathlib.Path(${JSON.stringify(WORKFLOW_PY_PATH)}).read_text(encoding="utf-8")
NS = {"__file__": ${JSON.stringify(WORKFLOW_PY_PATH)}, "__name__": "py_holder"}
CODE_OBJ = compile(SRC, ${JSON.stringify(WORKFLOW_PY_PATH)}, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
async def main():
    res = eval(CODE_OBJ, NS, NS)
    if inspect.iscoroutine(res):
        await res
    lock_res = await NS["acquire_lease_lock"](
        state_root=${JSON.stringify(sb.stateDir)},
        scope="profile",
        scope_key=${JSON.stringify(scopeKey)},
        loop_id=${JSON.stringify(pyHolderLoopId)},
        engine="workflow",
        profile_name="ci",
        workspace_dir=${JSON.stringify(sb.workspace)},
        lease_ttl_ms=60000,
        on_conflict="fail",
    )
    assert lock_res["acquired"] is True
    sys.stdout.write("LOCKED\\n")
    sys.stdout.flush()
    await asyncio.get_event_loop().run_in_executor(None, sys.stdin.read)
    flags = NS["peek_inbox_flags"](${JSON.stringify(sb.stateDir)}, ${JSON.stringify(pyHolderLoopId)})
    claimed = NS["claim_inbox_messages"](${JSON.stringify(sb.stateDir)}, ${JSON.stringify(pyHolderLoopId)})
    assert flags["wake"] is True
    assert any(m.get("type") == "wake" and m.get("reason") == "singleton_coalesced" for m in claimed)
    NS["release_lease_lock"](lock_res["handle"])
asyncio.run(main())
`;
  const pyHolder = spawn("python3", ["-c", pyHolderSrc], {
    cwd: sb.workspace,
    env: sb.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      pyHolder.kill("SIGKILL");
    } catch {
      // Ignore cleanup errors
    }
  });

  await new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    pyHolder.stdout.on("data", (d) => {
      out += d.toString("utf8");
      if (out.includes("LOCKED")) resolve();
    });
    pyHolder.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    pyHolder.on("close", (code) => {
      if (!out.includes("LOCKED")) {
        reject(new Error(`Python holder exited early (${code}): ${err}`));
      }
    });
  });

  const nodeFail = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T002003Z_nct1",
    pid: process.pid + 1,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "fail",
  });
  assert.equal(nodeFail.acquired, false);
  assert.equal(nodeFail.action, "conflict");
  assert.equal(nodeFail.holder.loop_id, pyHolderLoopId);

  const nodeWake = await acquireLeaseLock({
    stateRoot: sb.stateDir,
    scope: "profile",
    scopeKey,
    loopId: "lp_20261123T002004Z_nct2",
    pid: process.pid + 2,
    profileName: "ci",
    workspaceDir: sb.workspace,
    onConflict: "wake",
  });
  assert.equal(nodeWake.acquired, false);
  assert.equal(nodeWake.action, "coalesced");

  pyHolder.stdin.end();
  const pyExit = await new Promise((resolve) => {
    let err = "";
    pyHolder.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    pyHolder.on("close", (status) => resolve({ status, err }));
  });
  assert.equal(pyExit.status, 0, pyExit.err);
  assert.equal(fs.existsSync(getLeaseLockPath(sb.stateDir, scopeKey)), false);
});

test("workflow.py #95 regressions: default loop.md name: parity, once/targets=[] overrides, guarded Gate 2 reclaim, validation, & max_agents relay guard", async (t) => {
  const sb = makeWorkflowSandbox(t);
  const { computeLockScope, getLeaseLockPath } = await import("../lib/lease-lock.mjs");

  // Default .agents/loop.md with `name: main-ci` MUST match Node computeLockScope byte-for-byte
  const defaultDir = path.join(sb.workspace, ".agents");
  const wsLoopsDir = path.join(defaultDir, "loops");
  fs.mkdirSync(wsLoopsDir, { recursive: true });
  fs.writeFileSync(
    path.join(defaultDir, "loop.md"),
    "---\nname: main-ci\nsingleton: profile\n---\nDefault main-ci loop\n",
    "utf8"
  );
  const expectedDefaultScope = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "main-ci",
  });

  // Profile with max_iterations: 15, targets: [api, web] + once/stateful profiles
  fs.writeFileSync(
    path.join(wsLoopsDir, "ci.md"),
    "---\nmax_iterations: 15\ntargets: [api, web]\nsingleton: profile\n---\nCI body\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(wsLoopsDir, "onceonly.md"),
    "---\nonce: true\n---\nOnce body\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(wsLoopsDir, "stateful.md"),
    "---\nstate_mode: stateful\nreset_every: 4\n---\nStateful body\n",
    "utf8"
  );

  // Seed one dead-PID stale lock for multi-coro / multi-process Gate 2 guarded reclaim
  const raceScopeKey = computeLockScope({
    singleton: "profile",
    workspaceDir: sb.workspace,
    profileName: "race",
  });
  const raceLockPath = getLeaseLockPath(sb.stateDir, raceScopeKey);
  fs.mkdirSync(path.dirname(raceLockPath), { recursive: true });
  fs.writeFileSync(
    raceLockPath,
    JSON.stringify({
      scope: "profile",
      scope_key: raceScopeKey,
      loop_id: "lp_20261123T005100Z_dead",
      pid: 99999999,
      engine: "workflow",
      profile: "race",
      workspace_dir: sb.workspace,
      acquired_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      lease_ttl_ms: 60000,
      draining: false,
    }),
    { encoding: "utf8", mode: 0o600 }
  );

  const script = `
import subprocess

async def main():
    ws = ${JSON.stringify(sb.workspace)}
    home_dir = ${JSON.stringify(sb.home)}
    state_dir = ${JSON.stringify(sb.stateDir)}
    expected_default_scope = ${JSON.stringify(expectedDefaultScope)}

    async def mock_parallel(items, fn):
        return await asyncio.gather(*(fn(x) for x in items))
    async def mock_with_budget(aw, **kw):
        return await aw

    # 1. Default .agents/loop.md with name: main-ci produces byte-identical pf_<16hex> lock_scope_key vs Node
    resolved_default = NS["resolve_profile_task"](ws, home_dir)
    assert resolved_default["profile_name"] == "main-ci"
    res_default = await run_loop_workflow({"workspace_dir": ws, "once": True}, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": lambda p, **kw: (lambda: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "default ok", "next_hint": "None"
        }))(),
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 5},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_default["profile_name"] == "main-ci"
    assert res_default["lock_scope_key"] == expected_default_scope

    # 2. {profile: "ci", once: True} overrides fm.max_iterations=15 AND {profile: "ci", targets: []} honors empty []
    single_agent_calls = []
    def mock_agent_ci(prompt, **kw):
        single_agent_calls.append(prompt)
        return asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "override ok", "next_hint": "None"
        })
    res_override = await run_loop_workflow({
        "workspace_dir": ws, "profile": "ci", "once": True, "targets": [],
    }, {
        "phase": lambda _n: None,
        "log": lambda *a: None,
        "agent": mock_agent_ci,
        "parallel": mock_parallel,
        "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 10},
        "BudgetExceeded": MockBudgetExceeded,
        "output_fn": lambda *a: None,
    })
    assert res_override["status"] == "done"
    assert res_override["max_iterations"] == 1
    assert len(single_agent_calls) == 1, f"Expected single-worker call with targets=[], got {len(single_agent_calls)}"

    # Explicit max_iterations > 1 overrides fm.once=true; explicit state_mode="fresh" ignores fm.reset_every=4
    res_max = await run_loop_workflow({
        "workspace_dir": ws, "profile": "onceonly", "max_iterations": 5,
    }, {
        "phase": lambda _n: None, "log": lambda *a: None,
        "agent": lambda p, **kw: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "ok", "next_hint": "None"
        }),
        "parallel": mock_parallel, "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 5}, "BudgetExceeded": MockBudgetExceeded, "output_fn": lambda *a: None,
    })
    assert res_max["max_iterations"] == 5

    res_fresh = await run_loop_workflow({
        "workspace_dir": ws, "profile": "stateful", "state_mode": "fresh",
    }, {
        "phase": lambda _n: None, "log": lambda *a: None,
        "agent": lambda p, **kw: asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "ok", "next_hint": "None"
        }),
        "parallel": mock_parallel, "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 5}, "BudgetExceeded": MockBudgetExceeded, "output_fn": lambda *a: None,
    })
    assert res_fresh["status"] == "done"

    # 3. Strict validation: validate_sidecar_grants, validate_cron_expression, validate_profile_name, newlines
    assert NS["validate_profile_name"]("a..b") is False
    for bad_grant in ["read_file(///)", "read_file(/.)", "read_file(/..)", "mcp(*:*)", "read_file(C:\\\\)", "read_file(a\\nb)"]:
        try:
            NS["validate_sidecar_grants"]([bad_grant])
            raise AssertionError(f"Expected ValueError for grant {bad_grant!r}")
        except ValueError:
            pass
    for bad_cron in ["99 99 99 99 99", "0 25 * * *", "* * 0 * *"]:
        try:
            NS["validate_cron_expression"](bad_cron)
            raise AssertionError(f"Expected ValueError for cron {bad_cron!r}")
        except ValueError:
            pass
    for bad_fm in ['---\\nname: a..b\\n---\\nBody\\n', '---\\nworker_model: "a\\\\nb"\\n---\\nBody\\n']:
        try:
            NS["parse_profile_document"](bad_fm.encode("utf-8"), source_label="bad.md")
            raise AssertionError(f"Expected ValueError for frontmatter {bad_fm!r}")
        except ValueError:
            pass

    # 4. Gate 4 _try_terminal_relay() respects max_agents=1 in state_mode="fresh"
    lid_max_ag = "lp_20261123T005200Z_mags"
    def mock_agent_max_ag(prompt, **kw):
        inbox_dir = pathlib.Path(state_dir, "loops", lid_max_ag, "inbox")
        inbox_dir.mkdir(parents=True, exist_ok=True)
        pathlib.Path(inbox_dir, "9000_wake.json").write_text(
            json.dumps({"type": "wake", "reason": "singleton_coalesced"}), encoding="utf-8"
        )
        return asyncio.sleep(0, result={
            "iteration": 1, "loop_status": "DONE", "next_delay_sec": 0, "summary": "max agents cap", "next_hint": "None"
        })
    res_max_ag = await run_loop_workflow({
        "loop_id": lid_max_ag, "workspace_dir": ws, "state_mode": "fresh",
        "max_iterations": 3, "max_agents": 1, "relay_on_wake": True, "verify": False,
    }, {
        "phase": lambda _n: None, "log": lambda *a: None, "agent": mock_agent_max_ag,
        "parallel": mock_parallel, "with_budget": mock_with_budget,
        "tokens_used": lambda _s=None: {"total_tokens": 5}, "BudgetExceeded": MockBudgetExceeded, "output_fn": lambda *a: None,
    })
    assert res_max_ag["status"] == "done"
    assert res_max_ag["iteration"] == 1
    assert res_max_ag["relay_count"] == 0

asyncio.run(main())
`;
  runPythonHarness(script, { cwd: sb.workspace, env: sb.env });

  // 5. Multi-process Gate 2 guarded stale reclaim race in Python workflow.py + 0o600 mode
  const pyRacerSrc = `
import ast, asyncio, inspect, json, os, pathlib, sys
SRC = pathlib.Path(${JSON.stringify(WORKFLOW_PY_PATH)}).read_text(encoding="utf-8")
NS = {"__file__": ${JSON.stringify(WORKFLOW_PY_PATH)}, "__name__": "py_racer"}
CODE_OBJ = compile(SRC, ${JSON.stringify(WORKFLOW_PY_PATH)}, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
async def main():
    res = eval(CODE_OBJ, NS, NS)
    if inspect.iscoroutine(res):
        await res
    idx = int(sys.argv[1])
    lock_res = await NS["acquire_lease_lock"](
        state_root=${JSON.stringify(sb.stateDir)},
        scope="profile",
        scope_key=${JSON.stringify(raceScopeKey)},
        loop_id=f"lp_20261123T005300Z_pr{idx}",
        engine="workflow",
        profile_name="race",
        workspace_dir=${JSON.stringify(sb.workspace)},
        lease_ttl_ms=60000,
        on_conflict="fail",
    )
    if lock_res["acquired"]:
        mode = os.stat(lock_res["lock_path"]).st_mode & 0o777
        await asyncio.sleep(0.15)
        NS["release_lease_lock"](lock_res["handle"])
        sys.stdout.write(json.dumps({"acquired": True, "mode": mode}) + "\\n")
    else:
        sys.stdout.write(json.dumps({"acquired": False, "action": lock_res["action"]}) + "\\n")
asyncio.run(main())
`;
  const pyRacers = Array.from({ length: 4 }, (_, i) =>
    new Promise((resolve, reject) => {
      const child = spawn("python3", ["-c", pyRacerSrc, String(i)], {
        cwd: sb.workspace,
        env: sb.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString("utf8")));
      child.stderr.on("data", (d) => (err += d.toString("utf8")));
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`Py racer ${i} failed (${code}): ${err}`));
        else resolve(JSON.parse(out.trim()));
      });
    })
  );
  const pyResults = await Promise.all(pyRacers);
  const pyWinners = pyResults.filter((r) => r.acquired);
  const pyLosers = pyResults.filter((r) => !r.acquired);
  assert.equal(pyWinners.length, 1);
  assert.equal(pyWinners[0].mode, 0o600);
  assert.equal(pyLosers.length, 3);
  for (const l of pyLosers) {
    assert.equal(l.action, "conflict");
  }
  assert.equal(fs.existsSync(raceLockPath), false);
  assert.equal(fs.existsSync(`${raceLockPath}.reclaim.lock`), false);
});



