-- An explicit last-ping column.
--
-- lease_expires_at already told us WHETHER a run was stale. It could not tell us how long an agent
-- had been silent, which is the thing you actually want when deciding whether something is wedged.
-- "last pinged 47 minutes ago" is a diagnosis; "lease expired" is a status.
alter table run add column if not exists last_heartbeat_at timestamptz not null default now();
