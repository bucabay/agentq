-- Agent run queue.
--
-- Two ideas carry the whole design:
--
--   LANES give you parallelism without a scheduler. One running task per lane, so agents working
--   different lanes run at the same time and agents wanting the same lane queue behind each other.
--   Put work that touches the same files in one lane; put independent work in its own.
--
--   LEASES make crashes survivable. A run holds its task for lease_seconds. If the agent dies the
--   lease expires, the run is marked abandoned and the task returns to the queue automatically.
--   Nothing needs to notice the crash.

create table if not exists project (
  name         text primary key,
  created_at   timestamptz not null default now(),
  runs_started integer     not null default 0
);

create table if not exists task (
  id          bigserial primary key,
  project     text        not null references project(name) on delete cascade,
  -- One running task per lane, per project. This is the concurrency control.
  lane        text        not null default 'default',
  title       text        not null,
  body        text,
  -- Lower sorts first.
  priority    integer     not null default 100,
  state       text        not null default 'queued',
  -- A task is not claimable until its dependency is done.
  depends_on  bigint      references task(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint task_state_ck check (state in ('queued', 'running', 'done', 'blocked', 'cancelled'))
);

create index if not exists task_claimable_idx on task (project, state, priority, id);
create index if not exists task_lane_idx      on task (project, lane, state);

create table if not exists run (
  id               bigserial primary key,
  project          text        not null references project(name) on delete cascade,
  -- Monotonic per project. This is the "which run am I" number an agent reports.
  run_number       integer     not null,
  task_id          bigint      references task(id) on delete set null,
  agent            text        not null,
  host             text,
  pid              integer,
  state            text        not null default 'running',
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  lease_expires_at timestamptz not null,
  summary          text,
  commit_sha       text,
  constraint run_state_ck check (state in ('running', 'done', 'failed', 'blocked', 'abandoned')),
  unique (project, run_number)
);

create index if not exists run_recent_idx on run (project, run_number desc);
create index if not exists run_live_idx    on run (state, lease_expires_at);
