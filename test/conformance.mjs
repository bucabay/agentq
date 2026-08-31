import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROVIDER_METHODS } from "../src/provider.mjs";

/**
 * The provider conformance suite. Backend-agnostic on purpose: a second implementation earns the
 * right to be called a provider by passing this, not by looking similar to the first one.
 *
 * Usage:  runConformance("postgres", () => createProvider(url))
 */
export function runConformance(name, makeProvider) {
  describe(`${name} — queue provider contract`, () => {
    const P = `conformance-${name}`;

    const fresh = async () => {
      const q = makeProvider();
      await q.migrate();
      // Providers may expose raw access for test cleanup; otherwise the suite assumes a clean slate.
      if (q.raw) {
        await q.raw("delete from run where project = $1", [P]);
        await q.raw("delete from task where project = $1", [P]);
        await q.raw("delete from project where name = $1", [P]);
      }
      return q;
    };

    it("implements every contract method", async () => {
      const q = await fresh();
      for (const m of PROVIDER_METHODS) assert.equal(typeof q[m], "function", `missing ${m}`);
      await q.close();
    });

    it("1. hands a task to at most one live run", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "solo", title: "A" });
      await q.addTask({ project: P, lane: "solo", title: "B" });
      const claims = await Promise.all(
        Array.from({ length: 6 }, (_, i) => q.claim({ project: P, agent: `a${i}` })),
      );
      assert.equal(claims.filter(Boolean).length, 1);
      await q.close();
    });

    it("2. runs different lanes in parallel", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "x", title: "X" });
      await q.addTask({ project: P, lane: "y", title: "Y" });
      const [a, b] = await Promise.all([
        q.claim({ project: P, agent: "a" }),
        q.claim({ project: P, agent: "b" }),
      ]);
      assert.ok(a && b);
      assert.notEqual(a.task.lane, b.task.lane);
      await q.close();
    });

    it("3. numbers runs monotonically and without gaps", async () => {
      const q = await fresh();
      for (let i = 0; i < 4; i++) await q.addTask({ project: P, lane: `l${i}`, title: `t${i}` });
      const claims = await Promise.all(
        Array.from({ length: 4 }, (_, i) => q.claim({ project: P, agent: `a${i}` })),
      );
      const numbers = claims.map((c) => c.run.run_number).sort((a, b) => a - b);
      assert.deepEqual(numbers, [1, 2, 3, 4]);
      await q.close();
    });

    it("4. reaps a run whose lease expired and requeues its task", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "solo", title: "orphan" });
      await q.claim({ project: P, agent: "crasher", leaseSeconds: -1 });
      const rescued = await q.claim({ project: P, agent: "rescuer" });
      assert.equal(rescued.task.title, "orphan");
      const past = await q.history(P, 5);
      assert.equal(past[0].state, "abandoned");
      await q.close();
    });

    it("5. refuses to finish the same run twice", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "solo", title: "once" });
      const got = await q.claim({ project: P, agent: "a" });
      await q.finish(got.run.id, { state: "done" });
      await assert.rejects(() => q.finish(got.run.id, { state: "done" }));
      await q.close();
    });

    it("6. fail requeues, block does not", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "solo", title: "flaky" });
      let got = await q.claim({ project: P, agent: "a" });
      await q.finish(got.run.id, { state: "failed", summary: "transient" });
      got = await q.claim({ project: P, agent: "a" });
      assert.equal(got.task.title, "flaky", "failed task should be retryable");

      await q.finish(got.run.id, { state: "blocked", summary: "needs a human" });
      assert.equal(await q.claim({ project: P, agent: "a" }), null, "blocked task must stay out");
      await q.close();
    });

    it("7. holds a task back while its dependency is unfinished", async () => {
      const q = await fresh();
      const first = await q.addTask({ project: P, lane: "a", title: "schema" });
      await q.addTask({ project: P, lane: "b", title: "impl", dependsOn: first.id });
      const got = await q.claim({ project: P, agent: "a" });
      assert.equal(got.task.title, "schema");
      assert.equal(await q.claim({ project: P, agent: "b" }), null);
      await q.finish(got.run.id, { state: "done" });
      assert.equal((await q.claim({ project: P, agent: "b" })).task.title, "impl");
      await q.close();
    });

    it("reports how long a live run has been silent", async () => {
      const q = await fresh();
      await q.addTask({ project: P, lane: "solo", title: "chatty" });
      const got = await q.claim({ project: P, agent: "a" });
      const [live] = await q.inFlight(P);
      assert.equal(typeof live.silent_seconds, "number");
      assert.ok(live.silent_seconds >= 0);
      await q.heartbeat(got.run.id, 3600);
      await q.close();
    });
  });
}
