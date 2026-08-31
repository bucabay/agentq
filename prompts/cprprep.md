# CPR Prep build shift

Work in `/Users/gabe/code/saas/projects/certified-payroll`.

Your task has already been claimed for you — the details are at the bottom of this prompt. **Do not
claim again.** Do exactly that one task and stop.

## 1. Orient

Read `AGENTS.md`, then `QUESTIONS.md`, then `git log --oneline | head -5`. Read the `previousRuns`
in your claim payload — that is what the agents before you did. `WORKLOG.md` is the narrative
record, not a lock; the queue is the lock.

## 2. Answer one question, if research can settle it

Take the top `open` question in `QUESTIONS.md` that primary sources can settle — DOL, California
DIR, NYSDOL, agency contractor manuals, published format docs. Not vendor marketing, and not
memory. Two corrections have already been needed because a vendor blog was trusted over a primary
source.

If this machine cannot reach a host, route the fetch through the VPS
(`ssh racknerd-us 'curl ...'` then `scp` back) — see `docs/decisions/blocked-hosts.md`. Five runs
were once wasted recording "unreachable" against a host that was fine.

Write the answer with citations into `docs/decisions/`, mark the question answered, link the doc.
**Never guess a question marked `human`.**

## 3. Do the claimed task

Contract-first: grep for existing code and report what you found, write the JSON Schema in
`spec/schemas/` and at least one JSONL case in `spec/cases/` **before** implementing, then
implement.

Keep `core/` pure — no hono, no `cloudflare:*`, no `node:` imports; `check-arch` enforces it.

Where an authority publishes a schema, vendor it in `spec/external/` and validate against it. That
has already caught a bug our own reading of the documentation missed.

## 4. Test

Unit tests for every core function, positive and negative. A test for every API route. Golden files
for emitters. `npm run check` must be green before you commit.

## 5. Verify for real

Run the servers locally with node (`wrangler dev` on :8787; `astro dev` once a site exists) and
curl the endpoints. For any UI or document output, **render it and actually look** — Claude in
Chrome, or render a PDF to PNG and read it — then save a screenshot to `docs/screenshots/`.

A passing test suite has already shipped a PDF with columns running off the page. Stop the servers
when done.

## 6. Document

`docs/architecture/` for any new module, `docs/decisions/` for any decision, `README.md` if getting
started changed, `AGENTS.md` if the working agreement changed.

## 7. Commit, then close your run

One commit naming the milestone and what changed, with the `Co-Authored-By` and `Claude-Session`
trailers. Append a narrative entry to `WORKLOG.md` and commit that too.

Then close your run — **never leave it open**. `block` rather than `fail` when a human decision is
needed, so the next agent does not pick up the same unanswerable question.

## 8. Queue what you found but did not do

```
agentq add --project cprprep --lane <lane> --title "..." --body "enough context to start cold"
```

Choose the lane by what the work touches: same files means the same lane so work serialises,
genuinely independent work gets its own lane so it runs in parallel. Lanes in use: `api`,
`core-rules`, `emitters`, `docs`. Use `--depends-on` for contract-first ordering.

New unresolved unknowns go in `QUESTIONS.md`, marked `open` if research can settle it or `human` if
it needs Gabe.
