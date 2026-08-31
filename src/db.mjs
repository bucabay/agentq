import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_URL =
  process.env.AGENTQ_URL ?? "postgres://127.0.0.1:5432/agents";

export function pool(url = DEFAULT_URL) {
  return new pg.Pool({ connectionString: url, max: 4 });
}

export async function migrate(db) {
  await db.query(readFileSync(join(here, "..", "sql", "001_init.sql"), "utf8"));
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
             summary = coalesce(summary, 'lease expired; agent did not report back')
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
    `select r.run_number, r.agent, r.started_at, r.lease_expires_at, t.title, t.lane
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
    `update run set lease_expires_at = now() + make_interval(secs => $2)
      where id = $1 and state = 'running' returning lease_expires_at`,
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
