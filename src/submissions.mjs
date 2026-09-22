/**
 * The submission ledger — one searchable log of every outbound listing/submission/pitch, shared by
 * every lane in every project.
 *
 * The contract a lane cares about is `check()`: it answers "may I act on this venue with this
 * product" with an exit code, the same discipline send-email.sh already uses for contact dedupe.
 * A lane must never decide that for itself from a markdown tracker again.
 */
import { pool, DEFAULT_URL } from "./providers/postgres.mjs";

export { pool, DEFAULT_URL };

/** Statuses that CLAIM a (venue, product) pair — a second one is the duplicate we are preventing. */
export const CLAIMING = new Set(["submitted", "live"]);

/**
 * Normalise anything a human or a runbook might type into the dedupe key.
 *
 * A URL, a bare host, or a display name all have to land on the same key or the index is
 * decorative: `https://www.SaaSHub.com/submit?x=1`, `saashub.com` and `SaaSHub` are one venue.
 * Names without a dot are slugified and marked, because name-matching is genuinely weaker than
 * host-matching and the caller should know which one it got. On a code host the key keeps
 * `owner/repo`: two PRs to two repos are two venues, not one.
 */
/** Hosts where the repository, not the domain, is the thing we submit to. */
export const CODE_HOSTS = new Set([
  "github.com", "gitlab.com", "bitbucket.org", "codeberg.org", "git.sr.ht",
]);

export function venueKey(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("venue is required");
  let host = raw;
  let path = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try { const u = new URL(host); host = u.hostname; path = u.pathname; }
    catch { /* fall through to the plain-string paths */ }
  } else if (host.includes("/")) {
    path = host.slice(host.indexOf("/"));
    host = host.split("/")[0];
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/[.,;:)]+$/, "");
  // Code hosts are not venues — the REPO is. Collapsing github.com/a/b and github.com/c/d to one
  // key made the first PR claim every future one (found by the mcp-directories backfill run,
  // 2026-09-06), so for these hosts the first two path segments stay in the key.
  if (CODE_HOSTS.has(host) && path) {
    const [owner, repo] = path.split("/").filter(Boolean);
    if (owner && repo) return { key: `${host}/${owner}/${repo.replace(/\.git$/, "")}`, kind: "repo" };
  }
  if (host.includes(".") && !host.includes(" ")) return { key: host, kind: "host" };
  return { key: raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), kind: "name" };
}

export async function migrateSubmissions(db) {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  await db.query(readFileSync(join(here, "..", "sql", "004_submissions.sql"), "utf8"));
}

/**
 * Advance an existing claim: supersede the row holding (venue, product) and insert the new one in
 * one transaction. This is `submitted -> live`, or `live -> rejected` — the same submission moving
 * on, not a second one. Without `advance` a second claim is refused, which is the dedupe.
 */
export async function advance(db, entry, reason = "advanced") {
  const { key } = venueKey(entry.venue_key ?? entry.url ?? entry.venue);
  const client = await db.connect();
  try {
    await client.query("begin");
    const { rows: held } = await client.query(
      `select * from submission
        where venue_key = $1 and product = $2 and status in ('submitted','live') and superseded_at is null
        for update`,
      [key, entry.product],
    );
    await client.query(
      `update submission set superseded_at = now(), superseded_by = $2 where id = any($1::bigint[])`,
      [held.map((r) => r.id), reason],
    );
    const result = await record(client, entry);
    await client.query("commit");
    return { ...result, superseded: held };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Void a row that should never have claimed the pair. History is kept; the claim is released. */
export async function voidEntry(db, id, why) {
  const { rows } = await db.query(
    `update submission set superseded_at = now(), superseded_by = $2
      where id = $1 and superseded_at is null returning *`,
    [id, why ?? "voided"],
  );
  return rows[0] ?? null;
}

export async function record(db, entry) {
  const { key } = venueKey(entry.venue_key ?? entry.url ?? entry.venue);
  const row = {
    venue_key: key,
    venue: entry.venue ?? key,
    product: entry.product,
    action: entry.action,
    status: entry.status,
    lane: entry.lane,
    project: entry.project ?? null,
    url: entry.url ?? null,
    listing_url: entry.listing_url ?? null,
    evidence: entry.evidence ?? null,
    tracker: entry.tracker ?? null,
    notes: entry.notes ?? null,
    run_id: entry.run_id ?? null,
  };
  for (const required of ["product", "action", "status", "lane"]) {
    if (!row[required]) throw new Error(`missing ${required}`);
  }
  try {
    const { rows } = await db.query(
      `insert into submission (venue_key, venue, product, action, status, lane, project, url,
                               listing_url, evidence, tracker, notes, run_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [row.venue_key, row.venue, row.product, row.action, row.status, row.lane, row.project,
       row.url, row.listing_url, row.evidence, row.tracker, row.notes, row.run_id],
    );
    return { ok: true, row: rows[0] };
  } catch (err) {
    // 23505 = the one-per-(venue,product) unique index. This is the duplicate being refused at the
    // database, which is the whole point of the table — report it with the row that already holds
    // the pair so the caller can log the finding instead of guessing.
    if (err.code === "23505") {
      const existing = await current(db, row.venue_key, row.product);
      return { ok: false, reason: "duplicate", existing };
    }
    throw err;
  }
}

/** The newest CLAIMING row for a (venue, product), or null when the pair is free. */
export async function current(db, key, product) {
  const { rows } = await db.query(
    `select * from submission
      where venue_key = $1 and product = $2 and status in ('submitted','live')
        and superseded_at is null
      order by created_at desc limit 1`,
    [key, product],
  );
  return rows[0] ?? null;
}

export async function historyFor(db, key, product = null) {
  const { rows } = await db.query(
    `select * from submission
      where venue_key = $1 ${product ? "and product = $2" : ""}
      order by created_at desc`,
    product ? [key, product] : [key],
  );
  return rows;
}

/**
 * The gate. Verdicts map to CLI exit codes, deliberately echoing send-email.sh:
 *   clear (0)      nothing claims this pair — act, then record
 *   duplicate (4)  already submitted/live for this product — do NOT act, log the finding
 *   skip (5)       a rule says never here (skip/blocked) — final
 *   rejected (5)   the venue itself said no — final until a human voids the row with a reason
 *   held (6)       another lane is acting on it first — wait, do not jump the queue
 * `other-product` is informational: a sibling product is listed here, which is allowed, but the
 * listing must be a separate entry rather than an edit of theirs.
 */
export async function check(db, venue, product) {
  const { key, kind } = venueKey(venue);
  const rows = await historyFor(db, key);
  const mine = rows.filter((r) => r.product === product);
  const claimed = mine.find((r) => CLAIMING.has(r.status) && !r.superseded_at);
  const held = mine.find((r) => r.status === "held" && !r.superseded_at);
  const barred = mine.find((r) => (r.status === "skip" || r.status === "blocked") && !r.superseded_at);
  const rejected = mine.find((r) => r.status === "rejected" && !r.superseded_at);
  const others = rows.filter((r) => r.product !== product && CLAIMING.has(r.status) && !r.superseded_at);

  let verdict = "clear";
  if (claimed) verdict = "duplicate";
  else if (barred) verdict = "skip";
  else if (rejected) verdict = "rejected";
  else if (held) verdict = "held";

  return {
    venue_key: key,
    key_kind: kind,
    product,
    verdict,
    claimed: claimed ?? null,
    held: held ?? null,
    barred: barred ?? null,
    rejected: rejected ?? null,
    other_products: others,
    history: rows,
  };
}

export async function search(db, query, limit = 40) {
  const { rows } = await db.query(
    `select * from submission
      where to_tsvector('english',
              coalesce(venue,'') || ' ' || coalesce(venue_key,'') || ' ' || coalesce(product,'') || ' ' ||
              coalesce(notes,'') || ' ' || coalesce(evidence,'') || ' ' || coalesce(url,'') || ' ' ||
              coalesce(listing_url,'') || ' ' || coalesce(lane,''))
            @@ plainto_tsquery('english', $1)
         or venue_key like '%' || lower($1) || '%'
         or lower(venue) like '%' || lower($1) || '%'
      order by created_at desc limit $2`,
    [query, limit],
  );
  return rows;
}

export async function list(db, { lane, product, status, venue, limit = 50 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (lane) add("lane = ?", lane);
  if (product) add("product = ?", product);
  if (status) add("status = ?", status);
  if (venue) add("venue_key = ?", venueKey(venue).key);
  params.push(limit);
  const { rows } = await db.query(
    `select * from submission ${where.length ? "where " + where.join(" and ") : ""}
      order by created_at desc limit $${params.length}`,
    params,
  );
  return rows;
}

/** Current state per (venue, product): the newest row for each pair. */
export async function venues(db, { product } = {}) {
  const { rows } = await db.query(
    `select distinct on (venue_key, product) *
       from submission ${product ? "where product = $1" : ""}
      order by venue_key, product, created_at desc`,
    product ? [product] : [],
  );
  return rows;
}

export async function stats(db) {
  const { rows } = await db.query(
    `select lane, status, count(*)::int as n from submission group by lane, status order by lane, status`,
  );
  const { rows: totals } = await db.query(
    `select count(*)::int as entries, count(distinct venue_key)::int as venues,
            count(distinct product)::int as products from submission`,
  );
  return { by_lane: rows, ...totals[0] };
}

/**
 * Recompute stored keys from each row's own url.
 *
 * Backfills written before code-host keys existed (2026-09-06) used `owner-repo` name keys, which
 * no longer match what `check` derives from a GitHub URL — the row says submitted and the gate says
 * clear, which is the exact failure this table exists to prevent. Collisions are reported, never
 * merged: two claiming rows for one repo is a finding a human should read.
 */
export async function rekey(db, { apply = false } = {}) {
  const { rows } = await db.query(
    `select id, venue_key, url, listing_url, product, status, lane from submission
      where superseded_at is null order by id`,
  );
  const changes = [], collisions = [];
  const claimed = new Map();
  for (const r of rows) {
    if (CLAIMING.has(r.status)) claimed.set(`${r.venue_key}|${r.product}`, r.id);
  }
  for (const r of rows) {
    const source = r.url || r.listing_url;
    if (!source) continue;
    let derived;
    try { derived = venueKey(source).key; } catch { continue; }
    if (derived === r.venue_key) continue;
    // Only ever move a weaker key onto a stronger one (name -> host/repo), never the reverse.
    if (r.venue_key.includes(".") || !derived.includes(".")) continue;
    const pair = `${derived}|${r.product}`;
    if (CLAIMING.has(r.status) && claimed.has(pair) && claimed.get(pair) !== r.id) {
      collisions.push({ id: r.id, from: r.venue_key, to: derived, product: r.product,
                        collides_with: claimed.get(pair) });
      continue;
    }
    changes.push({ id: r.id, from: r.venue_key, to: derived, product: r.product, lane: r.lane });
    if (CLAIMING.has(r.status)) claimed.set(pair, r.id);
  }
  if (apply) {
    for (const c of changes) {
      await db.query("update submission set venue_key = $2 where id = $1", [c.id, c.to]);
    }
  }
  return { changes, collisions, scanned: rows.length };
}
