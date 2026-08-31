import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, "..", "..", "sql");

export const DEFAULT_URL =
  process.env.AGENTQ_URL ?? "postgres://127.0.0.1:5432/agents";

export function pool(url = DEFAULT_URL) {
  return new pg.Pool({ connectionString: url, max: 4 });
}

const MIGRATIONS = ["001_init.sql", "002_heartbeat.sql", "003_project_path.sql"];

export async function migrate(db) {
  for (const file of MIGRATIONS) {
    await db.query(readFileSync(join(sqlDir, file), "utf8"));
  }
}

/** Runs fn inside a transaction, rolling back on any throw. */
export async function tx(db, fn) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureProject(client, project) {
  await client.query(
    "insert into project (name) values ($1) on conflict (name) do nothing",
    [project],
  );
}

/**
 * Returns tasks whose holder's lease has expired to the queue and marks those runs abandoned.
 * Called at the start of every claim, so a crashed agent needs nobody to notice it.
 */
export async function reapExpired(client) {
  const { rows } = await client.query(`
    with dead as (
      update run set state = 'abandoned', finished_at = now(),
             summary = coalesce(
               summary,
               'lease expired; last ping ' ||
                 round(extract(epoch from (now() - last_heartbeat_at)))::text || 's before reaping')
       where state = 'running' and lease_expires_at < now()
      returning task_id, project, run_number
    )
    update task set state = 'queued', updated_at = now()
     where id in (select task_id from dead where task_id is not null)
       and state = 'running'
    returning id
  `);
  return rows.map((r) => r.id);
}

/**
 * Claims the next runnable task and opens a run for it.
 *
 * Claimability is three conditions: the task is queued, its dependency (if any) is done, and NO
 * OTHER TASK IN ITS LANE IS RUNNING. That last one is what makes separate lanes parallel and the
 * same lane serial, with no scheduler and no locks held between calls.
 *
 * `for update skip locked` means two agents claiming at the same instant take different tasks
 * rather than one blocking or both taking the same one.
 */
export async function claim(db, { project, agent, lane = null, leaseSeconds = 3600, host, pid }) {
  return tx(db, async (client) => {
    // Take the advisory lock FIRST, before any row is touched. Lock ordering matters: with
    // ensureProject ahead of it, one transaction could hold a project row lock while waiting for
    // the advisory lock that another holds while waiting for that row — a genuine deadlock, which
    // Postgres duly reported during testing. Advisory lock first, rows after, always.
    //
    // Serialise claims within this project for the duration of the transaction.
    //
    // Without it the lane invariant is not safe. `for update skip locked` locks the row a
    // transaction PICKS, not the rows its `not exists` lane check READS. Two concurrent claimers
    // in READ COMMITTED each evaluate that check against their own snapshot, neither sees the
    // other's uncommitted `state='running'`, and both take a different task in the same lane.
    // Verified against Postgres 18 before this line existed: two agents, one lane, both won.
    //
    // A project-scoped advisory lock is the cheap correct fix. Claims take milliseconds, and it is
    // only the CLAIM that serialises — the work itself still runs in parallel across lanes, which
    // is the whole point. Different projects claim concurrently.
    await client.query("select pg_advisory_xact_lock(hashtext('agentq:claim'), hashtext($1))", [project]);
    await ensureProject(client, project);
    await reapExpired(client);

    const { rows: picked } = await client.query(
      `
      select t.* from task t
       where t.project = $1
         and t.state = 'queued'
         and ($2::text is null or t.lane = $2)
         and (t.depends_on is null
              or exists (select 1 from task d where d.id = t.depends_on and d.state = 'done'))
         and not exists (
           select 1 from task busy
            where busy.project = t.project and busy.lane = t.lane and busy.state = 'running')
       order by t.priority, t.id
       limit 1
       for update of t skip locked
      `,
      [project, lane],
    );

    const task = picked[0];
    if (!task) return null;

    await client.query("update task set state = 'running', updated_at = now() where id = $1", [task.id]);

    const { rows: numbered } = await client.query(
      "update project set runs_started = runs_started + 1 where name = $1 returning runs_started",
      [project],
    );
    const runNumber = numbered[0].runs_started;

    const { rows: runRows } = await client.query(
      `insert into run (project, run_number, task_id, agent, host, pid, lease_expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
       returning *`,
      [project, runNumber, task.id, agent, host ?? null, pid ?? null, leaseSeconds],
    );

    return { run: runRows[0], task };
  });
}

/** The last `limit` finished runs, newest first — an agent's "what happened before me". */
export async function history(db, project, limit = 5) {
  const { rows } = await db.query(
    `select r.run_number, r.agent, r.state, r.summary, r.commit_sha,
            r.started_at, r.finished_at, t.title, t.lane
       from run r left join task t on t.id = r.task_id
      where r.project = $1 and r.state <> 'running'
      order by r.run_number desc
      limit $2`,
    [project, limit],
  );
  return rows;
}

/** Runs currently holding a lease — who else is working right now, and in which lane. */
export async function inFlight(db, project) {
  const { rows } = await db.query(
    `select r.run_number, r.agent, r.started_at, r.lease_expires_at, r.last_heartbeat_at,
            round(extract(epoch from (now() - r.last_heartbeat_at)))::int as silent_seconds,
            t.title, t.lane
       from run r join task t on t.id = r.task_id
      where r.project = $1 and r.state = 'running'
      order by r.run_number`,
    [project],
  );
  return rows;
}

export async function finish(db, runId, { state, summary, commitSha }) {
  return tx(db, async (client) => {
    const { rows } = await client.query(
      `update run set state = $2, summary = $3, commit_sha = $4, finished_at = now()
        where id = $1 and state = 'running'
        returning *`,
      [runId, state, summary ?? null, commitSha ?? null],
    );
    const run = rows[0];
    if (!run) throw new Error(`run ${runId} is not running (already finished, or no such run)`);

    const taskState = state === "done" ? "done" : state === "blocked" ? "blocked" : "queued";
    if (run.task_id) {
      await client.query("update task set state = $2, updated_at = now() where id = $1", [
        run.task_id,
        taskState,
      ]);
    }
    return run;
  });
}

export async function heartbeat(db, runId, leaseSeconds = 3600) {
  const { rows } = await db.query(
    `update run set lease_expires_at = now() + make_interval(secs => $2),
                    last_heartbeat_at = now()
      where id = $1 and state = 'running' returning lease_expires_at, last_heartbeat_at`,
    [runId, leaseSeconds],
  );
  if (!rows[0]) throw new Error(`run ${runId} is not running`);
  return rows[0].lease_expires_at;
}

export async function addTask(db, { project, lane = "default", title, body, priority = 100, dependsOn }) {
  return tx(db, async (client) => {
    await ensureProject(client, project);
    const { rows } = await client.query(
      `insert into task (project, lane, title, body, priority, depends_on)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [project, lane, title, body ?? null, priority, dependsOn ?? null],
    );
    return rows[0];
  });
}

export async function listTasks(db, project, states = ["queued", "running", "blocked"]) {
  const { rows } = await db.query(
    `select * from task where project = $1 and state = any($2) order by state, priority, id`,
    [project, states],
  );
  return rows;
}

/**
 * The provider object. The functions above stay exported for direct use and for the tests that
 * predate the contract; this is the shape `createProvider` returns.
 */
export function createPostgresProvider(url = DEFAULT_URL) {
  const db = pool(url);
  return {
    kind: "postgres",
    url,
    migrate: () => migrate(db),
    addTask: (opts) => addTask(db, opts),
    claim: (opts) => claim(db, opts),
    finish: (runId, opts) => finish(db, runId, opts),
    heartbeat: (runId, leaseSeconds) => heartbeat(db, runId, leaseSeconds),
    history: (project, limit) => history(db, project, limit),
    inFlight: (project) => inFlight(db, project),
    listTasks: (project, states) => listTasks(db, project, states),
    upsertProject: (opts) => upsertProject(db, opts),
    getProject: (name) => getProject(db, name),
    listProjects: (opts) => listProjects(db, opts),
    archiveProject: (name, archived) => archiveProject(db, name, archived),
    close: () => db.end(),
    /** Escape hatch for the CLI's few raw queries. Providers are not required to expose this. */
    raw: (text, params) => db.query(text, params),
  };
}

// ---------------------------------------------------------------- projects

/**
 * Registers a project or updates its settings. Separate from the implicit `ensureProject` that
 * `addTask` does: queueing work into a new project should just work, but SCHEDULING one requires
 * somebody to say where the checkout is. The two paths have different bars deliberately.
 */
export async function upsertProject(db, { name, path, promptPath, description }) {
  const { rows } = await db.query(
    `insert into project (name, path, prompt_path, description)
     values ($1, $2, $3, $4)
     on conflict (name) do update set
       path        = coalesce(excluded.path, project.path),
       prompt_path = coalesce(excluded.prompt_path, project.prompt_path),
       description = coalesce(excluded.description, project.description)
     returning *`,
    [name, path ?? null, promptPath ?? null, description ?? null],
  );
  return rows[0];
}

export async function getProject(db, name) {
  const { rows } = await db.query("select * from project where name = $1", [name]);
  return rows[0] ?? null;
}

/** Every project with its queue depth and live-run count — the multi-tenant overview. */
export async function listProjects(db, { includeArchived = false } = {}) {
  const { rows } = await db.query(
    `select p.*,
            (select count(*) from task t
              where t.project = p.name and t.state = 'queued')::int  as queued,
            (select count(*) from task t
              where t.project = p.name and t.state = 'running')::int as running,
            (select count(*) from task t
              where t.project = p.name and t.state = 'blocked')::int as blocked
       from project p
      where ($1 or p.archived_at is null)
      order by p.name`,
    [includeArchived],
  );
  return rows;
}

export async function archiveProject(db, name, archived = true) {
  const { rows } = await db.query(
    "update project set archived_at = case when $2 then now() else null end where name = $1 returning *",
    [name, archived],
  );
  if (!rows[0]) throw new Error(`no such project "${name}"`);
  return rows[0];
}
