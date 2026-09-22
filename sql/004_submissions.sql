-- The submission ledger: one searchable log of every place we have listed, submitted, pitched or
-- PR'd a product, across every lane and every project.
--
-- Why it is a table and not a markdown log. Fifteen lane trackers each kept their own
-- never-twice list, and dedupe meant grepping all of them and trusting that a human session had
-- not acted outside any of them. It failed three times (anymail #482 was the third duplicate PR
-- to one repo). A markdown claim is not a lock and a markdown log is not an index; this is both.
--
-- APPEND-ONLY. Every attempt is a row, including the ones that were refused, skipped or handed to
-- a human. The current state of a venue is the newest row for it, not an edit of an old one — so
-- the log answers "what happened" as well as "may I act".

create table if not exists submission (
  id          bigserial primary key,
  -- Normalised registrable host, lowercase, no scheme/www/path: `saashub.com`. The dedupe key.
  venue_key   text        not null,
  -- What a human calls it, for reading: `SaaSHub`.
  venue       text        not null,
  -- WHICH product was submitted. One venue can legitimately hold several of ours (the platform,
  -- the OSS server, the WP plugin), so dedupe is per product, never per venue alone.
  product     text        not null,
  action      text        not null,
  status      text        not null,
  lane        text        not null,
  project     text,
  url         text,
  listing_url text,
  -- Whatever proves it happened: a PR url, a message id, the confirmation text, a draft id.
  evidence    text,
  -- The lane doc where the narrative lives, so the log points back at the reasoning.
  tracker     text,
  notes       text,
  run_id      bigint,
  created_at  timestamptz not null default now(),
  -- Set when a LATER row takes over this (venue, product) pair: the natural progression
  -- submitted -> live, or a wrong row voided by hand. A superseded row stays in the log — it is
  -- history — but it no longer claims the pair, so the index below lets the successor in.
  superseded_at timestamptz,
  superseded_by text,
  constraint submission_action_ck check (action in
    ('form', 'email', 'pr', 'listing-found', 'account-claim', 'manual', 'skip', 'recheck')),
  constraint submission_status_ck check (status in
    ('submitted', 'live', 'rejected', 'needs-login', 'manual', 'paid', 'skip', 'held', 'blocked'))
);

-- The invariant that stops the duplicate: at most ONE open-or-successful submission per
-- (venue, product). `submitted` and `live` claim the pair; everything else (needs-login, manual,
-- paid, skip, held, blocked, rejected) is a non-claiming outcome that may legitimately recur.
-- Idempotent for a ledger created before these columns existed (the file is re-run by `subq init`).
alter table submission add column if not exists superseded_at timestamptz;
alter table submission add column if not exists superseded_by text;

-- The index predicate changed when supersede landed, so drop the older one by name before
-- recreating it; `if not exists` alone would keep the stale definition.
drop index if exists submission_one_per_venue_product_idx;

-- Exactly one LIVE claim per pair. `superseded_at is null` is what makes submitted -> live a
-- normal progression (two rows, one claim) instead of a constraint violation, and what lets a
-- mistaken row be voided without deleting the record of it.
create unique index if not exists submission_one_per_venue_product_idx
  on submission (venue_key, product)
  where status in ('submitted', 'live') and superseded_at is null;

create index if not exists submission_venue_idx   on submission (venue_key, created_at desc);
create index if not exists submission_lane_idx    on submission (lane, created_at desc);
create index if not exists submission_product_idx on submission (product, created_at desc);

-- Free-text search over everything a person would type: venue, product, notes, evidence, urls.
create index if not exists submission_search_idx on submission
  using gin (to_tsvector('english',
    coalesce(venue,'') || ' ' || coalesce(venue_key,'') || ' ' || coalesce(product,'') || ' ' ||
    coalesce(notes,'') || ' ' || coalesce(evidence,'') || ' ' || coalesce(url,'') || ' ' ||
    coalesce(listing_url,'') || ' ' || coalesce(lane,'')));

comment on table submission is
  'Append-only cross-lane ledger of outbound submissions. `subq check` gates every lane before it acts.';
