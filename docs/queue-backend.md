# Decision — what backs the queue

**Date:** 2026-08-31 · **Status:** decided · **Chosen:** Postgres. Redis and Durable Objects
evaluated and declined for now.

## Start with the scale, because it settles most of the argument

This queue holds **agent runs**. An hourly cron, a handful of parallel agents, work items measured
in minutes. Realistic peak: tens of tasks an hour, a few hundred a day.

Published numbers for Postgres `SKIP LOCKED` queues:

- Below **~1,000 jobs/minute**, Postgres is within **8%** of a dedicated broker on throughput —
  ["you don't need a job queue"](https://www.prisma.io/blog/you-dont-need-a-job-queue-postgres-already-has-skip-locked)
- The first real bottleneck appears around **~8,000 workflows/second** (CPU, index and autovacuum
  pressure) — [DBOS, making Postgres queues scale](https://www.dbos.dev/blog/making-postgres-queues-scale)
- People have pushed it to [10,000 jobs/second](https://gist.github.com/chanks/7585810)

We need roughly **0.005 jobs/second**. That is six orders of magnitude of headroom. **Throughput is
not a real input to this decision**, so any argument that picks a backend on speed is answering a
question we do not have.

What is left is: fewest moving parts, easiest to reason about.

## The options

### Postgres — chosen

Already installed, already running, already holds the data. One table with a lease column, drained
with `SELECT ... FOR UPDATE SKIP LOCKED`. **Zero new processes.**

- ACID and WAL durability. A committed claim survives a power cut.
- Advisory locks give the lane invariant, and one transaction gives atomicity end to end.
- `psql` is the debugger. You can see the whole queue with a `select`.
- Real cost: every claim, heartbeat and completion is a row update, so at sustained thousands per
  second **dead tuples and autovacuum become the operational problem** — under xmin blocking,
  benchmarks show dead tuples growing 14×, table size 15×, and dequeue throughput dropping ~35%.
  Irrelevant at our volume; the reason to know it is so we recognise the symptom if the shape of
  the workload ever changes.

### Redis — declined

Streams with consumer groups are a genuinely good queue. The Pending Entries List gives
at-least-once delivery, and `XAUTOCLAIM` (or `XREADGROUP ... CLAIM` in Redis 8.4) reclaims work
from dead consumers — the same job our lease does.

Declined because:

- **It is a whole new process to run, supervise and back up**, for throughput we will never use.
- **Durability is secondary by design.** RDB snapshots and AOF are good, but Postgres's WAL is the
  stronger guarantee and we already pay for it.
- **More concepts, not fewer.** Streams, consumer groups, PEL, idle time, `XACK`, `XAUTOCLAIM`
  trimming and `MAXLEN` — against one table with a `lease_expires_at` column. The brief was fewest
  moving parts.
- We would still want Postgres for run history and reporting, so Redis is *additive*, not a swap.

**What would change the answer:** thousands of tasks per second, or wanting fan-out/replay across
many independent consumers. Neither is on the horizon.

### Cloudflare Durable Objects — declined, but the most interesting option

A DO is **single-threaded**, so the lane invariant becomes free — no advisory lock, no `SKIP
LOCKED`, no race of the kind that bit us, because two requests to one object cannot interleave at
all. Alarms give scheduling in the same primitive. That is genuinely elegant.

Declined because:

- **The agents run on a laptop.** Putting the queue behind a network hop means a claim can fail
  because Wi-Fi did, and local development needs `wrangler`/`miniflare` running to do anything.
  That is a large regression in "easy to reason about".
- **Cloudflare's own docs say a single DO is not scalable** — one thread, fixed requests per
  second. The property that makes it elegant here is also its ceiling.
- Debugging is a `wrangler tail`, not a `select`.
- It couples a local dev tool to a cloud account.

**What would change the answer:** agents running *in* Cloudflare rather than on a workstation. Then
a DO is probably the right call, and the provider interface is how we would get there.

## The specific asks

**"Atomic write to an entry."** Yes. One transaction: advisory lock on the project, reap expired
leases, `SELECT ... FOR UPDATE SKIP LOCKED` one task, mark it running, bump the run counter, insert
the run row. Commit or nothing.

**"If it's taken we have to wait."** Two behaviours, because they suit different callers. Default:
`claim` returns nothing and exits **3** — right for a cron agent, which should give the slot back
and let the next tick try. Optional: `--wait SECS` polls with jitter until the deadline.

Deliberately **polling, not `LISTEN`/`NOTIFY`**. NOTIFY needs a dedicated connection per waiter,
breaks behind a transaction-mode pooler, drops notifications while a listener reconnects, and every
committing NOTIFY takes a global lock. The recommended pattern therefore keeps polling as a
fallback anyway — so at our cadence the fallback *is* the design, and it is a loop you can read in
one sitting.

**"Last ping so unresponsive locks can be reclaimed."** `run.last_heartbeat_at`, updated by
`heartbeat`. `lease_expires_at` already decided *whether* a run was stale; the ping tells you *how
long it has been silent*, which is what you want when judging whether something is wedged.
`inFlight` and `status` report `silent_seconds`, and the reaper writes the silence into the
abandoned run's summary.

Reaping is **claim-driven** — the next claim does it, so no sweeper process exists. Fine at cron
cadence; wrong if we ever need sub-second recovery.

## The provider interface

`src/provider.mjs` documents seven invariants; `test/conformance.mjs` checks them against any
implementation. `createProvider(url)` picks by URL scheme — `postgres://` works, `redis://` throws
pointing here. **No config file, no registry**: the URL you already supply is the selection
mechanism.

The interface is not speculative abstraction. It exists so a second backend has to *prove* itself
against the same suite rather than be eyeballed, and so this decision is reversible in a day.
