# agentq

A queue for scheduled agent runs, on local Postgres. Global — every project's agents share one
database, so they can see each other.

It exists because coordinating agents through a markdown file does not work. A `WORKLOG.md` claim
is not a lock: a scheduled agent fired while a previous run was still going, found its own claim
open, and had to reason its way out. A row with a lease cannot be double-claimed.

## What an agent gets

```
$ agentq claim --project cprprep --agent cron-8c51d1f7

run #7 (id 7)  lane [core-rules]
task #2: CPR-001-CLASSIFICATION

Takes WageDetermination[] exactly as CPR-005 does...

lease until 2026-08-31T14:25:16.606Z

before you:
  #6 done      CPR-005-RATE_FLOOR (a364cac)
      Q-011 answered, 171 tests green
  #5 done      WH-347 PDF emitter (63cf727)

also running now:
  #4 [api] M5: API surface (alice)
```

Its run id, its run number, what it is meant to do, **what happened before it**, and **who else is
working right now**. That is the whole point.

## The two ideas

**Lanes decide concurrency.** One running task per lane, per project. Agents on different lanes run
at the same time; agents wanting the same lane queue. Put work that touches the same files in one
lane, independent work in its own. No scheduler, no config — just a column.

**Leases survive crashes.** A run holds its task for `--lease` seconds. If the agent dies, the lease
expires, the run is marked `abandoned` and the task returns to the queue. The *next* claim does the
reaping, so nothing has to notice the crash.

Claiming uses `for update skip locked`, so ten agents claiming in the same instant take ten
different tasks rather than blocking or colliding. There is a test for exactly that.

## Commands

```sh
agentq init                                     # create the schema
agentq add    --project P --title T [--lane L] [--body B] [--priority N] [--depends-on ID]
agentq claim  --project P --agent A [--lane L] [--lease SECS] [--json]
agentq done   --run ID [--summary S] [--commit SHA]
agentq block  --run ID --summary S              # needs a human; stays out of the queue
agentq fail   --run ID --summary S              # requeues for retry
agentq heartbeat --run ID [--lease SECS]        # long job, push the lease out
agentq status --project P
agentq history --project P [--limit N]
```

`claim` exits **3** when there is no work, so a wrapper can tell "nothing to do" from "broken".
`--json` on `claim` and `status` gives a machine-readable payload.

## Task states

| State | Meaning |
|---|---|
| `queued` | claimable |
| `running` | held by a live lease |
| `done` | finished |
| `blocked` | needs a human — **stays out of the queue** |
| `cancelled` | dropped |

`fail` requeues, `block` does not. That distinction matters: a transient error should be retried, a
question for a human should not be picked up again by the next agent.

## Setup

Needs a running Postgres. Uses `postgres://127.0.0.1:5432/agents`, override with `AGENTQ_URL`.

```sh
createdb agents
npm install
npm run init
npm test          # needs a second database: createdb agents_test
```

## Dependencies between tasks

`--depends-on ID` holds a task back until that one is `done`, even if its lane is free. Use it for
the contract-first pattern: schema task, then implementation task depending on it.
