# agentq

A queue for scheduled agent runs, on local Postgres. One database, shared by every project's
agents, so they can see each other.

Built because coordinating agents through a markdown file does not work — and then hardened twice,
because "simple enough to reason about" turned out not to mean "obviously correct". Both
concurrency bugs are written up below; they are the interesting part.

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

## How a claim stays correct

One transaction does all of it:

1. `pg_advisory_xact_lock('agentq:claim', <project>)` — serialises claims **within this project**
2. reap expired leases: abandoned runs, their tasks back to `queued`
3. `select ... for update skip locked` — pick one claimable task
4. mark it `running`
5. `update project set runs_started = runs_started + 1 returning` — the run number, atomically
6. insert the `run` row with its lease

Commit or nothing. A crash mid-claim leaves no half-state.

**The advisory lock is load-bearing, and it was added after a real race.** `for update skip locked`
locks the row a transaction *picks* — not the rows its `not exists` lane check *reads*. Two
concurrent claimers in READ COMMITTED each evaluate that check against their own snapshot, neither
sees the other's uncommitted `state='running'`, and both take a *different* task in the same lane.
Verified against Postgres 18: two agents, one lane, both won.

The original test missed it because that lane had only one task — both claimers targeted the same
row and `skip locked` masked the bug. With several tasks queued in a lane it reproduces every time.
There is now a regression test with four.

The lock is scoped to the project, so different projects still claim concurrently, and it is held
for the milliseconds a claim takes — only the *claim* serialises, never the work.

## Multi-tenant

One installation, one database, many projects. Tasks, runs, run numbering and lanes are all scoped
per project — the same lane name is busy in one project and free in another, and each tenant's run
numbers start at 1.

```sh
agentq project add --name myapp --path ~/code/myapp --description "..."
agentq project                       # every project, its path, and its queue depth
agentq project archive --name myapp  # stops scheduling; queued work is kept
```

```
PROJECT              QUEUED RUN BLK  PATH
cprprep                   5   0   0  /Users/gabe/code/saas/projects/certified-payroll
demo-two                  0   0   0  /Users/gabe/code/agents
```

**A project carries its own checkout path**, and the shift `cd`s there before invoking the agent.
Queueing work into an unknown project auto-creates it, but *scheduling* one requires a path — a
trigger with no working directory fires into nowhere, and the install refuses rather than letting
you find that out at 03:23.

**Prompts live with the project** they describe, at `<path>/.agentq/prompt.md`. Resolution order is
an explicit `--prompt` override, then that file, then `prompts/<name>.md` here as a fallback.

Two optional files sit beside the prompt: `.agentq/allowed-tools` (Claude Code permission
patterns the headless run may use, one per line) and `.agentq/claude-flags` (extra `claude -p`
flags, one per line; the MailKite promotion lanes pass `--chrome` so the run gets the
claude-in-chrome extension tools, which a plain `claude -p` does not have).

Priority is ascending: `--priority 1` is claimed before `--priority 100` (the default).

## Recurring lanes, config outside the checkout, env hooks

Three additions from 2026-09-03, when the MailKite promotion/outreach lanes moved here from a
dozen launchd plists and cron entries:

- **`projects/<name>/`** — a per-project config dir under `AGENTQ_HOME` that wins over the
  checkout's `.agentq/`. Use it when the checkout cannot carry config: a public repo
  (`mailkite-submissions` runs in the public saas-startup template), a worktree that is reset every
  run (`mailkite-template-outreach`), or several projects sharing one checkout. Same files as
  `.agentq/`: `prompt.md`, `allowed-tools`, `claude-flags`, `pre-shift`, `env`, `lanes.conf`.
- **`env`** — a bash fragment the shift *sources* in the checkout after the pre-shift and before
  the claim. It exports what the run needs (a token read off the secrets volume, `GIT_AUTHOR_*`,
  `MK_AGENT`, PATH additions) and may `return 1` to stop the shift before anything is spent.
  Both hooks see `AGENTQ_PROJECT` and `AGENTQ_HOME`.
- **`bin/agentq-recurring <project> <lanes.conf>`** — called from a `pre-shift`, turns a cadence
  table (`lane | every_hours | priority | title | body`) into queued tasks when each lane is due
  and has no open task. Markers live in `state/<project>/`. This replaces the per-lane
  min-gap markers, locks and watchdogs the wrapper scripts used to carry.

`agentq-shift` also heartbeats the run every 5 minutes while Claude works and kills Claude at
`--max-runtime` (default: the lease), so a long run is neither reaped as abandoned nor allowed to
hold a lane forever. Every shift runs `--model claude-fable-5-1` unless `AGENTQ_MODEL` says otherwise.

## Running it on a schedule

```sh
agentq-schedule install cprprep --minute 23   # durable launchd trigger, hourly
agentq-schedule list
agentq-schedule remove cprprep
```

`agentq-shift <project>` is the entry point. **It claims before it spends anything.** No work means
the claim exits 3 and the shift stops — no Claude invocation, no tokens. An idle hour costs one
Postgres query and about 0.2 seconds.

The prompt lives in `prompts/<project>.md`, and the claim payload — run id, run number, task, what
ran before, who else is running — is appended to it, so the agent starts oriented and never claims
twice.

Two safety properties worth knowing:

- **No PID lock.** The lease is the lock. Two overlapping shifts cannot take the same task, and a
  shift that dies has its task reclaimed on the next claim. A plain cron wrapper needs a lock file;
  this does not.
- **The wrapper closes an abandoned run.** If the agent exits without calling `done`/`fail`/`block`,
  the shift marks it failed so the lane frees immediately instead of waiting out the lease.

Dry run without spending anything: `agentq-shift cprprep --dry-run`.

**Three optional tenant files**, all under `<path>/.agentq/`:

- `allowed-tools` — extra Claude Code permission patterns, one per line (see below).
- `claude-flags` — extra flags for the `claude -p` call, one per line. `--chrome` is the one that
  matters: without it a headless run has no Claude-in-Chrome browser tools at all.
- `pre-shift` — an executable that runs in the checkout *before* the claim, every shift. It is how a
  tenant turns its own control surface into queue rows: the `announce` project keeps a markdown table
  of things to announce, and its pre-shift turns every `queued` row into an `agentq add`. Editing the
  doc is enough to make the work run on the next shift. Non-zero exit stops the shift.

**Tool permissions.** Headless `claude -p` has nobody to answer a permission prompt, so any tool call
not already allowed by `~/.claude/settings.json` is denied. The shift always grants `agentq` itself
(`--allowedTools "Bash(agentq:*)"`) — a run that cannot call `agentq done` cannot close, its lease
expires as `failed` and the task requeues; cprprep's task 2 was claimed 25 times that way. Whatever
else a tenant's prompt needs goes in `<path>/.agentq/allowed-tools`, one Claude Code permission
pattern per line (`Bash(curl:*)`, `WebFetch`, …); blank lines and `#` comments are ignored. The
shift logs the final list as `allowed tools:` at the top of every run.

## The submission ledger (`subq`)

A second table in the same database, for a second problem: **the fleet kept submitting to the same
place twice.** Fifteen lanes each kept a markdown tracker with its own never-twice list, dedupe
meant grepping all of them, and it failed three times — the last one was the third duplicate PR to
one repo, opened because a human session had acted outside every log.

Same reasoning as the queue: a markdown claim is not a lock, and a markdown log is not an index.

```sh
subq check  --venue saashub.com --product mailkite-platform   # THE GATE
subq record --venue saashub.com --product mailkite-platform --action form --status submitted --lane directory-submissions
subq search saashub                    # free text over venue, notes, evidence, urls, lane
subq history --venue betalist.com      # every attempt at one venue, newest first
subq venues --product mailkite-server  # current state, one row per venue+product
subq list --lane wp-plugin-promo
subq stats
```

`check` exits **0 clear · 4 duplicate · 5 barred by a rule or refused by the venue · 6 held by
another lane**, echoing the send-email.sh exit-code discipline the lanes already follow. There is no
`--force`. `--url` is the submission url; the database override is `--db-url`.

Three bugs came out of the first day of real use, all of them worth knowing because they are the
kind a unit test does not think to write:

- **Every GitHub URL collapsed to `github.com`**, so the first PR claimed the key and every later
  PR to a *different* repo was refused as a duplicate. Code hosts now key as
  `github.com/<owner>/<repo>` — a repo is the venue, the host is not. `subq rekey [--apply]`
  migrates rows written before that, recomputing each key from its own url and reporting (never
  merging) collisions.
- **`--url` was both the submission url and the Postgres connection string**, so recording a PR
  made the CLI try to speak Postgres to github.com:5432.
- **`rejected` read as `clear`**, quietly inviting a resubmission to a venue that had already said
  no. It is now exit 5, and only a human `void` reopens it.

Three design points worth knowing:

- **Dedupe is per (venue, product), not per venue.** One directory can legitimately hold the
  platform, the OSS server and the WordPress plugin. It may not hold two of the same.
- **The table is append-only, and one partial unique index does the enforcing:** at most one row
  per pair with status `submitted`/`live` and `superseded_at is null`. Everything else
  (`needs-login`, `manual`, `paid`, `skip`, `held`, `rejected`) is a non-claiming outcome that may
  recur — which is what you want, because a login wall today is not a decision forever.
- **`submitted → live` is a progression, not a violation.** `record --advance` supersedes the old
  claim and inserts the new one in one transaction, so the log keeps both rows and the index keeps
  one claim. A row recorded in error is `subq void --id <n> --why …`: the claim is released, the
  history is not rewritten.

Backfilling an existing markdown tracker is `subq import --file <jsonl>`, one JSON object per line
with the same fields as `record`; duplicates are reported and skipped rather than aborting the
file, because a real backfill contains collisions and those are findings.

## Commands

```sh
agentq init                                     # create the schema
agentq add    --project P --title T [--lane L] [--body B] [--priority N] [--depends-on ID]
agentq claim  --project P --agent A [--lane L] [--lease SECS] [--json]
agentq done   --run ID [--summary S] [--commit SHA]
agentq block  --run ID --summary S              # needs a human; stays out of the queue
agentq fail   --run ID --summary S              # requeues for retry
agentq cancel --task ID                         # drop a queued or blocked task
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

## Backends

Postgres today. `createProvider(url)` picks by URL scheme, so `AGENTQ_URL` is the whole selection
mechanism — no config file, no registry. `redis://` throws with a pointer to the reasoning.

Why Postgres and not Redis or Durable Objects, with the numbers:
[`docs/queue-backend.md`](docs/queue-backend.md). Short version — this queue moves about 0.005
jobs/second and Postgres is within 8% of a broker below 1,000 jobs/minute, so throughput is not an
input to the decision. Fewest moving parts wins, and Postgres was already running.

`src/provider.mjs` documents the seven invariants a provider must hold; `test/conformance.mjs`
checks them. A second backend earns the name by passing that suite.

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


## Two bugs worth reading about

Both were found by testing, not by reading the code, and both are the kind that pass a casual
review.

**The lane invariant was not safe.** `for update skip locked` locks the row a transaction *picks* —
not the rows its `not exists` lane check *reads*. Two concurrent claimers in READ COMMITTED each
evaluate that check against their own snapshot, neither sees the other's uncommitted
`state='running'`, and both take a different task in the same lane. Reproduced against Postgres 18
with two held-open transactions.

The original test missed it because that lane held **one** task — both claimers targeted the same
row and `skip locked` masked the bug. It only appears with several tasks queued in one lane. Fixed
with a project-scoped `pg_advisory_xact_lock` taken before the pick; there is a regression test
with four tasks and eight claimers.

**Then the fix deadlocked.** `ensureProject` ran *before* the advisory lock, so one transaction
could hold a project row lock while waiting for the advisory lock another held while waiting for
that row. Postgres reported it during the conformance suite. Advisory lock first, rows after,
always.

## Status

30 tests. Used in anger for one project; the API is small and unlikely to churn, but this has not
been run at any scale and nothing here has been load-tested. The
[backend decision](docs/queue-backend.md) explains why that is fine for agent-run cadence and what
would change the answer.
