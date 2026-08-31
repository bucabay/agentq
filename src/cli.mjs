#!/usr/bin/env node
import { hostname } from "node:os";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  DEFAULT_URL, addTask, archiveProject, claim, finish, getProject, heartbeat, history, inFlight,
  listProjects, listTasks, migrate, pool, upsertProject,
} from "./providers/postgres.mjs";

const [, , command, ...rest] = process.argv;

const args = (() => {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
})();

const need = (key) => {
  const value = args[key];
  if (value === undefined) die(`missing --${key}`);
  return value;
};

function die(message) {
  console.error(`agentq: ${message}`);
  process.exit(1);
}

const db = pool(args.url ?? DEFAULT_URL);
const asJson = args.json === true;

try {
  await run();
} catch (err) {
  die(err.message);
} finally {
  await db.end();
}

async function run() {
  switch (command) {
    case "init": {
      await migrate(db);
      console.log(`agentq: schema ready at ${args.url ?? DEFAULT_URL}`);
      break;
    }

    /**
     * Project registration. Separate from queueing work: `add` auto-creates a project so throwing
     * a task at a new name just works, but a project cannot be SCHEDULED until someone says where
     * its checkout is.
     */
    case "project": {
      const sub = rest[0];

      if (sub === "add" || sub === "set") {
        const name = need("name");
        const path = args.path === true ? undefined : args.path;
        if (path && !existsSync(resolve(path))) die(`path does not exist: ${resolve(path)}`);
        const project = await upsertProject(db, {
          name,
          path: path ? resolve(path) : undefined,
          promptPath: args.prompt === true ? undefined : args.prompt,
          description: args.description === true ? undefined : args.description,
        });
        if (asJson) console.log(JSON.stringify(project, null, 2));
        else console.log(`${project.name}\n  path:   ${project.path ?? "(not set — cannot be scheduled)"}\n  prompt: ${project.prompt_path ?? "(auto)"}`);
        break;
      }

      if (sub === "show") {
        const project = await getProject(db, need("name"));
        if (!project) die(`no such project "${args.name}"`);
        console.log(asJson ? JSON.stringify(project, null, 2) : Object.entries(project).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
        break;
      }

      if (sub === "archive" || sub === "unarchive") {
        const project = await archiveProject(db, need("name"), sub === "archive");
        console.log(`${project.name} ${sub}d`);
        break;
      }

      // Default: list. The multi-tenant overview — every project, its path, and its queue depth.
      const projects = await listProjects(db, { includeArchived: args.all === true });
      if (asJson) { console.log(JSON.stringify(projects, null, 2)); break; }
      if (!projects.length) { console.log("no projects yet"); break; }
      console.log("PROJECT              QUEUED RUN BLK  PATH");
      for (const p of projects) {
        const flag = p.archived_at ? " (archived)" : p.path ? "" : "  ** no path — cannot be scheduled **";
        console.log(
          `${p.name.padEnd(20)} ${String(p.queued).padStart(6)} ${String(p.running).padStart(3)} ${String(p.blocked).padStart(3)}  ${p.path ?? "-"}${flag}`,
        );
      }
      break;
    }

    case "add": {
      const task = await addTask(db, {
        project: need("project"),
        lane: args.lane ?? "default",
        title: need("title"),
        body: args.body === true ? undefined : args.body,
        priority: args.priority ? Number(args.priority) : 100,
        dependsOn: args["depends-on"] ? Number(args["depends-on"]) : undefined,
      });
      if (asJson) console.log(JSON.stringify(task, null, 2));
      else console.log(`#${task.id}  [${task.lane}]  ${task.title}`);
      break;
    }

    /**
     * The command an agent runs at the start of a shift. It returns everything the agent needs to
     * orient: which run it is, what it is meant to do, what happened before it, and who else is
     * working right now. Exits 3 with no work so a wrapper can tell "nothing to do" from "error".
     */
    case "claim": {
      const project = need("project");
      const opts = {
        project,
        agent: need("agent"),
        lane: args.lane === true ? null : args.lane ?? null,
        leaseSeconds: args.lease ? Number(args.lease) : 3600,
        host: hostname(),
        pid: process.pid,
      };

      // --wait polls instead of returning empty. Deliberately polling, not LISTEN/NOTIFY:
      // NOTIFY needs a dedicated connection per waiter, breaks behind a transaction-mode pooler,
      // and drops notifications while a listener is reconnecting — so the reliable pattern needs
      // polling as a fallback anyway. At agent cadence one query every few seconds is free, and a
      // poll loop is a thing you can read in one sitting.
      const waitSeconds = args.wait ? Number(args.wait) : 0;
      const deadline = Date.now() + waitSeconds * 1000;
      let claimed = await claim(db, opts);
      while (!claimed && Date.now() < deadline) {
        // Jitter so a fleet restarting together does not stampede the database in lockstep.
        const pause = 2000 + Math.floor(Math.random() * 2000);
        await new Promise((r) => setTimeout(r, Math.min(pause, Math.max(0, deadline - Date.now()))));
        claimed = await claim(db, opts);
      }

      if (!claimed) {
        const busy = await inFlight(db, project);
        const payload = { claimed: false, reason: busy.length ? "all lanes busy or nothing queued" : "nothing queued", inFlight: busy };
        if (asJson) console.log(JSON.stringify(payload, null, 2));
        else {
          console.log("no task available.");
          for (const r of busy) console.log(`  running: #${r.run_number} [${r.lane}] ${r.title} (${r.agent})`);
        }
        process.exit(3);
      }

      const payload = {
        claimed: true,
        runId: claimed.run.id,
        runNumber: claimed.run.run_number,
        project,
        agent: claimed.run.agent,
        leaseExpiresAt: claimed.run.lease_expires_at,
        task: {
          id: claimed.task.id, lane: claimed.task.lane,
          title: claimed.task.title, body: claimed.task.body,
        },
        previousRuns: await history(db, project, args.history ? Number(args.history) : 5),
        alsoRunning: (await inFlight(db, project)).filter((r) => r.run_number !== claimed.run.run_number),
      };

      if (asJson) console.log(JSON.stringify(payload, null, 2));
      else {
        console.log(`run #${payload.runNumber} (id ${payload.runId})  lane [${payload.task.lane}]`);
        console.log(`task #${payload.task.id}: ${payload.task.title}`);
        if (payload.task.body) console.log(`\n${payload.task.body}\n`);
        console.log(`lease until ${new Date(payload.leaseExpiresAt).toISOString()}`);
        if (payload.previousRuns.length) {
          console.log("\nbefore you:");
          for (const r of payload.previousRuns) {
            console.log(`  #${r.run_number} ${r.state.padEnd(9)} ${r.title ?? "-"}${r.commit_sha ? ` (${r.commit_sha})` : ""}`);
            if (r.summary) console.log(`      ${r.summary}`);
          }
        }
        if (payload.alsoRunning.length) {
          console.log("\nalso running now:");
          for (const r of payload.alsoRunning) console.log(`  #${r.run_number} [${r.lane}] ${r.title} (${r.agent})`);
        }
      }
      break;
    }

    case "done":
    case "fail":
    case "block": {
      const state = command === "done" ? "done" : command === "block" ? "blocked" : "failed";
      const run = await finish(db, Number(need("run")), {
        state,
        summary: args.summary === true ? undefined : args.summary,
        commitSha: args.commit === true ? undefined : args.commit,
      });
      console.log(`run #${run.run_number} -> ${state}`);
      break;
    }

    case "heartbeat": {
      const until = await heartbeat(db, Number(need("run")), args.lease ? Number(args.lease) : 3600);
      console.log(`lease extended to ${new Date(until).toISOString()}`);
      break;
    }

    case "status": {
      const project = need("project");
      const [tasks, live, past] = await Promise.all([
        listTasks(db, project),
        inFlight(db, project),
        history(db, project, args.history ? Number(args.history) : 5),
      ]);
      if (asJson) { console.log(JSON.stringify({ tasks, inFlight: live, history: past }, null, 2)); break; }
      console.log(`project ${project}`);
      console.log(`\nin flight (${live.length}):`);
      for (const r of live) console.log(`  #${r.run_number} [${r.lane}] ${r.title} — ${r.agent}, silent ${r.silent_seconds}s, lease to ${new Date(r.lease_expires_at).toISOString()}`);
      console.log(`\nqueue:`);
      for (const t of tasks) console.log(`  ${String(t.state).padEnd(8)} #${t.id} [${t.lane}] p${t.priority} ${t.title}`);
      console.log(`\nlast ${past.length} finished:`);
      for (const r of past) console.log(`  #${r.run_number} ${r.state.padEnd(9)} ${r.title ?? "-"}`);
      break;
    }

    case "history": {
      const rows = await history(db, need("project"), args.limit ? Number(args.limit) : 20);
      if (asJson) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`#${r.run_number} ${r.state.padEnd(9)} [${r.lane ?? "-"}] ${r.title ?? "-"}${r.commit_sha ? ` ${r.commit_sha}` : ""}`);
      break;
    }

    default:
      console.log(`agentq — a queue for scheduled agent runs

  init                                          create the schema
  project [list]                                every project, its path and queue depth
  project add   --name N --path DIR [--prompt FILE] [--description D]
  project show  --name N
  project archive|unarchive --name N
  add     --project P --title T [--lane L] [--body B] [--priority N] [--depends-on ID]
  claim   --project P --agent A [--lane L] [--lease SECS] [--wait SECS] [--history N] [--json]
  done    --run ID [--summary S] [--commit SHA]
  block   --run ID [--summary S]
  fail    --run ID [--summary S]
  heartbeat --run ID [--lease SECS]
  status  --project P [--json]
  history --project P [--limit N] [--json]

Lanes decide concurrency: one running task per lane, so different lanes run in parallel and the
same lane queues. claim exits 3 when there is nothing to do; --wait polls for that many seconds
before giving up.

Database: ${DEFAULT_URL}  (override with AGENTQ_URL or --url)`);
      if (command && command !== "help") process.exit(1);
  }
}
