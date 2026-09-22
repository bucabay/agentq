# @agents/workflow — Agent Workflow Language (AWL)

AWL is an *indented, state-machine workflow DSL for agent teams*. It describes multi-agent
software tasks as JSON state machines, borrowing its execution model from the Amazon States
Language and extending it with agent routing, OTel-aligned telemetry, evidence traceability,
and cost-estimation hooks.

This package ships the schema, an evidence-based reference workflow (`hardroad.default`),
and tooling that validates a workflow and renders it to diagrams.

## Description

A workflow is a JSON document:

- **States** are `task`, `choice`, `parallel`, `map`, `call`, `approval`, `pass`,
  `succeed`, and `fail`. Indentation is purely visual; meaning is structural.
- **Agents** are named roles bound to a model tier (`frontier`, `cheap`, `review`) with a
  tool allowlist (`read`, `grep`, `glob`, `git`), read-only flags, and clean-context flags.
- **Evidence** traces every design decision back to a published source and finding, so the
  workflow is auditable in the same repo that ships it.
- **Telemetry** spells out per-state GenAI metrics (OTel semantic conventions), expected
  tokens, and cost so a run can be rated (1–5) and costed from the ledger.
- **Subflows** are reusable sub-machines invoked by `parallel`/`map`/`call` states.

The default workflow (`default.workflow.json`) encodes a research-backed default pipeline:

```
explore (4 parallel cheap read-only agents)
  -> plan (frontier, writes artifacts/spec.md)
  -> route (mechanical -> sidekick / judgment -> frontier writer)   # single writer
  -> review (independent family, clean-context diff review)
  -> verify (lint && test && typecheck)
  -> quality_gate (bounded fix loop, max 2 iterations, else replan)
  -> report (cost ledger + telemetry)
```

## Architecture

```
workflow/
├── schema.json             # JSON Schema (draft 2020-12) for the AWL dialect
├── default.workflow.json   # the reference "hardroad.default" workflow + subflows
├── validate.mjs            # AJV validation of a workflow against schema.json
├── render.mjs              # renders a workflow -> Mermaid, JSON Canvas, SVG, HTML storyboard
├── visual/                 # generated artifacts (graph.mmd/.canvas/.svg/.html)
└── docs/
    └── RESEARCH.md         # research overview with links behind the design
```

### The reference workflow, state by state

| State            | Agent / kind        | Purpose                                                      |
| ---------------- | ------------------- | ------------------------------------------------------------ |
| `explore`        | parallel, explorer  | One cheap read-only agent per scope; context-isolated fan-out |
| `plan`           | planner (frontier)  | Spec-quality brief: constraints, edge cases, definition of done |
| `route`          | choice              | Route on `plan.delegability`: `mechanical` vs `judgment`     |
| `implement_sidekick` / `implement_frontier` | single writer | One writer only, never parallel writers                       |
| `review`         | reviewer (independent family) | Fresh-context diff review by a model family that didn't write the code |
| `verify`         | tool                | Deterministic gates: `lint && test && typecheck`             |
| `quality_gate`   | choice + guard      | Bounded fix loop (`maxIterations: 2`) with `replan` escape hatch |
| `replan`         | planner (frontier)  | Fix cycle exhausted -> frontier re-owns design, re-enters `route` |
| `report`         | planner (frontier)  | Final summary, per-state cost ledger, rating hook            |

Subflows: `explore_repo` (a single isolated exploration pass) and `fix_attempt`
(writer + re-verify bounded corrective pass).

### Design rules the workflow enforces

- **Reads parallelize, writes serialise.** Exploration fans out across isolated cheap
  contexts; exactly one agent ever writes, so implicit decisions never conflict.
- **Frontier intelligence goes to judgment.** Planning, ambiguity, delegability routing,
  and final review. Volume goes to the cheap sidekick.
- **Delegate by judgment, not by policy.** The router asks *"is delegation right here?"*
  rather than always delegating. When the judgment *is* the deliverable, delegation backfires.
- **Review with clean context, different family.** The reviewer sees only the diff, not the
  author's session, and comes from another model family for cross-vendor blind-spot coverage.
- **Verification is structural, never self-eval.** Lint/tests/typecheck are the gate;
  model opinion is not.
- **Loops are bounded.** Every fix iteration is counted; exhaustion routes to a frontier replan.

## Cost estimation

`render.mjs` prints a per-state USD estimate from `expectedTokens` and the per-model
`usdPerMillionInput/usdPerMillionOutput` rates. `meta.estimate` declares the budget target
($5.00 default) and whether estimates should be refit. Estimates ignore retries, loopbacks,
and cache effects.

## Usage

```sh
# validate the default workflow against schema.json
npm test

# render any workflow to visual/ (Mermaid, JSON Canvas, SVG, self-contained HTML)
npm run render
node render.mjs path/to/custom.workflow.json
```

## Research overview

The design is derived from the sources cited inline in `default.workflow.json` — a
Cognition/Anthropic/LangChain study of what actually works in multi-agent systems, plus
Co-Coder (parallelism vs. communication cost) and OpenTelemetry GenAI conventions. The
annotated overview with links lives in [docs/RESEARCH.md](docs/RESEARCH.md).