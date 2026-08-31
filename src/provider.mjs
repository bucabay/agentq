/**
 * The queue provider contract.
 *
 * There is one provider today — Postgres — and the point of writing the contract down is not
 * abstraction for its own sake. It is so that swapping the backing store later is a day's work
 * against a known surface, and so a second implementation can be proved correct by running the
 * same conformance suite rather than by reading it and hoping.
 *
 * Every method is async. A provider is a plain object, not a class; there is nothing to inherit.
 *
 *   addTask({project, lane, title, body, priority, dependsOn}) -> task
 *   claim({project, agent, lane?, leaseSeconds, host, pid})     -> {run, task} | null
 *   finish(runId, {state, summary, commitSha})                  -> run
 *   heartbeat(runId, leaseSeconds)                              -> new lease expiry
 *   history(project, limit)                                     -> finished runs, newest first
 *   inFlight(project)                                           -> live runs, with silence in seconds
 *   listTasks(project, states)                                  -> tasks
 *   migrate()                                                   -> idempotent schema setup
 *   close()                                                     -> release resources
 *
 *   upsertProject({name, path, promptPath, description})        -> project
 *   getProject(name)                                            -> project | null
 *   listProjects({includeArchived})                             -> projects with queue depth
 *   archiveProject(name, archived)                              -> project
 *
 * MULTI-TENANCY. Tasks, runs and run numbering are all scoped by project, so several projects
 * share one queue without seeing each other's work. A project carries the absolute `path` of its
 * checkout: queueing work into an unknown project auto-creates it, but SCHEDULING one requires a
 * path, because a trigger without a working directory fires into nowhere.
 *
 * INVARIANTS a provider must hold. The conformance suite checks all of them:
 *
 *   1. A task is handed to at most one live run. Ever.
 *   2. One running task per (project, lane). Different lanes proceed in parallel.
 *   3. Run numbers are monotonic and gapless within a project.
 *   4. A run whose lease expires is reaped: marked abandoned, its task returned to `queued`.
 *   5. `finish` is idempotent-safe — finishing an already-finished run throws rather than
 *      corrupting state.
 *   6. `fail` requeues the task; `block` does not.
 *   7. A task with an unfinished `dependsOn` is not claimable even when its lane is free.
 *
 * Invariant 2 is the one that is easy to get subtly wrong. See the advisory lock in the Postgres
 * provider and the regression test that goes with it.
 */

export const PROVIDER_METHODS = [
  "addTask", "claim", "finish", "heartbeat", "history", "inFlight", "listTasks", "migrate", "close",
  "upsertProject", "getProject", "listProjects", "archiveProject",
];

/** Throws unless `provider` implements the whole contract. Cheap guard at construction time. */
export function assertProvider(provider, name = "provider") {
  const missing = PROVIDER_METHODS.filter((m) => typeof provider?.[m] !== "function");
  if (missing.length) {
    throw new Error(`${name} does not implement the queue contract: missing ${missing.join(", ")}`);
  }
  return provider;
}
