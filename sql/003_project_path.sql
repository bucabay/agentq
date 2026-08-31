-- Projects get an identity beyond a name.
--
-- The queue was already multi-project — tasks, runs and run numbering are all scoped by project.
-- What was missing is everything a SHIFT needs to actually work on one: where the checkout lives,
-- and which prompt to run. Without a path the trigger fires into nowhere.
alter table project add column if not exists path        text;
alter table project add column if not exists prompt_path text;
alter table project add column if not exists description text;
alter table project add column if not exists archived_at timestamptz;

comment on column project.path is
  'Absolute path to the checkout a shift runs in. Required before a project can be scheduled.';
comment on column project.prompt_path is
  'Optional explicit prompt file. When null the shift looks for <path>/.agentq/prompt.md, then prompts/<name>.md.';
