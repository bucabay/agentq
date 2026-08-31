import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  addTask, archiveProject, claim, finish, heartbeat, history, inFlight, listProjects, listTasks,
  migrate, pool, upsertProject,
} from "../src/providers/postgres.mjs";

const URL = process.env.AGENTQ_TEST_URL ?? "postgres://127.0.0.1:5432/agents_test";
const db = pool(URL);
await migrate(db);

const P = "test-project";

beforeEach(async () => {
  await db.query("delete from run where project = $1", [P]);
  await db.query("delete from task where project = $1", [P]);
  await db.query("delete from project where name = $1", [P]);
});

after(async () => {
  await db.query("delete from run where project = $1", [P]);
  await db.query("delete from task where project = $1", [P]);
  await db.query("delete from project where name = $1", [P]);
  await db.end();
});

const add = (over = {}) => addTask(db, { project: P, title: "t", ...over });
const take = (over = {}) => claim(db, { project: P, agent: "a1", ...over });

describe("claiming", () => {
  it("returns null when nothing is queued", async () => {
    assert.equal(await take(), null);
  });

  it("hands out a task with a run number and the task body", async () => {
    await add({ title: "build the thing", body: "details here" });
    const got = await take();
    assert.equal(got.task.title, "build the thing");
    assert.equal(got.task.body, "details here");
    assert.equal(got.run.run_number, 1);
    assert.equal(got.run.state, "running");
  });

  it("numbers runs monotonically per project", async () => {
    await add({ lane: "a" });
    await add({ lane: "b" });
    const first = await take();
    const second = await take();
    assert.equal(first.run.run_number, 1);
    assert.equal(second.run.run_number, 2);
  });

  it("keeps numbering across finished runs", async () => {
    await add({ lane: "a" });
    const first = await take();
    await finish(db, first.run.id, { state: "done" });
    await add({ lane: "a" });
    assert.equal((await take()).run.run_number, 2);
  });

  it("respects priority, then insertion order", async () => {
    await add({ title: "low", lane: "x", priority: 200 });
    await add({ title: "high", lane: "y", priority: 1 });
    assert.equal((await take()).task.title, "high");
  });
});

describe("lanes decide what runs in parallel", () => {
  it("serialises two tasks in the same lane", async () => {
    await add({ title: "first", lane: "core" });
    await add({ title: "second", lane: "core" });

    const first = await take();
    assert.equal(first.task.title, "first");

    // The lane is busy, so a second agent gets nothing even though work is queued.
    assert.equal(await claim(db, { project: P, agent: "a2" }), null);

    await finish(db, first.run.id, { state: "done" });
    assert.equal((await claim(db, { project: P, agent: "a2" })).task.title, "second");
  });

  it("runs different lanes at the same time", async () => {
    await add({ title: "api work", lane: "api" });
    await add({ title: "docs work", lane: "docs" });

    const a = await claim(db, { project: P, agent: "a1" });
    const b = await claim(db, { project: P, agent: "a2" });

    assert.ok(a && b, "both agents should get work");
    assert.notEqual(a.task.lane, b.task.lane);
    assert.equal((await inFlight(db, P)).length, 2);
  });

  it("can be pinned to one lane", async () => {
    await add({ title: "api work", lane: "api", priority: 1 });
    await add({ title: "docs work", lane: "docs", priority: 50 });
    const got = await claim(db, { project: P, agent: "a1", lane: "docs" });
    assert.equal(got.task.title, "docs work");
  });
});

describe("concurrent claims do not collide", () => {
  it("gives ten simultaneous agents ten distinct tasks", async () => {
    for (let i = 0; i < 10; i++) await add({ title: `task ${i}`, lane: `lane-${i}` });

    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claim(db, { project: P, agent: `agent-${i}` })),
    );

    const taskIds = claims.map((c) => c?.task.id);
    assert.equal(taskIds.filter(Boolean).length, 10, "every agent got work");
    assert.equal(new Set(taskIds).size, 10, "no task was handed out twice");

    const runNumbers = claims.map((c) => c.run.run_number).sort((a, b) => a - b);
    assert.deepEqual(runNumbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("gives only one agent the task when they contend for one lane", async () => {
    await add({ title: "only", lane: "solo" });
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => claim(db, { project: P, agent: `agent-${i}` })),
    );
    assert.equal(claims.filter(Boolean).length, 1);
  });

  it("holds the lane invariant when SEVERAL tasks are queued in it", async () => {
    // The regression that matters. With one task in a lane, `skip locked` masks the bug: both
    // claimers target the same row and one loses. With several, each claimer picks a DIFFERENT
    // row, the `not exists` lane check passes in both snapshots, and without the advisory lock
    // both commit — two agents holding one lane. Confirmed against Postgres 18 before the fix.
    for (const title of ["A", "B", "C", "D"]) await add({ title, lane: "solo" });

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claim(db, { project: P, agent: `agent-${i}` })),
    );

    assert.equal(claims.filter(Boolean).length, 1, "exactly one agent may hold the lane");
    const { rows } = await db.query(
      "select count(*)::int n from task where project = $1 and lane = 'solo' and state = 'running'",
      [P],
    );
    assert.equal(rows[0].n, 1);
  });

  it("still lets different projects claim at the same time", async () => {
    // The advisory lock is scoped to the project, so it must not serialise across projects.
    const OTHER = "test-project-2";
    await db.query("delete from run where project = $1", [OTHER]);
    await db.query("delete from task where project = $1", [OTHER]);
    await db.query("delete from project where name = $1", [OTHER]);
    await addTask(db, { project: OTHER, lane: "solo", title: "other" });
    await add({ title: "mine", lane: "solo" });

    const [a, b] = await Promise.all([
      claim(db, { project: P, agent: "a" }),
      claim(db, { project: OTHER, agent: "b" }),
    ]);
    assert.ok(a && b, "both projects should claim");

    await db.query("delete from run where project = $1", [OTHER]);
    await db.query("delete from task where project = $1", [OTHER]);
    await db.query("delete from project where name = $1", [OTHER]);
  });
});

describe("leases survive a crashed agent", () => {
  it("returns the task to the queue once the lease expires", async () => {
    await add({ title: "abandoned work", lane: "core" });
    const first = await claim(db, { project: P, agent: "crasher", leaseSeconds: -1 });
    assert.ok(first);

    // No cleanup process: the next claim reaps it.
    const second = await claim(db, { project: P, agent: "rescuer" });
    assert.equal(second.task.title, "abandoned work");
    assert.equal(second.run.run_number, 2);

    const past = await history(db, P, 5);
    assert.equal(past[0].state, "abandoned");
    assert.match(past[0].summary, /lease expired/);
  });

  it("does not reap a run whose lease is still good", async () => {
    await add({ lane: "core" });
    await claim(db, { project: P, agent: "working", leaseSeconds: 3600 });
    assert.equal(await claim(db, { project: P, agent: "other" }), null);
  });

  it("heartbeat pushes the lease out", async () => {
    await add({ lane: "core" });
    const got = await claim(db, { project: P, agent: "slow", leaseSeconds: 1 });
    const extended = await heartbeat(db, got.run.id, 3600);
    assert.ok(new Date(extended).getTime() > Date.now() + 3000_00);
    assert.equal(await claim(db, { project: P, agent: "other" }), null);
  });
});

describe("finishing", () => {
  it("marks the task done and frees the lane", async () => {
    await add({ title: "one", lane: "core" });
    await add({ title: "two", lane: "core" });
    const got = await take();
    await finish(db, got.run.id, { state: "done", summary: "shipped", commitSha: "abc1234" });

    const past = await history(db, P, 1);
    assert.equal(past[0].state, "done");
    assert.equal(past[0].summary, "shipped");
    assert.equal(past[0].commit_sha, "abc1234");
    assert.equal((await take()).task.title, "two");
  });

  it("keeps a blocked task out of the queue", async () => {
    await add({ lane: "core" });
    const got = await take();
    await finish(db, got.run.id, { state: "blocked", summary: "needs a human" });
    assert.equal(await take(), null);
  });

  it("requeues a failed task so it can be retried", async () => {
    await add({ title: "flaky", lane: "core" });
    const got = await take();
    await finish(db, got.run.id, { state: "failed", summary: "transient" });
    assert.equal((await take()).task.title, "flaky");
  });

  it("refuses to finish the same run twice", async () => {
    await add({ lane: "core" });
    const got = await take();
    await finish(db, got.run.id, { state: "done" });
    await assert.rejects(() => finish(db, got.run.id, { state: "done" }), /not running/);
  });
});

describe("dependencies", () => {
  it("holds a task back until the one it depends on is done", async () => {
    const first = await add({ title: "schema", lane: "a" });
    await add({ title: "implementation", lane: "b", dependsOn: first.id });

    const got = await take();
    assert.equal(got.task.title, "schema");
    // 'implementation' is in a free lane but its dependency is unfinished.
    assert.equal(await claim(db, { project: P, agent: "a2" }), null);

    await finish(db, got.run.id, { state: "done" });
    assert.equal((await claim(db, { project: P, agent: "a2" })).task.title, "implementation");
  });
});

describe("what happened before me", () => {
  it("reports finished runs newest first, and excludes running ones", async () => {
    for (const [title, lane] of [["one", "a"], ["two", "b"], ["three", "c"]]) {
      const t = await add({ title, lane });
      const r = await claim(db, { project: P, agent: "a1" });
      assert.equal(r.task.id, t.id);
      await finish(db, r.run.id, { state: "done", summary: `did ${title}` });
    }
    await add({ title: "in progress", lane: "d" });
    await claim(db, { project: P, agent: "a2" });

    const past = await history(db, P, 10);
    assert.deepEqual(past.map((r) => r.title), ["three", "two", "one"]);
    assert.equal(past[0].run_number, 3);
  });
});

describe("multi-tenancy", () => {
  const A = "tenant-a";
  const B = "tenant-b";

  const wipe = async (name) => {
    await db.query("delete from run where project = $1", [name]);
    await db.query("delete from task where project = $1", [name]);
    await db.query("delete from project where name = $1", [name]);
  };

  beforeEach(async () => { await wipe(A); await wipe(B); });
  after(async () => { await wipe(A); await wipe(B); });

  it("registers a project with its checkout path", async () => {
    const p = await upsertProject(db, { name: A, path: "/tmp/a", description: "first" });
    assert.equal(p.path, "/tmp/a");
    assert.equal(p.description, "first");
  });

  it("updates settings without clobbering the ones not supplied", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a", description: "first" });
    const p = await upsertProject(db, { name: A, promptPath: "/tmp/a/prompt.md" });
    assert.equal(p.path, "/tmp/a", "path must survive an update that does not mention it");
    assert.equal(p.description, "first");
    assert.equal(p.prompt_path, "/tmp/a/prompt.md");
  });

  it("keeps lanes scoped per project — the same lane name runs in both", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a" });
    await upsertProject(db, { name: B, path: "/tmp/b" });
    await addTask(db, { project: A, lane: "api", title: "a-work" });
    await addTask(db, { project: B, lane: "api", title: "b-work" });

    const [ca, cb] = await Promise.all([
      claim(db, { project: A, agent: "a" }),
      claim(db, { project: B, agent: "b" }),
    ]);
    assert.ok(ca && cb, "a busy lane in one project must not block the same lane name in another");
    assert.equal(ca.task.title, "a-work");
    assert.equal(cb.task.title, "b-work");
  });

  it("numbers runs per project, not globally", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a" });
    await upsertProject(db, { name: B, path: "/tmp/b" });
    await addTask(db, { project: A, lane: "x", title: "a1" });
    await addTask(db, { project: B, lane: "x", title: "b1" });
    const ca = await claim(db, { project: A, agent: "a" });
    const cb = await claim(db, { project: B, agent: "b" });
    assert.equal(ca.run.run_number, 1);
    assert.equal(cb.run.run_number, 1, "each tenant starts at 1");
  });

  it("never shows one project another's history", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a" });
    await upsertProject(db, { name: B, path: "/tmp/b" });
    await addTask(db, { project: A, lane: "x", title: "a-secret" });
    const ca = await claim(db, { project: A, agent: "a" });
    await finish(db, ca.run.id, { state: "done", summary: "a-only" });

    assert.deepEqual(await history(db, B, 10), []);
    assert.equal((await history(db, A, 10)).length, 1);
  });

  it("reports queue depth per project in the overview", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a" });
    await upsertProject(db, { name: B, path: "/tmp/b" });
    await addTask(db, { project: A, lane: "x", title: "1" });
    await addTask(db, { project: A, lane: "y", title: "2" });
    await addTask(db, { project: B, lane: "x", title: "3" });

    const byName = Object.fromEntries((await listProjects(db)).map((p) => [p.name, p]));
    assert.equal(byName[A].queued, 2);
    assert.equal(byName[B].queued, 1);
  });

  it("hides archived projects from the default listing but keeps their work", async () => {
    await upsertProject(db, { name: A, path: "/tmp/a" });
    await addTask(db, { project: A, lane: "x", title: "still here" });
    await archiveProject(db, A);

    assert.ok(!(await listProjects(db)).some((p) => p.name === A));
    assert.ok((await listProjects(db, { includeArchived: true })).some((p) => p.name === A));
    assert.equal((await listTasks(db, A)).length, 1, "archiving must not delete queued work");

    await archiveProject(db, A, false);
    assert.ok((await listProjects(db)).some((p) => p.name === A));
  });

  it("refuses to archive a project that does not exist", async () => {
    await assert.rejects(() => archiveProject(db, "no-such-project"), /no such project/);
  });
});
