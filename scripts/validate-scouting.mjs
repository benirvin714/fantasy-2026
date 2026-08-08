// Coverage tracker + deterministic validator for the pre-draft scouting sweep.
//
// The sweep's job: give every skill player "with real value" (the draft-board pool,
// QB/RB/WR/TE) a scouting_brief in data/draft-research.json. This script is how you know
// where the sweep stands and whether what's been written is sound. Two jobs:
//
//   COVERAGE — of the skill pool, how many are scouted vs missing, bucketed by draft
//   relevance (pool is in Sleeper search-rank order), plus the ordered worklist of who's
//   next. This is the resumable "done" signal: /scout fills the worklist in batches.
//
//   VALIDATION — for each brief that exists: source URLs resolve, enums are legal
//   (role_stability/scheme_fit/source.type), the honesty contract holds (prose present =>
//   sources present; prose null => a rationale says why), and as_of isn't stale.
//
// REPORT ONLY. Unlike validate-events, this NEVER mutates draft-research.json — that is
// durable hand/agent work, so a dead link or bad enum is flagged for a human to fix, not
// silently stripped. Findings -> data/raw/scouting-flags.json. Exit code is always 0.
//
// Usage:
//   node scripts/validate-scouting.mjs               coverage + validate every brief (URL check on)
//   node scripts/validate-scouting.mjs --no-net       skip URL liveness (offline / fast)
//   node scripts/validate-scouting.mjs --worklist 12  also print the next N unscouted (pool order)
//   node scripts/validate-scouting.mjs --stale-days 14 age past which a brief is "re-verify" (default 21)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BOARD_PATH = path.join(ROOT, "data", "site", "draft-board.json");
const RESEARCH_PATH = path.join(ROOT, "data", "draft-research.json");
const FLAGS_PATH = path.join(ROOT, "data", "raw", "scouting-flags.json");

const args = process.argv.slice(2);
const NO_NET = args.includes("--no-net");
const flagVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const WORKLIST = parseInt(flagVal("--worklist", "0"), 10) || 0;
const STALE_DAYS = parseInt(flagVal("--stale-days", "21"), 10) || 21;

const SKILL = new Set(["QB", "RB", "WR", "TE"]);
const ROLE = new Set(["locked", "committee", "in_flux"]);
const FIT = new Set(["plus", "neutral", "minus"]);
const STYPE = new Set(["coach", "beat", "analyst", "player"]);

// ---- URL liveness (copied from validate-events.mjs: same conservative classification) ----
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function checkUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
    try { await res.body?.cancel?.(); } catch {}
    if (res.status === 404 || res.status === 410) return { state: "dead", code: res.status };
    if (res.status >= 200 && res.status < 400) return { state: "ok", code: res.status };
    return { state: "inconclusive", code: res.status };
  } catch (e) {
    const msg = String(e?.cause?.code || e?.code || e?.message || e);
    if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ECONNREFUSED/i.test(msg)) return { state: "dead", code: msg };
    return { state: "inconclusive", code: msg };
  } finally { clearTimeout(t); }
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- load -----------------------------------------------------------------------------
const board = JSON.parse(fs.readFileSync(BOARD_PATH, "utf8"));
const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, "utf8"));
const briefs = research.players || {};
// Order the pool by ADP (draft order) so the worklist fills the earliest-drafted gaps first
// and a partial sweep still covers the most decision-relevant players. Null ADP sorts last.
const pool = (board.players || [])
  .filter((p) => SKILL.has(p.pos))
  .sort((a, b) => (a.adp?.half_ppr ?? 9999) - (b.adp?.half_ppr ?? 9999));
const briefOf = (id) => briefs[String(id)]?.scouting_brief ?? null;

const TODAY = new Date().toISOString().slice(0, 10);
const ageDays = (ymd) => Math.floor((Date.parse(TODAY) - Date.parse(ymd)) / 86400000);

// ---- coverage -------------------------------------------------------------------------
const scouted = pool.filter((p) => briefOf(p.id));
const missing = pool.filter((p) => !briefOf(p.id));
const bucket = (lo, hi) => {
  const seg = pool.slice(lo, hi);
  return { have: seg.filter((p) => briefOf(p.id)).length, of: seg.length };
};
const tiers = { "top50": bucket(0, 50), "51-100": bucket(50, 100), "101+": bucket(100, pool.length) };
const worklist = missing.map((p, i) => ({ rank: pool.indexOf(p) + 1, id: p.id, name: p.name, pos: p.pos, adp: p.adp?.half_ppr ?? null, bc: p.fftiers?.rank ?? p.fftiers ?? null }));

// ---- validation -----------------------------------------------------------------------
const issues = [], stale = [];
const urlJobs = []; // {id,name,label,url}
for (const p of pool) {
  const b = briefOf(p.id);
  if (!b) continue;
  const tag = (issue) => issues.push({ id: p.id, name: p.name, issue });
  if (b.prose == null) {
    if (!b.rationale) tag("prose is null but no rationale explains why (honesty contract)");
  } else {
    if (typeof b.prose !== "string" || b.prose.trim().length < 20) tag("prose too short or not a string");
    if (!Array.isArray(b.sources) || b.sources.length === 0) tag("prose present but no sources (must be sourced, not from memory)");
  }
  if (b.role_stability != null && !ROLE.has(b.role_stability)) tag(`illegal role_stability "${b.role_stability}"`);
  if (b.scheme_fit != null && !FIT.has(b.scheme_fit)) tag(`illegal scheme_fit "${b.scheme_fit}"`);
  if (b.override_flag != null && typeof b.override_flag !== "boolean") tag("override_flag is not a boolean");
  if (!b.as_of) tag("missing as_of");
  else if (ageDays(b.as_of) > STALE_DAYS) stale.push({ id: p.id, name: p.name, as_of: b.as_of, age_days: ageDays(b.as_of) });
  for (const src of Array.isArray(b.sources) ? b.sources : []) {
    if (!src || !src.url) { tag(`source "${src?.label ?? "?"}" missing url`); continue; }
    if (src.type && !STYPE.has(src.type)) tag(`source "${src.label}" illegal type "${src.type}"`);
    if (!src.date) tag(`source "${src.label}" missing date`);
    urlJobs.push({ id: p.id, name: p.name, label: src.label, url: src.url });
  }
}
// orphan briefs: a brief keyed to an id that isn't in the current skill pool (stale/mis-keyed)
for (const id of Object.keys(briefs)) {
  if (briefs[id]?.scouting_brief && !pool.some((p) => String(p.id) === String(id)))
    issues.push({ id, name: "(not in skill pool)", issue: "brief keyed to a non-pool id — verify id / rebuild board" });
}

// ---- URL liveness (with the same network-blip circuit breaker) ------------------------
let deadSources = [], inconclusive = [], urlNote = null;
if (!NO_NET && urlJobs.length) {
  const states = await mapPool(urlJobs.map((j) => j.url), 6, (u) => checkUrl(u));
  const deadN = states.filter((s) => s.state === "dead").length, okN = states.filter((s) => s.state === "ok").length;
  const unreliable = deadN > 0 && (okN === 0 || deadN > urlJobs.length * 0.5);
  if (unreliable) urlNote = `URL check unreliable: ${deadN}/${urlJobs.length} unreachable, ${okN} ok — network blip, not flagging individual links`;
  else states.forEach((s, i) => {
    if (s.state === "dead") deadSources.push({ ...urlJobs[i], code: String(s.code) });
    else if (s.state === "inconclusive") inconclusive.push({ ...urlJobs[i], code: String(s.code) });
  });
}

// ---- write flags + summary ------------------------------------------------------------
const flags = {
  generated_at: new Date().toISOString(),
  net: !NO_NET,
  coverage: { pool: pool.length, scouted: scouted.length, missing: missing.length, by_tier: tiers },
  worklist: worklist.slice(0, 60),
  brief_issues: issues,
  dead_sources: deadSources,
  inconclusive_urls: inconclusive,
  stale: stale,
  url_note: urlNote,
};
fs.writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2) + "\n");

const pct = pool.length ? Math.round((scouted.length / pool.length) * 100) : 0;
console.log(`validate-scouting  net=${!NO_NET}  stale>${STALE_DAYS}d`);
console.log(`  COVERAGE  ${scouted.length}/${pool.length} skill players scouted (${pct}%)  ·  ${missing.length} missing`);
console.log(`    top50 ${tiers.top50.have}/${tiers.top50.of}   51-100 ${tiers["51-100"].have}/${tiers["51-100"].of}   101+ ${tiers["101+"].have}/${tiers["101+"].of}`);
console.log(`  VALIDATION  ${issues.length} brief issues · ${deadSources.length} dead sources · ${inconclusive.length} inconclusive · ${stale.length} stale (>${STALE_DAYS}d)`);
if (urlNote) console.log(`  ${urlNote}`);
for (const x of issues) console.log(`  ISSUE  ${x.id} ${x.name}: ${x.issue}`);
for (const d of deadSources) console.log(`  DEAD   ${d.id} ${d.name}: "${d.label}" ${d.code}  ${d.url}`);
for (const s of stale) console.log(`  STALE  ${s.id} ${s.name}: as_of ${s.as_of} (${s.age_days}d)`);
if (WORKLIST) {
  console.log(`  NEXT ${Math.min(WORKLIST, worklist.length)} TO SCOUT (pool order):`);
  for (const w of worklist.slice(0, WORKLIST)) console.log(`    #${w.rank} ${w.pos} ${w.id} ${w.name}  adp=${w.adp ?? "-"} bc=${w.bc ?? "-"}`);
}
console.log(`  flags -> ${path.relative(ROOT, FLAGS_PATH)}`);
