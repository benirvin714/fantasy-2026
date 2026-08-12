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
//   RE-SCOUT — once coverage is complete, the live question becomes which briefs have been
//   overtaken by events. Evidence-driven (news / ADP drift / a narrow calendar backstop),
//   accumulated in data/rescout-queue.json. See the engine block below for why.
//
// REPORT ONLY. Unlike validate-events, this NEVER mutates draft-research.json — that is
// durable hand/agent work, so a dead link or bad enum is flagged for a human to fix, not
// silently stripped. Findings -> data/raw/scouting-flags.json, re-scout queue ->
// data/rescout-queue.json (the only two files it writes). Exit code is always 0.
//
// Usage:
//   node scripts/validate-scouting.mjs               coverage + validate + re-scout queue
//   node scripts/validate-scouting.mjs --no-net       skip URL liveness (offline / fast)
//   node scripts/validate-scouting.mjs --worklist 12  also print the next N unscouted (pool order)
//   node scripts/validate-scouting.mjs --stale-days 14 age past which a brief is "aged" (default 21)
//   node scripts/validate-scouting.mjs --rescout 30   how many queue rows to print (default 15)
//   node scripts/validate-scouting.mjs --stale-top 40 calendar backstop applies to top N by ADP (default 60)
//   node scripts/validate-scouting.mjs --adp-drift 8  min ADP move, in picks, to trigger (default 10, scales with ADP)

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

/* ---- RE-SCOUT ENGINE -------------------------------------------------------------------
   Coverage answers "who was never scouted". This answers the harder question once the sweep
   is complete: "whose brief has been overtaken by events?" Re-scouting 200 players on a
   calendar is infeasible, and a blanket age rule expires the whole board at once (every
   brief written in the same sweep shares an as_of), which is noise exactly when it matters.

   So the trigger is EVIDENCE, from three independent sources:
     news           a tagged event in nfl-events.json dated after the brief
     adp_drift      the market repriced him materially since the brief was written
     stale_backstop calendar age, but only near the top of the board where it's affordable

   PERSISTENT by design: the events feed ages items out at 14 days while briefs go stale at
   21, so a news trigger could appear and silently vanish before it was ever acted on. The
   queue therefore accretes on disk and an entry only clears when the brief's as_of advances
   past the trigger date, i.e. when the player was actually re-scouted. */
const QUEUE_PATH = path.join(ROOT, "data", "rescout-queue.json");
const ADP_HIST_PATH = path.join(ROOT, "data", "adp-history.json");
const ADP_DRIFT_MIN = parseInt(flagVal("--adp-drift", "10"), 10) || 10;
const STALE_TOP_N = parseInt(flagVal("--stale-top", "60"), 10) || 60;
// --drip N: print the next N queue entries the routine should actually re-scout this run.
// Capped and rank-limited on purpose: draining a few per run across the run-up to the draft
// beats one huge catch-up pass the day of. Non-target players past DRIP_MAX_RANK aren't worth
// tokens (10 teams x 16 roster spots = 160 picks, so past ~150 by ADP it is waiver fodder);
// shortlist targets from data/draft-targets.json are exempt and float first (see below).
const DRIP = parseInt(flagVal("--drip", "0"), 10) || 0;
const DRIP_MAX_RANK = parseInt(flagVal("--drip-rank", "150"), 10) || 150;
const THIN_RESERVE = parseInt(flagVal("--drip-thin", "1"), 10) || 0; // slots per run reserved for the thin_source quality sweep
// Your draft shortlist (data/draft-targets.json, optional): ids the drip re-scouts FIRST.
// They float ahead of the ADP-ordered queue and bypass DRIP_MAX_RANK, because a player you
// actually plan to draft is worth a fresh brief even if he sits past the general cutoff.
const TARGETS_PATH = path.join(ROOT, "data", "draft-targets.json");
let targetIds = new Set();
try { targetIds = new Set((JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8")).ids ?? []).map(String)); }
catch { /* absent/empty = no explicit targets; drip keeps its default top-of-board order */ }
const isTarget = (id) => targetIds.has(String(id));

// (4) thin_source: a one-time PRE-DRAFT quality sweep of the 100-200 range, where ~85% of
// briefs rested on national-analyst blurbs with no beat writer or coach quote. Flags an
// in-range brief whose sources include no coach/beat type so the drip (and /scout) re-scout
// it under the beat-first bar in the SKILL/command. Gated to as_of BEFORE the bar's adoption
// date so each player gets exactly ONE upgraded attempt and it never churns: once re-scouted
// (as_of >= the bar date) it stops triggering even where beat coverage genuinely doesn't exist.
const BEAT_BAR_DATE = flagVal("--beat-bar-since", "2026-08-11");
const THIN_MIN_ADP = 100, THIN_MAX_ADP = 180; // the draftable-plus part of the 100-200 range
const analystOnly = (b) => {
  const t = (b.sources ?? []).map((s) => s?.type).filter(Boolean);
  return t.length > 0 && !t.some((x) => x === "coach" || x === "beat");
};

let snaps = [];
try { snaps = JSON.parse(fs.readFileSync(ADP_HIST_PATH, "utf8")).snapshots ?? []; } catch { /* no history yet */ }
const latestSnap = snaps.length ? snaps[snaps.length - 1] : null;
const poolRank = new Map(pool.map((p, i) => [String(p.id), i + 1]));

const fresh = [];
for (const p of pool) {
  const b = briefOf(p.id);
  if (!b || !b.as_of) continue;
  const rank = poolRank.get(String(p.id)), adp = p.adp?.half_ppr ?? null;
  const base = { id: String(p.id), name: p.name, pos: p.pos, adp, rank };

  // (1) news dated after the brief
  const newer = (p.situation?.facts ?? []).filter((f) => f.date > b.as_of).sort((x, y) => y.date.localeCompare(x.date));
  if (newer.length) fresh.push({ ...base, reason: "news", trigger_date: newer[0].date, detail: String(newer[0].fact ?? "").slice(0, 150) });

  // (2) ADP drift since the brief. Threshold scales with draft position: a 10-pick move at
  //     pick 5 is a real repricing, the same move at pick 180 is noise.
  if (adp != null && latestSnap) {
    const baseSnap = snaps.find((s) => s.date >= b.as_of);
    const baseAdp = baseSnap?.adp?.[String(p.id)];
    if (baseSnap && baseAdp != null && baseSnap.date !== latestSnap.date) {
      const delta = +(adp - baseAdp).toFixed(1);
      const thr = Math.max(ADP_DRIFT_MIN, baseAdp * 0.2);
      if (Math.abs(delta) >= thr) fresh.push({ ...base, reason: "adp_drift", trigger_date: latestSnap.date,
        detail: `ADP ${baseAdp} -> ${adp} (${delta > 0 ? "+" : ""}${delta}) since ${baseSnap.date}; threshold ${thr.toFixed(1)}` });
    }
  }

  // (4) thin_source quality upgrade (pre-draft, one-time): in-range brief with no beat/coach source
  if (adp != null && adp >= THIN_MIN_ADP && adp <= THIN_MAX_ADP && b.prose != null
      && analystOnly(b) && b.as_of < BEAT_BAR_DATE) {
    fresh.push({ ...base, reason: "thin_source", trigger_date: BEAT_BAR_DATE,
      detail: "analyst-only sources (no beat/coach); re-scout to the beat-first bar" });
  }
}
// (3) calendar backstop, deliberately limited to the top of the board
for (const s of stale) {
  const rank = poolRank.get(String(s.id)) ?? 9999;
  if (rank > STALE_TOP_N) continue;
  const p = pool.find((x) => String(x.id) === String(s.id));
  fresh.push({ id: String(s.id), name: s.name, pos: p?.pos ?? null, adp: p?.adp?.half_ppr ?? null, rank,
    reason: "stale_backstop", trigger_date: TODAY, detail: `brief ${s.age_days}d old (>${STALE_DAYS}d) and inside the top ${STALE_TOP_N} by ADP` });
}

// merge with the persisted queue, then clear anything already re-scouted
let queue = { note: "", entries: [] };
try { queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); } catch { /* first run */ }
const keyOf = (e) => `${e.id}|${e.reason}`;
const merged = new Map((Array.isArray(queue.entries) ? queue.entries : []).map((e) => [keyOf(e), e]));
for (const f of fresh) {
  const prev = merged.get(keyOf(f));
  merged.set(keyOf(f), prev ? { ...prev, ...f, first_seen: prev.first_seen } : { ...f, first_seen: TODAY });
}
const resolved = [];
for (const [k, e] of [...merged]) {
  const b = briefOf(e.id);
  if (b?.as_of && b.as_of >= e.trigger_date) { merged.delete(k); resolved.push(e); }
}
const rescout = [...merged.values()].sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
const byReason = (r) => rescout.filter((e) => e.reason === r).length;
const inRange = (p) => { const a = p.adp?.half_ppr; return a != null && a >= 100 && a <= 200; };
const inRangeTotal = pool.filter(inRange).length;
const analystOnlyInRange = pool.filter((p) => { const b = briefOf(p.id); return b && b.prose != null && inRange(p) && analystOnly(b); }).length;
fs.writeFileSync(QUEUE_PATH, JSON.stringify({
  note: "Players whose scouting_brief has been overtaken by evidence (news, ADP drift, calendar backstop) or, pre-draft, rests on thin analyst-only sourcing (thin_source). Written by validate-scouting.mjs; an entry clears when the brief's as_of advances past trigger_date. Persistent so a news trigger survives the events feed's 14-day age-out.",
  updated: TODAY, open: rescout.length, entries: rescout,
}, null, 2) + "\n");

// ---- write flags + summary ------------------------------------------------------------
const flags = {
  generated_at: new Date().toISOString(),
  net: !NO_NET,
  coverage: { pool: pool.length, scouted: scouted.length, missing: missing.length, by_tier: tiers },
  worklist: worklist.slice(0, 60),
  rescout,
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
console.log(`  VALIDATION  ${issues.length} brief issues · ${deadSources.length} dead sources · ${inconclusive.length} inconclusive · ${stale.length} aged >${STALE_DAYS}d`);
if (urlNote) console.log(`  ${urlNote}`);
for (const x of issues) console.log(`  ISSUE  ${x.id} ${x.name}: ${x.issue}`);
for (const d of deadSources) console.log(`  DEAD   ${d.id} ${d.name}: "${d.label}" ${d.code}  ${d.url}`);
// The aged-brief list is deliberately NOT dumped: one sweep writes ~200 briefs on the same
// day, so they all age out together and printing them is noise. The re-scout queue below is
// the actionable subset.
console.log(`  RE-SCOUT  ${rescout.length} open  (news ${byReason("news")} · adp-drift ${byReason("adp_drift")} · stale-backstop ${byReason("stale_backstop")} · thin-source ${byReason("thin_source")})${resolved.length ? ` · ${resolved.length} cleared this run` : ""}`);
console.log(`  QUALITY   ${analystOnlyInRange}/${inRangeTotal} briefs in ADP 100-200 are analyst-only (no beat/coach source); the thin_source sweep drains the <=${THIN_MAX_ADP} ones to the beat-first bar`);
if (snaps.length < 2) console.log(`    adp-drift: dormant until 2+ daily ADP snapshots exist (have ${snaps.length}); the daily rebuild adds one per day`);
const RESCOUT_SHOW = parseInt(flagVal("--rescout", "15"), 10) || 15;
for (const e of rescout.slice(0, RESCOUT_SHOW))
  console.log(`    #${e.rank ?? "-"} ${e.pos ?? "?"} ${e.name}  adp=${e.adp ?? "-"}  [${e.reason} ${e.trigger_date}]  ${e.detail}`);
if (rescout.length > RESCOUT_SHOW) console.log(`    ... +${rescout.length - RESCOUT_SHOW} more (full list in rescout-queue.json)`);

// --drip N: the bounded nightly work order. Deliberately computed here rather than left to the
// routine's judgement, so "which players tonight" is deterministic and reviewable.
if (DRIP) {
  // One slot per PLAYER, not per trigger. A player can legitimately hold several open entries
  // (news AND stale_backstop, say) because each clears independently, but re-scouting him once
  // resolves all of them, and letting him take two of three nightly slots wastes the budget.
  const REASON_RANK = { news: 0, adp_drift: 1, stale_backstop: 2, thin_source: 3 };
  // Targets jump the queue and bypass the rank cap. Then time-sensitive reasons (news, adp,
  // stale) drain by rank, and the pre-draft thin_source quality sweep fills only the leftover
  // capacity, so a hot news item is never starved by the sourcing upgrade.
  const eligible = rescout
    .filter((e) => isTarget(e.id) || (e.rank ?? 9999) <= DRIP_MAX_RANK)
    .sort((a, b) =>
      (isTarget(a.id) ? 0 : 1) - (isTarget(b.id) ? 0 : 1)
      || (a.reason === "thin_source" ? 1 : 0) - (b.reason === "thin_source" ? 1 : 0)
      || (a.rank ?? 9999) - (b.rank ?? 9999)
      || (REASON_RANK[a.reason] ?? 9) - (REASON_RANK[b.reason] ?? 9));
  const reasonsById = new Map();
  for (const e of eligible) reasonsById.set(e.id, [...(reasonsById.get(e.id) ?? []), e.reason]);
  // Reserve a slot or two for the thin_source quality sweep so it makes steady progress even on
  // busy news days: news fills the rest, and a player who is BOTH drains once (as news) and clears both.
  const RESERVE = Math.min(THIN_RESERVE, DRIP);
  const seen = new Set();
  const take = (list, n) => {
    const out = [];
    for (const e of list) {
      if (out.length >= n) break;
      if (seen.has(e.id)) continue;
      seen.add(e.id); out.push(e);
    }
    return out;
  };
  const main = take(eligible, DRIP - RESERVE);                                   // news-first (demotion sort)
  const thin = take(eligible.filter((e) => e.reason === "thin_source"), RESERVE); // guaranteed quality slots
  const drip = [...main, ...thin];
  const tgtInQueue = rescout.filter((e) => isTarget(e.id)).length;
  console.log(`  DRIP  re-scout these ${drip.length} this run (cap ${DRIP}${RESERVE ? `, ${RESERVE} reserved for the thin_source quality sweep` : ""}, ADP rank <= ${DRIP_MAX_RANK}${targetIds.size ? `; ${targetIds.size} shortlist targets float first + bypass the cap` : ""}; ${rescout.length} open across ${new Set(rescout.map((e) => e.id)).size} players${tgtInQueue ? `, ${tgtInQueue} on your shortlist` : ""}):`);
  if (!drip.length) console.log("    none. Queue is empty or everything left is outside the draftable range. Do NOT scout anything.");
  for (const e of drip) {
    const all = reasonsById.get(e.id) ?? [e.reason];
    const also = all.length > 1 ? `  (also: ${all.filter((r) => r !== e.reason).join(", ")}; one re-scout clears all)` : "";
    console.log(`    ${isTarget(e.id) ? "★ " : ""}id=${e.id} #${e.rank} ${e.pos} ${e.name}  [${e.reason} ${e.trigger_date}]  ${e.detail}${also}`);
  }
}
if (WORKLIST) {
  console.log(`  NEXT ${Math.min(WORKLIST, worklist.length)} TO SCOUT (pool order):`);
  for (const w of worklist.slice(0, WORKLIST)) console.log(`    #${w.rank} ${w.pos} ${w.id} ${w.name}  adp=${w.adp ?? "-"} bc=${w.bc ?? "-"}`);
}
console.log(`  flags -> ${path.relative(ROOT, FLAGS_PATH)}  ·  queue -> ${path.relative(ROOT, QUEUE_PATH)}`);
