# AWL Research Overview

Where the `hardroad.default` workflow design comes from, and what each source actually
contributes. Every evidence block inside `default.workflow.json` cites one of these.

## Working consensus: multi-agent systems today

The through-line across the field is: **reads parallelize cleanly; writes must stay
single-threaded.** Extra agents are worth adding for intelligence (research, review,
planning) far more than for parallel actions.

| Source | Link | Contribution |
| --- | --- | --- |
| Cognition — *Multi-Agents: What's Actually Working* | https://cognition.com/blog/multi-agents-working | The core principle: "multi-agent systems work best today when writes stay single-threaded and the additional agents contribute intelligence rather than actions." A clean-context reviewer catches bugs the coder can't see; Devin Review finds ~2 bugs per PR, ~58% severe. |
| Cognition — *Don't Build Multi-Agents* (the earlier position) | https://cognition.com/blog/dont-build-multi-agents | Why parallel writers fail: "actions carry implicit decisions, and conflicting decisions carry bad results." Parallel agents fragment context and make conflicting implicit choices. |
| LangChain — *How and when to build multi-agent systems* | https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems | Read vs. write parallelization trade-off made explicit: read-style agents parallelize, write-style agents face the context-transfer + merge cost. |
| Co-Coder — *When Parallelism Pays Off: Cohesion-Aware Task Partitioning for Multi-Agent Coding* (arXiv) | https://arxiv.org/abs/2606.00953 | The communication-to-computation trade-off, formalized as graph partitioning: task decomposition shortens critical path but cross-agent dependencies cost context transfer. Up to 2.10x speedup, 35% lower API cost on the most dependency-dense repos. |

## Why a plan-first, delegation-aware pipeline works

Frontier tokens are wasted on mechanical volume; they belong on the plan, ambiguity, and
final judgment.

| Source | Link | Contribution |
| --- | --- | --- |
| Cognition — *Devin Fusion: Frontier Performance at 60% Lower Cost* | https://cognition.com/blog/devin-fusion | The sidekick pattern: a frontier "main agent" owns the plan, ambiguity interpretation, and final review; a cheap sidekick runs in parallel with its own cached context. ~35–60% cost cut at frontier-level quality. |
| Cognition — *Making Fable Cheaper Than Opus* | https://cognition.com/blog/making-fable-cheaper-than-opus | The quality lever is the brief, not the model: constraint-rich, outcome-specifying handoffs (Fable) beat dictated file contents (Opus). Delegability is itself a judgment call — forcing delegation just delegates the wrong things. |
| VS Code — *Set up a context engineering flow* | https://code.visualstudio.com/docs/agents/guides/context-engineering-guide | An implementation plan is a first-class artifact you can read, diff, and gate before any side effect fires; separate planning from implementation agents. |
| Anthropic — *How Anthropic teams use Claude Code* | https://www.anthropic.com/news/how-anthropic-teams-use-claude-code | Context engineering and auto-verify loops as team practice (write -> run tests -> self-fix); "separate generation from evaluation." |

## Why an independent clean-context reviewer

The author is the worst reviewer of their own diff, and shared context degrades judgement.

| Source | Link | Contribution |
| --- | --- | --- |
| Cognition — *Multi-Agents: What's Actually Working* | https://cognition.com/blog/multi-agents-working | A clean-context reviewer with none of the author's context catches bugs the author cannot see; shorter context = more intelligence concentrated on the diff. |
| Anthropic — *How we built our multi-agent research system* | https://www.anthropic.com/engineering/multi-agent-research-system | Orchestrator-worker with separate context windows; token usage explains ~80% of eval performance variance. Subagent isolation as a compression mechanism. |
| Multi-vendor review (internal "fusion-conductor" note) | n/a | Main and reviewer from different model families means every diff gets an independent second-family read — cross-vendor blind-spot coverage. |

## Why deterministic verification gates

Never trust model self-evaluation; make quality gates structural.

| Source | Link | Contribution |
| --- | --- | --- |
| Anthropic — evaluator-optimizer workflow | https://www.anthropic.com/engineering/building-effective-agents | Evaluator-optimizer pattern: generate + evaluate in a loop; the loop must be bounded or it drifts. Each agent's output passes tests before merge eligibility. |
| Anthropic — *Effective context engineering for AI agents* | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | Clean context windows and isolated sub-agent exploration; issues distilled summaries to the lead instead of raw tool spew. |
| "Verdent/retry evidence" (internal empirical note) | n/a | Bounded multi-attempt retry lifts pass rate (~81% pass@3 vs single-attempt baseline) — but only when the loop is capped. |

## The execution model and telemetry substrate

| Source | Link | Contribution |
| --- | --- | --- |
| Amazon States Language (ASL) | https://states-language.net/ | The state-machine semantics AWL inherits: Task/Choice/Parallel/Map/Pass/Succeed/Fail, `Next`/`Default` transitions, bounded retry, sub-machine `Branches`. |
| OpenTelemetry GenAI semantic conventions | https://github.com/open-telemetry/semantic-conventions-genai | The telemetry vocabulary (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.usage.*`, `gen_ai.request.model`) used in per-state metrics and the cost ledger. |
| Anthropic — *Building effective agents* | https://www.anthropic.com/engineering/building-effective-agents | Workflow vs. agent distinction and the five workflow patterns (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer) that AWL's choice/parallel/guard states encode. |