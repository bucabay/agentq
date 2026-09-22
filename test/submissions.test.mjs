/**
 * The ledger's job is to refuse the second submission. These tests are the invariants a lane
 * relies on when it treats a non-zero `subq check` as a final no.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  advance, check, current, list, migrateSubmissions, pool, record, search, venueKey, venues, voidEntry,
} from "../src/submissions.mjs";

const URL_TEST = process.env.AGENTQ_TEST_URL ?? "postgres://127.0.0.1:5432/agents_test";
let db;

before(async () => { db = pool(URL_TEST); await migrateSubmissions(db); });
after(async () => { await db.end(); });
beforeEach(async () => { await db.query("delete from submission"); });

const entry = (over = {}) => ({
  venue: "SaaSHub", venue_key: "saashub.com", product: "mailkite-platform",
  action: "form", status: "submitted", lane: "directory-submissions", ...over,
});

test("a URL, a bare host and a www host are one dedupe key", () => {
  assert.equal(venueKey("https://www.SaaSHub.com/submit?x=1").key, "saashub.com");
  assert.equal(venueKey("saashub.com").key, "saashub.com");
  assert.equal(venueKey("SaaSHub.com/services/submit").key, "saashub.com");
  // A name has no dot, so it cannot be silently treated as a host — the CLI rejects it by default.
  assert.equal(venueKey("SaaSHub").kind, "name");
});

test("the second submission of one product to one venue is refused", async () => {
  assert.equal((await record(db, entry())).ok, true);
  const second = await record(db, entry({ lane: "wp-plugin-promo", status: "live" }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.existing.lane, "directory-submissions");
});

test("a different product at the same venue is allowed, and is flagged as a sibling", async () => {
  await record(db, entry());
  // The gate is consulted BEFORE acting: the platform's listing must not block the plugin's.
  const verdict = await check(db, "saashub.com", "mailkite-wp-smtp");
  assert.equal(verdict.verdict, "clear");
  assert.equal(verdict.other_products.length, 1);
  assert.equal(verdict.other_products[0].product, "mailkite-platform");
  assert.equal((await record(db, entry({ product: "mailkite-wp-smtp" }))).ok, true);
});

test("submitted -> live is a progression, not a duplicate", async () => {
  await record(db, entry());
  const advanced = await advance(db, entry({ status: "live", listing_url: "https://x/y" }));
  assert.equal(advanced.ok, true);
  assert.equal(advanced.superseded.length, 1);
  // One claim survives; the superseded row stays in the log as history.
  assert.equal((await current(db, "saashub.com", "mailkite-platform")).status, "live");
  assert.equal((await list(db, { venue: "saashub.com" })).length, 2);
});

test("non-claiming outcomes may recur, and do not block a later real submission", async () => {
  // A login wall today is not a decision forever, so these leave the pair claimable. `rejected`
  // is deliberately NOT in this list — the venue said no, and that needs a human to reopen.
  for (const status of ["needs-login", "manual", "paid"]) {
    assert.equal((await record(db, entry({ status }))).ok, true, status);
  }
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "clear");
  assert.equal((await record(db, entry())).ok, true);
});

test("skip and held are verdicts a lane must not work around", async () => {
  await record(db, entry({ status: "skip", notes: "not a design tool" }));
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "skip");
  await db.query("delete from submission");
  await record(db, entry({ status: "held", lane: "wp-plugin-promo" }));
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "held");
});

test("voiding a wrong row frees the pair without deleting the history", async () => {
  const first = await record(db, entry());
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "duplicate");
  await voidEntry(db, first.row.id, "recorded against the wrong product");
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "clear");
  assert.equal((await list(db, { venue: "saashub.com" })).length, 1);
});

test("search finds an entry by venue, note or lane", async () => {
  await record(db, entry({ notes: "free listing tier, dofollow" }));
  assert.equal((await search(db, "dofollow")).length, 1);
  assert.equal((await search(db, "saashub")).length, 1);
  assert.equal((await search(db, "nothing-like-this")).length, 0);
});

test("venues reports one current row per venue+product", async () => {
  await record(db, entry());
  await advance(db, entry({ status: "live" }));
  await record(db, entry({ venue_key: "betalist.com", venue: "Betalist" }));
  const rows = await venues(db);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.venue_key === "saashub.com").status, "live");
});

/* Regressions from the first real backfill runs (2026-09-06). All three were found by agents
   using the ledger in anger, not by these tests — which is why they are now tests. */

test("two PRs to two repos on one code host are two venues", () => {
  // Collapsing every GitHub URL to `github.com` let the first PR claim the pair and refused
  // every later PR to a different repo as a duplicate.
  assert.equal(venueKey("https://github.com/punkpeye/awesome-mcp-servers").key,
               "github.com/punkpeye/awesome-mcp-servers");
  assert.equal(venueKey("github.com/mailkite/server").key, "github.com/mailkite/server");
  assert.equal(venueKey("https://github.com/foo/bar.git").key, "github.com/foo/bar");
  assert.equal(venueKey("https://github.com/").key, "github.com");
  assert.equal(venueKey("https://gitlab.com/a/b").kind, "repo");
});

test("two PRs to two repos do not collide in the ledger", async () => {
  const pr = (repo) => entry({ venue_key: `github.com/${repo}`, venue: repo,
    product: "mailkite-server", action: "pr", status: "submitted", lane: "promote-oss" });
  assert.equal((await record(db, pr("punkpeye/awesome-mcp-servers"))).ok, true);
  assert.equal((await record(db, pr("wong2/awesome-mcp-servers"))).ok, true);
  assert.equal((await record(db, pr("punkpeye/awesome-mcp-servers"))).ok, false);
});

test("a venue that rejected us is not silently clear", async () => {
  await record(db, entry({ status: "rejected", notes: "maintainer closed it: no vendor entries" }));
  const verdict = await check(db, "saashub.com", "mailkite-platform");
  assert.equal(verdict.verdict, "rejected");
  assert.equal(verdict.rejected.notes, "maintainer closed it: no vendor entries");
  // The only way back in is a human voiding the row with a reason.
  await voidEntry(db, verdict.rejected.id, "they now accept vendor entries");
  assert.equal((await check(db, "saashub.com", "mailkite-platform")).verdict, "clear");
});
