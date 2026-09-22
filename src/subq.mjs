#!/usr/bin/env node
/**
 * subq — the cross-lane submission ledger.
 *
 *   subq check  --venue <url|host> --product <p>      # THE GATE. 0 clear · 4 dup · 5 barred/rejected · 6 held
 *   subq record --venue <url|host> --product <p> --action <a> --status <s> --lane <l> [...]
 *   subq record ... --advance                          # same submission moving on (submitted -> live)
 *   subq void   --id <n> --why "<reason>"              # release a claim recorded in error
 *   subq search <text>                                 # free text across everything
 *   subq list   [--lane L] [--product P] [--status S] [--venue V] [--limit N]
 *   subq venues [--product P]                          # current state, one row per venue+product
 *   subq import --file <jsonl>                         # bulk backfill from a lane's tracker
 *   subq rekey  [--apply]                              # recompute keys from each row's url
 *   subq stats
 *   subq init                                          # create the table
 *
 * Exit codes on `check` are the contract, and they mirror send-email.sh so a lane reads them the
 * same way: 0 act, 4 already done, 5 barred by a rule or refused by the venue, 6 another lane holds
 * it. Non-zero is always a correct, final NO — never work around it.
 *
 * `--url` is the SUBMISSION url. The database override is `--db-url` (or AGENTQ_URL).
 */
import {
  DEFAULT_URL, advance, check, list, migrateSubmissions, pool, record, rekey, search, stats,
  venueKey, venues, historyFor, voidEntry,
} from "./submissions.mjs";
import { readFileSync } from "node:fs";

const [, , command, ...rest] = process.argv;

const positional = [];
const args = (() => {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
})();

const die = (message, code = 1) => { console.error(`subq: ${message}`); process.exit(code); };
const need = (key) => (args[key] === undefined ? die(`missing --${key}`) : args[key]);
const asJson = args.json === true;

/**
 * A bare product name is a weak dedupe key (`SaaSHub` and `saashub.com` are different strings), so
 * the ledger insists on the domain unless the caller explicitly accepts the weaker match.
 */
function strictVenue(input) {
  const parsed = venueKey(input);
  if (parsed.kind === "name" && args["allow-name"] !== true) {
    die(`"${input}" is not a domain. Pass the venue's URL or host (saashub.com) so the key matches\n` +
        `       what other lanes recorded, or --allow-name if you really mean a name-only key.`);
  }
  return parsed;
}

// `--url` is the SUBMISSION url, never the database. Overriding the connection is `--db-url`
// (or AGENTQ_URL). They shared a flag until 2026-09-06, when a lane recording a GitHub PR made
// this CLI try to speak Postgres to github.com:5432 — four ETIMEDOUTs and a broken run.
const db = pool(args["db-url"] ?? DEFAULT_URL);
let exitCode = 0;
try {
  await run();
} catch (err) {
  console.error(`subq: ${err.message}`);
  exitCode = 1;
} finally {
  await db.end();
  process.exit(exitCode);
}

function line(r) {
  const when = new Date(r.created_at).toISOString().slice(0, 10);
  const where = r.listing_url || r.url || "";
  return `${when}  ${r.status.padEnd(11)} ${r.action.padEnd(13)} ${r.venue_key.padEnd(24)} ` +
         `${r.product.padEnd(20)} ${r.lane.padEnd(22)} ${where}`;
}

async function run() {
  switch (command) {
    case "init":
      await migrateSubmissions(db);
      console.log(`subq: submission ledger ready at ${args["db-url"] ?? DEFAULT_URL}`);
      break;

    case "check": {
      const { key } = strictVenue(need("venue"));
      const result = await check(db, key, need("product"));
      if (asJson) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`venue ${result.venue_key} · product ${result.product} · ${result.verdict.toUpperCase()}`);
        if (result.claimed) console.log(`  already ${result.claimed.status} by [${result.claimed.lane}] on ` +
          `${new Date(result.claimed.created_at).toISOString().slice(0,10)} — ${result.claimed.listing_url || result.claimed.evidence || "no url recorded"}`);
        if (result.barred) console.log(`  barred (${result.barred.status}) by [${result.barred.lane}]: ${result.barred.notes || "no reason recorded"}`);
        if (result.rejected) console.log(`  REJECTED by the venue on ` +
          `${new Date(result.rejected.created_at).toISOString().slice(0,10)}: ${result.rejected.notes || "no reason recorded"}\n` +
          `  Do not resubmit on your own judgement. If the reason is genuinely fixed, Gabe releases it with ` +
          `\`subq void --id ${result.rejected.id} --why "<what changed>"\`.`);
        if (result.held) console.log(`  held by [${result.held.lane}]: ${result.held.notes || "no reason recorded"}`);
        for (const o of result.other_products)
          console.log(`  note: ${o.product} is ${o.status} here (a separate entry is fine, editing theirs is not)`);
        if (result.history.length) {
          console.log(`  history (${result.history.length}):`);
          for (const r of result.history.slice(0, 10)) console.log(`    ${line(r)}`);
        }
        if (result.verdict === "clear") console.log("  clear — act, then `subq record` it in the SAME run");
      }
      exitCode = { clear: 0, duplicate: 4, skip: 5, rejected: 5, held: 6 }[result.verdict];
      break;
    }

    case "record": {
      const { key } = strictVenue(args.venue ?? args.url ?? die("missing --venue"));
      const entry = {
        venue_key: key,
        venue: args.venue && !/^https?:/i.test(args.venue) ? args.venue : (args.name ?? key),
        product: need("product"), action: need("action"), status: need("status"), lane: need("lane"),
        project: args.project, url: args.url, listing_url: args.listing, evidence: args.evidence,
        tracker: args.tracker, notes: args.notes, run_id: args.run ? Number(args.run) : null,
      };
      // --advance is the explicit "this is the same submission moving on" (submitted -> live). It
      // supersedes the prior claim in one transaction instead of being refused as a duplicate.
      const result = args.advance === true
        ? await advance(db, entry, `advanced by ${entry.lane}`)
        : await record(db, entry);
      if (result.superseded?.length)
        console.log(`subq: superseded #${result.superseded.map((r) => r.id).join(", #")} (${result.superseded[0].status})`);
      if (!result.ok) {
        console.error(`subq: REFUSED — ${key} already has a ${result.existing?.status} entry for ` +
          `${args.product} from [${result.existing?.lane}] on ` +
          `${result.existing ? new Date(result.existing.created_at).toISOString().slice(0,10) : "?"}.`);
        console.error("       That is the duplicate this ledger exists to stop. Log the finding, do not retry.");
        console.error("       If this is the SAME submission moving on (submitted -> live), re-run with --advance.");
        exitCode = 4;
        break;
      }
      console.log(asJson ? JSON.stringify(result.row, null, 2) : `subq: recorded #${result.row.id}  ${line(result.row)}`);
      break;
    }

    case "void": {
      const row = await voidEntry(db, Number(need("id")), args.why ?? args.notes);
      if (!row) die(`no live entry #${args.id} to void (already superseded?)`, 1);
      console.log(`subq: voided #${row.id} — ${row.venue_key} / ${row.product} (${row.status}); the pair is free again`);
      break;
    }

    case "search": {
      const query = positional.join(" ") || args.q;
      if (!query) die("usage: subq search <text>");
      const rows = await search(db, query, Number(args.limit ?? 40));
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); break; }
      if (!rows.length) { console.log(`no submissions match "${query}"`); break; }
      console.log(`${rows.length} match "${query}":`);
      for (const r of rows) {
        console.log("  " + line(r));
        if (r.notes) console.log(`      ${r.notes}`);
      }
      break;
    }

    case "list": {
      const rows = await list(db, {
        lane: args.lane, product: args.product, status: args.status, venue: args.venue,
        limit: Number(args.limit ?? 50),
      });
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); break; }
      if (!rows.length) { console.log("no entries"); break; }
      for (const r of rows) console.log(line(r));
      break;
    }

    case "history": {
      const { key } = strictVenue(need("venue"));
      const rows = await historyFor(db, key, args.product);
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); break; }
      if (!rows.length) { console.log(`no history for ${key}`); break; }
      for (const r of rows) {
        console.log(line(r));
        if (r.notes) console.log(`      ${r.notes}`);
        if (r.evidence) console.log(`      evidence: ${r.evidence}`);
      }
      break;
    }

    case "venues": {
      const rows = await venues(db, { product: args.product });
      if (asJson) { console.log(JSON.stringify(rows, null, 2)); break; }
      for (const r of rows) console.log(line(r));
      console.log(`\n${rows.length} venue/product pairs`);
      break;
    }

    /**
     * Bulk backfill. One JSON object per line, same fields as `record`. Duplicates are reported and
     * skipped rather than aborting the file — a backfill of ten years of markdown will contain the
     * same venue twice, and that is a finding, not a crash.
     */
    case "import": {
      const file = need("file");
      const lines = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      let ok = 0, dup = 0, bad = 0;
      for (const [i, raw] of lines.entries()) {
        let entry;
        try { entry = JSON.parse(raw); } catch { console.error(`  line ${i + 1}: not JSON`); bad++; continue; }
        try {
          const result = await record(db, entry);
          if (result.ok) { ok++; }
          else { dup++; console.error(`  line ${i + 1}: duplicate — ${entry.venue ?? entry.venue_key} / ${entry.product} already ${result.existing?.status} by [${result.existing?.lane}]`); }
        } catch (err) { bad++; console.error(`  line ${i + 1}: ${err.message}`); }
      }
      console.log(`subq: imported ${ok}, duplicates ${dup}, errors ${bad} (of ${lines.length})`);
      if (bad) exitCode = 1;
      break;
    }

    case "rekey": {
      const result = await rekey(db, { apply: args.apply === true });
      console.log(`${args.apply === true ? "rekeyed" : "would rekey"} ${result.changes.length} of ${result.scanned} rows`);
      for (const c of result.changes) console.log(`  #${c.id}  ${c.from}  ->  ${c.to}   (${c.product}, ${c.lane})`);
      if (result.collisions.length) {
        console.log(`\n${result.collisions.length} COLLISION(S) — left alone, a human should look:`);
        for (const c of result.collisions)
          console.log(`  #${c.id} ${c.from} -> ${c.to} (${c.product}) already claimed by #${c.collides_with}`);
        exitCode = 4;
      }
      if (!args.apply) console.log("\n(dry run — re-run with --apply)");
      break;
    }

    case "stats": {
      const s = await stats(db);
      if (asJson) { console.log(JSON.stringify(s, null, 2)); break; }
      console.log(`${s.entries} entries · ${s.venues} venues · ${s.products} products\n`);
      let lane = null;
      for (const r of s.by_lane) {
        if (r.lane !== lane) { console.log(r.lane); lane = r.lane; }
        console.log(`  ${r.status.padEnd(12)} ${r.n}`);
      }
      break;
    }

    default:
      console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 19).join("\n").replace(/^ \* ?/gm, ""));
      if (command) exitCode = 1;
  }
}
