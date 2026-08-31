# AGENTS.md — using the queue

If you are a scheduled agent, this is your shift protocol. It replaces claiming work in a markdown
file, which is not a lock and has already failed once.

## Start of shift

```sh
agentq claim --project <project> --agent <your-id> --lease 3600
```

- **Exit 3 means no work.** Stop. Do not invent a task, and do not work on something a lane already
  holds — that is the collision the queue exists to prevent.
- The output gives you your **run number**, the task, **what ran before you**, and **who else is
  running now**. Read all of it before touching anything.
- Nothing else claims work. If you did not get a task from `claim`, you have no task.

## During

Long job? `agentq heartbeat --run <id> --lease 3600` before the lease runs out. An expired lease
hands your task to someone else while you are still holding files open.

## End of shift — exactly one of these

```sh
agentq done  --run <id> --summary "what you actually did" --commit <sha>
agentq fail  --run <id> --summary "why it broke"        # requeued for retry
agentq block --run <id> --summary "what a human must decide"   # NOT requeued
```

Write the summary for **the next agent**, who will read it in their `before you` list. "Fixed
things" is useless there. Name what changed and what is now different.

`block` when a human decision is needed. A blocked task stays out of the queue deliberately — if
you `fail` it instead, the next agent picks up the same unanswerable question and blocks again.

## Adding work

Anything you find but do not do becomes a task, not a note:

```sh
agentq add --project P --lane <lane> --title "..." --body "enough context to start cold"
```

**Choose the lane by what the work touches.** Same files → same lane, so the work serialises. Truly
independent → its own lane, so it runs in parallel. Getting this wrong is how two agents end up
editing the same file.

Use `--depends-on` for contract-first ordering: the schema task, then the implementation task
depending on it.
