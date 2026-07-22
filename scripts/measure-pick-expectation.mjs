// Build data/pick-expectation.json — what a pick is actually WORTH, not what the prize is.
// Run on demand: node scripts/measure-pick-expectation.mjs
// Read-only GETs against Sleeper public REST. Requires data/flex-split.json.
//
// WHY THIS EXISTS
// ---------------
// data/positional-ladder.json measures the PRIZE: the ex-post #1 RB was worth +168 over
// replacement. Nobody can draft the ex-post #1. Every number in league-profile.md §7 has
// that flaw, stated but not fixed. This fixes it.
//
// Price = this league's own 900 draft picks (2020-25, 10-team snake, this exact format).
// National ADP would be the wrong ruler: pick 24 in a 12-team draft is a different
// decision from pick 24 here. Payoff = realized regular-season production re-scored in
// HBGBs format, minus the MEASURED replacement line (data/flex-split.json ranks).
//
// The gap between prize and expectation is the cost of not knowing in advance which
// player becomes the #1. That gap is the whole point of this file.
//
// HONESTY CONTRACT (project ground rule): fields we cannot derive are null with a reason.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "pick-expectation.json");
const TODAY = new Date().toISOString().slice(0, 10);
const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
const POS = ["QB", "RB", "WR", "TE"];
const NORM_WEEKS = 14;

const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

const scoring = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", "league-2025.json"), "utf8")).scoring_settings;
const REPL_RANK = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "flex-split.json"), "utf8")).replacement_rank;
const LADDER = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "positional-ladder.json"), "utf8")).ladder;

const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];
const rescore = (line) => SKILL_KEYS.reduce((p, k) => p + (line?.[k] != null && scoring[k] != null ? line[k] * scoring[k] : 0), 0);

console.log("Fetching player metadata...");
const players = await get("https://api.sleeper.app/v1/players/nfl");

// ---- realized production + replacement, per season ---------------------------
const totals = {}, repl = {};
for (const y of SEASONS) {
  const lg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `league-${y}.json`), "utf8"));
  const lastWeek = lg.settings.playoff_week_start - 1;
  const k = NORM_WEEKS / lastWeek;
  const files = await Promise.all(
    Array.from({ length: lastWeek }, (_, i) => get(`https://api.sleeper.app/v1/stats/nfl/regular/${y}/${i + 1}`).catch(() => ({})))
  );
  const t = new Map();
  for (const wk of files) for (const [id, line] of Object.entries(wk)) {
    if (!POS.includes(players[id]?.position)) continue;
    t.set(id, (t.get(id) ?? 0) + rescore(line));
  }
  for (const [id, v] of t) t.set(id, v * k);
  totals[y] = t;
  repl[y] = {};
  for (const p of POS) {
    const ranked = [...t.entries()].filter(([id]) => players[id]?.position === p).map(([, v]) => v).sort((a, b) => b - a);
    repl[y][p] = ranked[REPL_RANK[p] - 1] ?? 0;
  }
  console.log(`  ${y}: ${files.length} weeks, replacement ${POS.map((p) => `${p}=${repl[y][p].toFixed(0)}`).join(" ")}`);
}

// ---- join the league's own draft picks ---------------------------------------
const picks = [];
for (const y of SEASONS) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `draft-picks-${y}.json`), "utf8"));
  for (const p of (Array.isArray(raw) ? raw : raw.picks ?? [])) {
    const pos = p.metadata?.position;
    if (!POS.includes(pos)) continue; // K/DEF excluded, consistent with the ladder
    const pts = totals[y].get(p.player_id);
    picks.push({
      season: y, pickNo: p.pick_no, round: p.round, pos,
      playerId: p.player_id, name: `${p.metadata?.first_name ?? ""} ${p.metadata?.last_name ?? ""}`.trim(),
      points: pts ?? 0,                       // no stat row = drafted, produced nothing
      vor: (pts ?? 0) - repl[y][pos],
    });
  }
}

const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const f = (v, d = 0) => (Number.isFinite(v) ? (v > 0 ? "+" : "") + v.toFixed(d) : "n/a");

hr(`SAMPLE: ${picks.length} skill picks across ${SEASONS.length} drafts (K/DEF excluded)`);
console.log(`by position: ${POS.map((p) => `${p}=${picks.filter((x) => x.pos === p).length}`).join("  ")}`);

hr("THE GAP — prize vs. what the pick actually returned");
console.log("The ladder's 'elite' figure is the ex-post #1. These are the picks you'd actually make.\n");
console.log("pos   prize (ex-post #1)   E[VOR | picks 1-10]   capture rate   n");
for (const p of POS) {
  const key = p === "QB" ? "QB_rush" : p;
  const prize = LADDER[key]?.measured_season_repl;
  const early = picks.filter((x) => x.pos === p && x.pickNo <= 10);
  if (!early.length || prize == null) { console.log(`${p.padEnd(5)} ${String(prize ?? "n/a").padStart(17)}   ${"(none drafted top-10)".padStart(19)}`); continue; }
  const e = mean(early.map((x) => x.vor));
  console.log(`${p.padEnd(5)} ${f(prize).padStart(17)}   ${f(e).padStart(19)}   ${(100 * e / prize).toFixed(0).padStart(11)}%   ${early.length}`);
}
console.log("\ncapture rate = what an early pick at that position actually returned, as a share of");
console.log("the prize. The shortfall is the cost of not knowing which player becomes the #1.");

hr("EXPECTATION BY ROUND (VOR over the measured replacement line, 14-week terms)");
console.log("rd    n    mean    median      sd     bust%   startable%   best single outcome");
for (let r = 1; r <= 15; r++) {
  const sub = picks.filter((x) => x.round === r);
  if (!sub.length) continue;
  const v = sub.map((x) => x.vor);
  const bust = sub.filter((x) => x.vor <= 0).length / sub.length;
  const start = sub.filter((x) => x.vor > 0).length / sub.length;
  const best = sub.reduce((a, b) => (b.vor > a.vor ? b : a));
  console.log(
    `${String(r).padStart(2)} ${String(sub.length).padStart(5)} ${f(mean(v)).padStart(7)} ${f(median(v)).padStart(9)} ${sd(v).toFixed(0).padStart(7)}` +
    `   ${(100 * bust).toFixed(0).padStart(4)}%   ${(100 * start).toFixed(0).padStart(9)}%   ${f(best.vor).padStart(6)} ${best.name} (${best.season})`
  );
}
console.log("\nbust = returned at or below the replacement you could have had for free.");

hr("EXPECTATION BY ROUND x POSITION — the ex-ante version of the §7 ladder");
console.log("Which position is the better bet at each stage of the draft?\n");
const BUCKETS = [["rds 1-2", 1, 2], ["rds 3-4", 3, 4], ["rds 5-7", 5, 7], ["rds 8-10", 8, 10], ["rds 11-15", 11, 15]];
console.log("bucket      " + POS.map((p) => p.padStart(14)).join(""));
for (const [label, lo, hi] of BUCKETS) {
  const cells = POS.map((p) => {
    const sub = picks.filter((x) => x.pos === p && x.round >= lo && x.round <= hi);
    return sub.length < 5 ? `  n=${sub.length} thin`.padStart(14) : `${f(mean(sub.map((x) => x.vor)))} (n=${sub.length})`.padStart(14);
  });
  console.log(label.padEnd(12) + cells.join(""));
}

hr("HIT RATE — how often does a pick return a genuinely valuable season?");
console.log("A 'difference-maker' = VOR at or above half the prize for its position that season.\n");
console.log("bucket        n    difference-maker%   bust%    mean");
for (const [label, lo, hi] of BUCKETS) {
  const sub = picks.filter((x) => x.round >= lo && x.round <= hi);
  const dm = sub.filter((x) => {
    const key = x.pos === "QB" ? "QB_rush" : x.pos;
    const prize = LADDER[key]?.measured_season_repl;
    return prize != null && x.vor >= prize / 2;
  }).length;
  console.log(`${label.padEnd(12)} ${String(sub.length).padStart(4)}   ${(100 * dm / sub.length).toFixed(0).padStart(15)}%   ${(100 * sub.filter((x) => x.vor <= 0).length / sub.length).toFixed(0).padStart(4)}%   ${f(mean(sub.map((x) => x.vor))).padStart(6)}`);
}

fs.writeFileSync(OUT, JSON.stringify({
  _meta: {
    purpose: "Expected value of a draft pick (ex-ante), closing the gap left by positional-ladder.json's ex-post 'prize' figures.",
    generated: TODAY,
    price: "This league's own draft picks 2020-25 (10-team snake, this format) — not national ADP, which prices a different draft.",
    payoff: "Sleeper weekly stats re-scored in HBGBs scoring, regular season only, scaled to 14 weeks.",
    replacement_ranks: REPL_RANK,
    sample: `${picks.length} skill picks`,
    gaps: [
      "K and DEF excluded, consistent with positional-ladder.json.",
      "Picks are this room's choices, so the expectation curve reflects both pick position AND this room's drafting skill. It answers 'what has a pick here been worth to us', not 'what is a pick here worth in the abstract'.",
      "n=6 drafts. Round-level cells hold ~60 picks; round x position cells are much thinner and flagged where under 5.",
    ],
  },
  picks,
}, null, 2));
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
