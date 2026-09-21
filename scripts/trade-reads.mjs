/* trade-reads.mjs — the work order and the gate for the roster room's narrative layer (§1.35).
 *
 * The trade search (build-roster-room.mjs) finds deals where BOTH optimal lineups rise. It cannot say
 * whether the other owner would accept one, and that is the judgment this layer adds: per proposal, a
 * coarse verdict (likely / coin_flip / long_shot) and a sentence or two on why and how to pitch it,
 * written by Claude through the /trade-reads command into <out_dir>/trade-reads.json.
 *
 * This script is the deterministic half, the same split as the re-scout drip: Claude writes the prose,
 * a script decides WHICH reads to write and whether what was written holds up.
 *
 *   node scripts/trade-reads.mjs [--league=<key>|--all]          work order (default --all)
 *   node scripts/trade-reads.mjs --check [--league=<key>|--all]  validate; exit 1 on any ERROR
 *
 * WORK ORDER. A read is keyed to its exact proposal (partner + the ids each side gives), so it is
 * carried forward for as long as that proposal survives the twice-daily rebuild and is only rewritten
 * when (a) the proposal is new or (b) a news event naming one of its players is dated after the read.
 * Reads whose proposal is gone, or that a later event has overtaken, are REMOVED here rather than left
 * to render: the page shows no read before it shows a read that predates the news on its players.
 * So a run costs what changed, not how many proposals exist.
 *
 * THE EVIDENCE RULE (the gate). "likely" and "long_shot" must carry `evidence` citing the owner's
 * actual behaviour. In a league with no owner dossiers (a first season), they are only allowed for a
 * partner who has made a move this season; otherwise the honest verdict is coin_flip, and the gate
 * enforces it rather than trusting the prose to.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAGUES } from "./lib/leagues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const one = (argv.find((a) => a.startsWith("--league=")) || "").slice(9);
const keys = one ? [one] : Object.keys(LEAGUES);
if (one && !LEAGUES[one]) { console.error(`Unknown league "${one}". Known: ${Object.keys(LEAGUES).join(", ")}.`); process.exit(1); }

export const VERDICTS = ["likely", "coin_flip", "long_shot"];
const TEXT_MAX = 320;
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const events = (readJSON(path.join(ROOT, "data", "site", "nfl-events.json"))?.events) ?? [];

/* The proposal key: partner roster + the sorted ids each side sends. Two proposals with the same
   players are the same deal whatever the gains say, so a projection wobble does not orphan a read. */
export const keyOf = (rid, p) =>
  `${rid}|${p.give.map((x) => x.id).sort().join("+")}>${p.get.map((x) => x.id).sort().join("+")}`;

const newsAfter = (names, since) => events
  .filter((e) => (!since || e.date > since) && (e.players ?? []).some((n) => names.includes(n)))
  .sort((a, b) => b.date.localeCompare(a.date));

let errors = 0, warnings = 0;
for (const k of keys) {
  const L = LEAGUES[k];
  const dir = path.join(ROOT, ...L.out_dir.split("/"));
  const room = readJSON(path.join(dir, "roster-room.json"));
  const file = path.join(dir, "trade-reads.json");
  const reads = readJSON(file) ?? { generated: null, league: k, reads: {} };
  if (!room) { console.log(`${k}: no roster-room.json, nothing to read.`); continue; }

  const perf = new Map((room.performance?.league ?? []).map((r) => [r.roster_id, r]));
  const current = new Map();
  for (const t of room.teams) for (const p of t.proposals ?? []) current.set(keyOf(t.roster_id, p), { t, p });

  if (CHECK) {
    const errs = [], warns = [];
    for (const [key, r] of Object.entries(reads.reads ?? {})) {
      const where = `${k} ${r.partner ?? "?"} (${key})`;
      if (!current.has(key)) { errs.push(`${where}: no such proposal in the current roster room. Run the work order to prune it.`); continue; }
      const { t } = current.get(key);
      if (!VERDICTS.includes(r.verdict)) errs.push(`${where}: verdict "${r.verdict}" is not one of ${VERDICTS.join(" / ")}.`);
      if (!r.text || !String(r.text).trim()) errs.push(`${where}: empty text.`);
      else if (String(r.text).length > TEXT_MAX) errs.push(`${where}: text is ${String(r.text).length} characters, over ${TEXT_MAX}.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.as_of ?? ""))) errs.push(`${where}: as_of "${r.as_of}" is not YYYY-MM-DD.`);
      if (r.verdict !== "coin_flip") {
        if (!r.evidence || !String(r.evidence).trim()) errs.push(`${where}: "${r.verdict}" needs evidence of the owner's actual behaviour; without it the verdict is coin_flip.`);
        if (!L.dossiers && !((t.moves?.n ?? 0) > 0)) errs.push(`${where}: ${L.name} has no owner history and this partner has made no move this season, so "${r.verdict}" has nothing behind it. It has to be coin_flip.`);
      }
      if (/—/.test(String(r.text) + String(r.evidence ?? ""))) warns.push(`${where}: contains an em-dash (house style).`);
    }
    for (const [key, { t }] of current) if (!reads.reads?.[key]) warns.push(`${k} ${t.owner} (${key}): proposal has no read yet.`);
    for (const e of errs) console.log(`ERROR  ${e}`);
    for (const w of warns) console.log(`warn   ${w}`);
    console.log(`${k}: ${errs.length ? "FAIL" : "OK"}  ${Object.keys(reads.reads ?? {}).length} read(s) for ${current.size} proposal(s), ${errs.length} error(s), ${warns.length} warning(s)`);
    errors += errs.length; warnings += warns.length;
    continue;
  }

  /* Work order: prune, then list. */
  const kept = {}, pruned = [];
  for (const [key, r] of Object.entries(reads.reads ?? {})) {
    const cur = current.get(key);
    if (!cur) { pruned.push(`${r.partner}: ${r.give?.join(" + ")} for ${r.get?.join(" + ")} (proposal gone)`); continue; }
    const names = [...cur.p.give, ...cur.p.get].map((x) => x.name);
    const later = newsAfter(names, r.as_of);
    if (later.length) { pruned.push(`${r.partner}: ${r.give?.join(" + ")} for ${r.get?.join(" + ")} (news ${later[0].date}: ${later[0].headline})`); continue; }
    kept[key] = r;
  }
  /* Written even when empty: a league with a roster room always has this file, so the page's fetch
     is a 200 with no reads rather than a 404 logged in the console on every Pit and Clash load. */
  if (!fs.existsSync(file) || pruned.length || Object.keys(kept).length !== Object.keys(reads.reads ?? {}).length) {
    fs.writeFileSync(file, JSON.stringify({ ...reads, league: k, reads: kept }, null, 1) + "\n");
  }
  const todo = [...current].filter(([key]) => !kept[key]);

  console.log(`\n=== ${L.name} (${k}): ${todo.length} read(s) to write · ${Object.keys(kept).length} carried forward · ${pruned.length} removed`);
  for (const p of pruned) console.log(`  removed: ${p}`);
  if (!todo.length) { console.log("  nothing to write for this league."); continue; }
  console.log(`  owner history: ${L.dossiers ? `${L.dossiers} (parsed into each team's tendencies below)` : "NONE (first season). Verdicts must be coin_flip unless the partner has made a move this season."}`);
  for (const [key, { t, p }] of todo) {
    const s = perf.get(t.roster_id);
    const td = t.tendencies;
    console.log(`\n  KEY ${key}`);
    console.log(`    partner  ${t.owner} (roster ${t.roster_id})${s ? `  standing ${s.seed ?? "-"} of ${room.teams.length}, ${s.w}-${s.l}${s.t ? `-${s.t}` : ""}, strength ${s.strength_rank} of ${room.teams.length}` : ""}`);
    console.log(`    deal     you give ${p.give.map((x) => `${x.name} (${x.pos} ${x.pts})`).join(" + ")} for ${p.get.map((x) => `${x.name} (${x.pos} ${x.pts})`).join(" + ")}  ·  you +${p.my_gain}, them +${p.their_gain} season pts${p.frees_bench ? " · frees a bench spot" : ""}`);
    console.log(`    their weak spots  ${(t.weaknesses ?? []).map((w) => `${w.pos} ${w.rank} of ${room.teams.length}`).join(", ") || "none in the bottom third"}`);
    if (td) {
      console.log(`    appetite  ${td.appetite?.band} (${td.appetite?.n} trades since 2020; ${td.channel_with_me ?? 0} with you)`);
      if (td.trades) console.log(`    dossier.trades   ${String(td.trades).replace(/\s+/g, " ")}`);
      if (td.exploit) console.log(`    dossier.exploit  ${String(td.exploit).replace(/\s+/g, " ")}`);
    } else {
      console.log(`    moves this season  ${t.moves?.n ?? 0} (${t.moves?.note ?? "none recorded"})`);
    }
    const news = newsAfter([...p.give, ...p.get].map((x) => x.name), null).slice(0, 3);
    for (const e of news) console.log(`    news ${e.date}  ${e.headline}`);
  }
}
if (CHECK) {
  if (errors) { console.log(`\n${errors} error(s). Fix them before publishing; the page renders only what passes.`); process.exit(1); }
  console.log(`\nAll trade reads pass${warnings ? ` (${warnings} warning(s))` : ""}.`);
}
