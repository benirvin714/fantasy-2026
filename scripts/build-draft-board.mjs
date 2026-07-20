// Build data/site/draft-board.json — the Draft Day page's per-player data layer.
// Run on demand: node scripts/build-draft-board.mjs
// Read-only GETs against Sleeper public REST. Existing data/site consumers untouched.
//
// HONESTY CONTRACT (project ground rule): fields we cannot derive are null with a
// reason in meta.gaps — never filled with plausible values. Per-player flags use
// null = not yet researched, false = researched and clean.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "site", "draft-board.json");
const TODAY = new Date().toISOString().slice(0, 10);
const POOL_SIZE = 200; // skill players by Sleeper search_rank; plus all 32 DEF

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

console.log("Fetching Sleeper data (players, stats 2023-25, projections 2026)...");
const [players, s23, s24, s25, proj] = await Promise.all([
  get("https://api.sleeper.app/v1/players/nfl"),
  get("https://api.sleeper.app/v1/stats/nfl/regular/2023"),
  get("https://api.sleeper.app/v1/stats/nfl/regular/2024"),
  get("https://api.sleeper.app/v1/stats/nfl/regular/2025"),
  get("https://api.sleeper.app/v1/projections/nfl/regular/2026"),
]);
const scoring = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", "league-2025.json"), "utf8")).scoring_settings;
const events = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "site", "nfl-events.json"), "utf8")).events;

// ---- projection re-scoring with THIS league's settings ----------------------
// Skill stat keys map 1:1 onto scoring_settings keys. Kicker: projection aggregates
// 50+ as fgm_50p — league pays 5 (50-59) / 6 (60+); we score fgm_50p at 5 and note
// the 60+ bonus as unprojectable. DEF: only sack/int/fum_rec/blk_kick project;
// points-allowed tiers don't — DEF projections are marked low-confidence.
const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];
const K_KEYS = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "xpm", "xpmiss",
  "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49"];
const DEF_KEYS = ["sack", "int", "fum_rec", "blk_kick", "safe", "def_td"];

function rescore(p, pos) {
  if (!p) return null;
  let pts = 0;
  const keys = pos === "K" ? K_KEYS : pos === "DEF" ? DEF_KEYS : SKILL_KEYS;
  for (const k of keys) if (p[k] != null && scoring[k] != null) pts += p[k] * scoring[k];
  if (pos === "K" && p.fgm_50p != null) pts += p.fgm_50p * (scoring.fgm_50_59 ?? 5); // 60+ bonus unprojectable
  return +pts.toFixed(1);
}

// ---- availability ------------------------------------------------------------
// score = history component x age-curve component x current-status component.
// The injury-TYPE component (soft-tissue recurrence) is NOT derivable from Sleeper
// -> availability.partial = true until the research pass fills injury_history.
const AGE_CURVE = { RB: [27, 0.03], WR: [30, 0.03], TE: [30, 0.03], QB: [36, 0.02], K: [99, 0], DEF: [99, 0] };
function availability(id, pos, age, injuryStatus, yearsExp) {
  const seasons = [["2023", s23], ["2024", s24], ["2025", s25]];
  const gpBySeason = {};
  let inLeague = 0, missedSum = 0;
  for (const [yr, stats] of seasons) {
    const gp = stats[id]?.gp;
    if (gp != null) { gpBySeason[yr] = gp; inLeague++; missedSum += Math.max(0, 17 - gp); }
    else gpBySeason[yr] = null;
  }
  const histFactor = inLeague ? 1 - (missedSum / (inLeague * 17)) * 0.6 : null; // dampened: past absence part-predicts
  const [cliff, slope] = AGE_CURVE[pos] ?? [99, 0];
  const ageFactor = age && age >= cliff ? Math.max(0.85, 1 - (age - cliff + 1) * slope) : 1;
  const statusFactor = ["Out", "IR", "PUP", "Sus", "COV"].includes(injuryStatus) ? 0.85
    : injuryStatus === "Questionable" ? 0.97 : 1;
  const score = histFactor == null ? null : +(histFactor * ageFactor * statusFactor).toFixed(3);
  return {
    score, // null for rookies (no NFL history) — page must show "no data", not a guess
    expected_games: score == null ? null : +(17 * score).toFixed(1),
    games_played: gpBySeason,
    age, age_factor: +ageFactor.toFixed(3),
    current_injury_status: injuryStatus ?? null,
    injury_history: null, // GAP: soft-tissue/recurrence typing needs research pass
    partial: true,
    method: "1-(missed_rate*0.6) x age-curve x current-status; injury-type component missing",
  };
}

// ---- situation facts from the curated events feed ----------------------------
function situationFacts(name) {
  const last = name.split(" ").slice(-1)[0];
  return events
    .filter((e) => e.headline.includes(name) || e.detail.includes(name) ||
      (last.length > 4 && (e.headline.includes(last) || e.detail.includes(last))))
    .map((e) => ({ date: e.date, type: e.type, fact: e.headline, source: e.source?.url ?? null }));
}

// ---- build the pool ----------------------------------------------------------
const ranked = (posList, n) => Object.entries(players)
  .filter(([, p]) => posList.includes(p.position) && p.team && p.search_rank && p.search_rank < 9999999)
  .sort(([, a], [, b]) => a.search_rank - b.search_rank)
  .slice(0, n);
const skill = ranked(["QB", "RB", "WR", "TE"], POOL_SIZE);
// search_rank is unreliable for K (Aubrey ranks below journeymen) — select K by our own
// league-scored projection instead.
const kickers = Object.entries(players)
  .filter(([, p]) => p.position === "K" && p.team && p.active)
  .map((e) => [e[0], e[1], rescore(proj[e[0]], "K") ?? -1])
  .sort((a, b) => b[2] - a[2])
  .slice(0, 16)
  .map(([id, p]) => [id, p]);
const defs = Object.entries(players).filter(([id, p]) => p.position === "DEF" && id.length <= 3);

const rows = [...skill, ...kickers, ...defs].map(([id, p]) => {
  const pr = proj[id];
  const pos = p.position;
  const name = pos === "DEF" ? `${p.first_name} ${p.last_name}` : p.full_name;
  const pts = rescore(pr, pos);
  const adp = pr?.adp_half_ppr && pr.adp_half_ppr < 900 ? pr.adp_half_ppr : null;
  return {
    id, name, pos, team: p.team, age: p.age ?? null, years_exp: p.years_exp ?? null,
    rookie: p.years_exp === 0,
    projection: {
      pts, ppg: pts != null ? +(pts / 17).toFixed(1) : null,
      method: pos === "DEF" ? "partial: only sack/int/fum/blk project; points-allowed tiers do not — low confidence"
        : pos === "K" ? "league bands; 50+ scored at 5 (60+ bonus unprojectable)"
        : "Sleeper projected stat line re-scored with exact league settings",
      sleeper_half_ppr: pr?.pts_half_ppr ?? null, // sanity anchor, NOT the number to use
      updated: TODAY,
    },
    availability: availability(id, pos, p.age, p.injury_status, p.years_exp),
    situation: { modifier: null, facts: situationFacts(name) }, // modifier set by analysis pass, from facts only
    risk_flags: { suspension: null, contract: null, legal: null, researched: false, notes: [] },
    adp: { half_ppr: adp, updated: TODAY },
    context: { contract_year: null, rookie_capital: null, team_win_total: null, playoff_sos: null },
  };
});

const board = {
  generated: TODAY,
  scoring_basis: "HBGBs 2025 scoring_settings (data/raw/league-2025.json); re-verify at 2026 renewal",
  pool: `top ${POOL_SIZE} by Sleeper search_rank + 32 DEF`,
  gaps: [
    { field: "availability.injury_history", status: "missing", fill: "web research pass (soft-tissue/recurrence typing) for top ~100" },
    { field: "availability.score (rookies)", status: "null by design", fill: "no NFL history exists; page shows no-data" },
    { field: "situation.modifier", status: "unset", fill: "analysis pass over stored facts (facts only, no invented context)" },
    { field: "risk_flags.*", status: "unresearched (null)", fill: "web pass: suspensions/holdouts/legal; small result set" },
    { field: "context.contract_year", status: "missing", fill: "web (Spotrac/OTC), mostly static once pulled" },
    { field: "context.rookie_capital", status: "missing", fill: "one-time 2026 NFL draft table (web)" },
    { field: "context.team_win_total", status: "missing", fill: "Vegas win totals (web), refresh occasionally" },
    { field: "context.playoff_sos", status: "missing", fill: "derive after 2026 schedule pull + win totals land" },
    { field: "projection (DEF)", status: "low confidence", fill: "points-allowed tiers unprojectable; DEF is a streaming position here anyway" },
  ],
  players: rows,
};
fs.writeFileSync(OUT, JSON.stringify(board) + "\n");
const withProj = rows.filter((r) => r.projection.pts != null).length;
const withAdp = rows.filter((r) => r.adp.half_ppr != null).length;
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)}KB): ${rows.length} players, proj=${withProj}, adp=${withAdp}`);
const sanity = rows.filter((r) => r.projection.pts != null && r.projection.sleeper_half_ppr && !["K", "DEF"].includes(r.pos))
  .map((r) => Math.abs(r.projection.pts - r.projection.sleeper_half_ppr));
console.log(`skill re-score vs sleeper_half_ppr: max diff ${Math.max(...sanity).toFixed(1)}, mean ${(sanity.reduce((a, b) => a + b, 0) / sanity.length).toFixed(2)}`);
