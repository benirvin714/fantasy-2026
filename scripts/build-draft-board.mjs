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
/* ---- bye weeks, DERIVED from the NFL schedule (not a hand-kept table) ----
   Sleeper's player objects carry no bye week, so it comes from the regular-season schedule at
   api.sleeper.app/schedule/nfl/regular/<season> (undocumented but public, read-only GET): a team's
   bye is the week it appears in no game. Validated on the way through — 32 teams, 18 weeks, and
   every team must land exactly one bye, or the map is thrown away rather than shipped half-right.
   Deriving beats a hand-kept table because it self-updates at the next rebuild and can't drift. */
async function byeWeeks(season) {
  try {
    const games = await get(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
    const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
    const teams = [...new Set(games.flatMap((g) => [g.home, g.away]))];
    const map = {};
    for (const t of teams) {
      const played = new Set(games.filter((g) => g.home === t || g.away === t).map((g) => g.week));
      const off = weeks.filter((w) => !played.has(w));
      if (off.length !== 1) throw new Error(`${t} has ${off.length} bye weeks, expected 1`);
      map[t] = off[0];
    }
    if (teams.length !== 32) throw new Error(`${teams.length} teams in the schedule, expected 32`);
    console.log(`Bye weeks: derived for ${teams.length} teams from the ${season} schedule (weeks ${Math.min(...Object.values(map))}-${Math.max(...Object.values(map))}).`);
    return map;
  } catch (e) {
    console.warn(`Bye weeks: UNAVAILABLE (${e.message}) — every player will carry bye: null and the board will say so.`);
    return {};
  }
}
const byes = await byeWeeks(2026);

const scoring = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", "league-2026.json"), "utf8")).scoring_settings;
const events = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "site", "nfl-events.json"), "utf8")).events;
// Durable hand-researched overlay (risk flags, injury typing, ADP commentary). Merged in so a
// rebuild for fresh ADP never wipes research. Missing = still null (honest "not researched").
const researchPath = path.join(ROOT, "data", "draft-research.json");
const researchFile = fs.existsSync(researchPath) ? JSON.parse(fs.readFileSync(researchPath, "utf8")) : {};
const research = researchFile.players ?? {};
const cleanIds = new Set(researchFile.clean_researched?.ids ?? []);

// ---- fftiers overlay: Boris Chen half-PPR consensus rank + tiers (build-time fetch) ----------
// Source: fftiers (github.com/borisachen/fftiers) via his S3 output. FantasyPros expert consensus,
// GMM-clustered tiers, in MY league's half-PPR format. Baked in at build time (the deployed page's
// CSP blocks external fetch). Degrades to null on fetch failure — never fabricated.
const FFTIERS_URL = "https://s3-us-west-1.amazonaws.com/fftiers/out/weekly-ALL-HALF-PPR.csv";
const normName = (s) => String(s ?? "").toLowerCase()
  .replace(/\./g, "").replace(/'/g, "")
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const parseCsvLine = (line) => {
  const out = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
};
let fftMap = new Map(), fftStatus = "ok";
try {
  const csv = await (await fetch(FFTIERS_URL)).text();
  const lines = csv.trim().split("\n");
  const header = parseCsvLine(lines[0]).map((h) => h.replace(/"/g, ""));
  const col = (n) => header.indexOf(n);
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const name = c[col("Player.Name")];
    if (!name) continue;
    fftMap.set(normName(name), {
      rank: +c[col("Rank")], tier: +c[col("Tier")], pos: c[col("Position")],
      avg_rank: +c[col("Avg.Rank")], best_rank: +c[col("Best.Rank")],
      worst_rank: +c[col("Worst.Rank")], std_dev: +c[col("Std.Dev")],
    });
  }
} catch (e) { fftStatus = `fetch failed: ${e.message}`; }

// ---- DynastyProcess player-ID crosswalk: sleeper_id -> external IDs + draft capital ----------
// Source: github.com/DynastyProcess/data (db_playerids.csv, GPL-3.0, daily auto-pipeline). This is
// the ENABLING layer for ID-based joins — the eventual consensus-anchor FP-ECR feed and any nflverse
// historical-stat join key off gsis_id/pfr_id instead of fragile name matching. IDs + draft capital
// are slow-changing, so we keep a LOCAL cache (data/raw, gitignored) and prefer it on a scrape
// outage; total failure degrades to null IDs, never fabricated (honesty contract).
const PIDS_URL = "https://raw.githubusercontent.com/DynastyProcess/data/master/files/db_playerids.csv";
const PIDS_CACHE = path.join(ROOT, "data", "raw", "db_playerids.csv");
let pidsBySleeper = new Map(), pidsStatus = "ok";
{
  let csv = null;
  try {
    csv = await (await fetch(PIDS_URL)).text();
    if (!csv || csv.length < 100000 || !csv.includes("sleeper_id")) throw new Error("payload too small / wrong shape");
    fs.writeFileSync(PIDS_CACHE, csv); // refresh the local cache on a good fetch
  } catch (e) {
    if (fs.existsSync(PIDS_CACHE)) { csv = fs.readFileSync(PIDS_CACHE, "utf8"); pidsStatus = `fetch failed, using cache: ${e.message}`; }
    else { csv = null; pidsStatus = `unavailable (no cache): ${e.message}`; }
  }
  if (csv) {
    const lines = csv.trim().split("\n");
    const h = parseCsvLine(lines[0]).map((x) => x.replace(/"/g, ""));
    const ci = (n) => h.indexOf(n);
    const na = (v) => (v == null || v === "" || v === "NA") ? null : v;
    const numOr = (v) => na(v) != null && !isNaN(+v) ? +v : null;
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const sid = na(c[ci("sleeper_id")]);
      if (!sid) continue;
      pidsBySleeper.set(String(sid), {
        fantasypros: na(c[ci("fantasypros_id")]), gsis: na(c[ci("gsis_id")]),
        pfr: na(c[ci("pfr_id")]), espn: na(c[ci("espn_id")]),
        draft_year: numOr(c[ci("draft_year")]), draft_round: numOr(c[ci("draft_round")]),
        draft_pick: numOr(c[ci("draft_pick")]), draft_ovr: numOr(c[ci("draft_ovr")]),
      });
    }
  }
}

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
// Match events to a player by FULL NAME, never a bare surname substring — a surname
// substring let "Zac Robinson" (a coach), "A.J. Brown", "Daniel Jones", "Sanders/Watson"
// bleed onto the wrong player. A bare surname is allowed only when unambiguous: not
// shared by another pooled player, not a team nickname, and not preceded by a different
// first name. DEF matches its team nickname. Sets are filled once the pool is built.
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let sharedSurnames = new Set(), teamNicknames = new Set();
const precededByOtherName = (text, last, first) => {
  // A name-like token (Cap + lowercase: "Zac", "Daniel", "Sanders") right before the surname
  // means a different person ("Zac Robinson", "Sanders/Watson"). All-caps tokens (ADP, GM, team
  // codes) aren't names; "." is kept OUT of the separator so a sentence break ("…ADP. Kamara…")
  // never reads as an attached first name.
  const re = new RegExp(`([A-Z][a-z][A-Za-z.'’-]*)[\\s/-]+${reEsc(last)}\\b`, "g");
  let m;
  while ((m = re.exec(text))) if (m[1] !== first) return true; // "<OtherFirst> <surname>"
  return false;
};
function situationFacts(name, pos) {
  const inText = (e) => `${e.headline}\n${e.detail}`;
  const fact = (e) => ({ date: e.date, type: e.type, fact: e.headline, source: e.source?.url ?? null });
  // DEF: the entity is a team; players[] tags cover skill players, so match the team nickname.
  if (pos === "DEF") {
    const nick = name.split(" ").slice(-1)[0];
    return events.filter((e) => new RegExp(`\\b${reEsc(nick)}\\b`).test(inText(e))).map(fact);
  }
  const nn = normName(name), parts = name.split(" "), last = parts[parts.length - 1], first = parts[0];
  return events.filter((e) => {
    // Explicit players[] tag is authoritative for skill players — set by the nfl-daily-events
    // routine, so matching is exact (no surname collisions, no coach/team false positives).
    if (Array.isArray(e.players)) return e.players.some((pn) => normName(pn) === nn);
    // Fallback for untagged events only: full name, then a safe bare-surname heuristic.
    const text = inText(e);
    if (text.includes(name)) return true;
    if (last.length <= 4) return false;
    if (sharedSurnames.has(last) || teamNicknames.has(last)) return false;
    if (!new RegExp(`\\b${reEsc(last)}\\b`).test(text)) return false;
    if (precededByOtherName(text, last, first)) return false;
    return true;
  }).map(fact);
}

// ---- ceiling / spike-week metric (weekly variance) --------------------------
// Re-score every player-week 2023-25 in league format; a "spike week" = finishing
// at/above the position's top-SPIKE_RANK weekly line. spike_week_rate = share of a
// player's weeks that spiked. DISPLAY ONLY — ceiling is not an input to value, the
// edge, or the ranking (site/draft.js keeps it strictly descriptive). Degrades to
// null (with reason) on fetch failure or thin sample (rookies) — never fabricated.
//
// This metric was originally justified by league-profile.md §10 ("draft for spike
// weeks"). §10 has since been TESTED AND RETRACTED: across 60 team-seasons, weekly
// variance predicts neither wins (t = -0.85) nor playoff qualification (t = +0.26)
// once scoring level is controlled (data/ceiling-vs-floor.json). Nothing changed here
// because nothing needed to — the column never fed value. Two things the retraction
// does NOT cover: variance inside the weeks 15-17 tournament (untested, n=6), and the
// bench-tier "upside among near-replacement darts" case, which is about option value
// under weekly waivers rather than held variance and was not measured.
const SPIKE_RANK = 5;        // a spike week ~ a top-5 weekly finish at the position
const MIN_CEIL_WEEKS = 10;   // fewer real games than this -> null (no stable estimate)
const CEIL_POS = ["QB", "RB", "WR", "TE"];

// ---- shared weekly pull (2023-25) --------------------------------------------
// One fetch, two consumers: the ceiling metric below and the historical-usage panel
// further down. 54 week-files; each is a { player_id: statline } map.
const YEARS = ["2023", "2024", "2025"], WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);
let weeklyByYear = null, weeklyStatus = "ok";
{
  const t0 = Date.now();
  try {
    const flat = await Promise.all(
      YEARS.flatMap((y) => WEEKS.map((w) =>
        get(`https://api.sleeper.app/v1/stats/nfl/regular/${y}/${w}`).catch(() => ({}))))
    );
    weeklyByYear = Object.fromEntries(YEARS.map((y, i) => [y, flat.slice(i * WEEKS.length, (i + 1) * WEEKS.length)]));
    console.log(`weekly: ${flat.length} week-files fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) { weeklyStatus = `weekly fetch failed: ${e.message}`; console.log(`weekly: ${weeklyStatus}`); }
}

let ceilingById = new Map(), ceilingPosAvg = {}, ceilingBoomLine = {}, ceilingStatus = weeklyStatus === "ok" ? "ok" : weeklyStatus;
try {
  if (!weeklyByYear) throw new Error(weeklyStatus);
  const weekly = YEARS.flatMap((y) => weeklyByYear[y]);
  const posOf = (id) => players[id]?.position ?? null;
  const perPlayer = new Map();   // id -> [weekly league pts]
  const perPosWeek = new Map();  // `${pos}|${weekIdx}` -> [all scores that week]
  weekly.forEach((wk, weekIdx) => {
    for (const [id, line] of Object.entries(wk)) {
      const pos = posOf(id);
      if (!CEIL_POS.includes(pos) || line.gp == null || line.gp < 1) continue;
      const pts = rescore(line, pos);
      if (pts == null) continue;
      if (!perPlayer.has(id)) perPlayer.set(id, []);
      perPlayer.get(id).push(pts);
      const k = `${pos}|${weekIdx}`;
      if (!perPosWeek.has(k)) perPosWeek.set(k, []);
      perPosWeek.get(k).push(pts);
    }
  });
  // positional boom line = average of the SPIKE_RANK-th best score across all weeks
  for (const pos of CEIL_POS) {
    const nths = [];
    for (const [k, arr] of perPosWeek) {
      if (!k.startsWith(pos + "|") || arr.length < SPIKE_RANK) continue;
      nths.push([...arr].sort((a, b) => b - a)[SPIKE_RANK - 1]);
    }
    ceilingBoomLine[pos] = nths.length ? +(nths.reduce((a, b) => a + b, 0) / nths.length).toFixed(1) : null;
  }
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const posRates = Object.fromEntries(CEIL_POS.map((p) => [p, []]));
  for (const [id, pts] of perPlayer) {
    const pos = posOf(id), boom = ceilingBoomLine[pos];
    if (pts.length < MIN_CEIL_WEEKS || boom == null) { ceilingById.set(id, null); continue; }
    const rate = +(pts.filter((v) => v >= boom).length / pts.length).toFixed(3);
    ceilingById.set(id, {
      spike_week_rate: rate, boom_line: boom,
      boom_pts: +pct(pts, 0.85).toFixed(1), floor_pts: +pct(pts, 0.15).toFixed(1),
      sample_weeks: pts.length,
      method: `share of ${pts.length} games (2023-25) at/above the ${pos} top-${SPIKE_RANK} weekly line (${boom} pts)`,
    });
    posRates[pos].push(rate);
  }
  for (const pos of CEIL_POS) {
    const a = posRates[pos];
    ceilingPosAvg[pos] = a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null;
  }
  console.log(`ceiling: ${weekly.length} weeks scored, ${ceilingById.size} players, boom lines ${JSON.stringify(ceilingBoomLine)}, pos avg ${JSON.stringify(ceilingPosAvg)}`);
} catch (e) { ceilingStatus = `weekly compute failed: ${e.message}`; console.log(`ceiling: ${ceilingStatus}`); }

// ---- historical usage: evidence + confidence input, NEVER a value input ------
// Role of this block (design of record, plans/handoff-stats-and-renewal.md): Sleeper's
// projection ALREADY prices raw target share and age, so feeding usage back in as a value
// multiplier would double-count. Usage is therefore (a) transparent evidence in the panel,
// (b) a role-stability input to the client's confidence band, (c) a trajectory/override
// signal. It never touches asset value or the edge.
//
// Team denominators (target share, touch share) need per-season team totals, which Sleeper
// does not expose and the players endpoint can't supply (its `team` is the CURRENT team, so
// it misattributes past seasons for anyone who moved). Solution: within a single week every
// player on a team carries an IDENTICAL (tm_off_snp, tm_def_snp, tm_st_snp) triple, so that
// triple is a per-week team fingerprint. Grouping by it yields team totals without any roster
// history and stays correct through mid-season trades.
//
// Two source defects this handles explicitly rather than absorbing:
//   1. Fingerprint collisions. Twice in 54 weeks (2023 wk13, 2024 wk14) two teams posted an
//      identical snap triple, merging into one ~96-player cluster (a real one is ~46-50). Left
//      alone that halves those teams' shares for the week, so oversized clusters are detected
//      and those weeks are dropped from the SHARE denominators.
//   2. Missing snap data. 2025 wk18 carries tm_off_snp for only 4 teams. So a game is counted
//      from any line with gp>=1, and only the share/snap components require a valid fingerprint.
// Per-game rates therefore run over games played, while shares run over share-valid weeks —
// which is why every season carries both `g` and `share_g`.
const MERGED_CLUSTER = 70;   // a real team-week cluster is ~46-50 lines; >= this means two merged
const USAGE_POS = ["QB", "RB", "WR", "TE"];
const MIN_SEASON_G = 8;   // a season counts toward the multi-year direction only at/above this
const TREND_BLOCK = 4;    // within-season = last 4 games played vs first 4
// multi-year direction: [metric, threshold to call a direction at all]
const DIR_METRIC = { WR: ["target_share", 0.030], TE: ["target_share", 0.030], RB: ["touch_share", 0.040], QB: ["rush_att_pg", 1.5] };
// within-season trend: [metric, min absolute per-game delta, min relative delta]
const TREND_METRIC = { WR: ["tgt_pg", 1.5, 0.20], TE: ["tgt_pg", 1.5, 0.20], RB: ["touch_pg", 2.0, 0.20], QB: ["rush_att_pg", 1.5, 0.25] };
const CR_MIN_TGT = 16;    // catch-rate arrow only when EACH half clears this target volume
const CR_DELTA = 0.07;
let usageById = new Map(), usageStatus = weeklyStatus === "ok" ? "ok" : weeklyStatus, clusterWarn = [];
try {
  if (!weeklyByYear) throw new Error(weeklyStatus);
  const acc = new Map();   // id -> { year -> season aggregate }
  const wk25 = new Map();  // id -> [{ w, tgt, rec, touch, ru }] for the within-season trend
  for (const y of YEARS) {
    weeklyByYear[y].forEach((wk, wi) => {
      const fp = (l) => `${l.tm_off_snp}|${l.tm_def_snp}|${l.tm_st_snp}`;
      const teams = new Map();
      for (const l of Object.values(wk)) {
        if (l.tm_off_snp == null) continue;
        const t = teams.get(fp(l)) ?? { tgt: 0, rz: 0, ru: 0, n: 0 };
        t.tgt += l.rec_tgt ?? 0; t.rz += l.rec_rz_tgt ?? 0; t.ru += l.rush_att ?? 0; t.n++;
        teams.set(fp(l), t);
      }
      const merged = [...teams.values()].filter((t) => t.n >= MERGED_CLUSTER).length;
      if (merged) clusterWarn.push(`${y} wk${wi + 1}: ${merged} collided cluster(s) dropped from share denominators`);
      for (const [id, l] of Object.entries(wk)) {
        if (!(l.gp >= 1)) continue;
        if (!USAGE_POS.includes(players[id]?.position)) continue;
        const t0 = l.tm_off_snp != null ? teams.get(fp(l)) : null;
        const t = t0 && t0.n < MERGED_CLUSTER ? t0 : null;   // null = no trustworthy team denominator this week
        let byYear = acc.get(id); if (!byYear) { byYear = {}; acc.set(id, byYear); }
        const a = byYear[y] ?? (byYear[y] = { g: 0, shareG: 0, snp: 0, tm_snp: 0, tgt: 0, rec: 0, air: 0, rz: 0, ru: 0, ruz: 0, ruyd: 0, pa: 0, s_tgt: 0, s_rz: 0, s_touch: 0, t_tgt: 0, t_rz: 0, t_touch: 0 });
        a.g++;
        a.tgt += l.rec_tgt ?? 0; a.rec += l.rec ?? 0; a.air += l.rec_air_yd ?? 0; a.rz += l.rec_rz_tgt ?? 0;
        a.ru += l.rush_att ?? 0; a.ruz += l.rush_rz_att ?? 0; a.ruyd += l.rush_yd ?? 0; a.pa += l.pass_att ?? 0;
        if (t) {
          a.shareG++; a.snp += l.off_snp ?? 0; a.tm_snp += l.tm_off_snp ?? 0;
          a.s_tgt += l.rec_tgt ?? 0; a.s_rz += l.rec_rz_tgt ?? 0; a.s_touch += (l.rush_att ?? 0) + (l.rec_tgt ?? 0);
          a.t_tgt += t.tgt; a.t_rz += t.rz; a.t_touch += t.tgt + t.ru;
        }
        if (y === "2025") {
          const arr = wk25.get(id) ?? [];
          arr.push({ w: wi + 1, tgt: l.rec_tgt ?? 0, rec: l.rec ?? 0, touch: (l.rush_att ?? 0) + (l.rec_tgt ?? 0), ru: l.rush_att ?? 0 });
          wk25.set(id, arr);
        }
      }
    });
  }
  const MIN_SHARE_G = 4;    // fewer share-valid weeks than this -> no share claimed
  const sh = (a, n, d) => (a.shareG >= MIN_SHARE_G && d ? +(n / d).toFixed(3) : null);
  const pg = (n, g) => (g ? +(n / g).toFixed(1) : null);
  const metrics = (a, pos) => {
    const m = { g: a.g, share_g: a.shareG, snap_share: sh(a, a.snp, a.tm_snp) };
    if (pos === "WR" || pos === "TE") Object.assign(m, {
      target_share: sh(a, a.s_tgt, a.t_tgt), tgt_pg: pg(a.tgt, a.g),
      catch_rate: a.tgt ? +(a.rec / a.tgt).toFixed(3) : null,
      adot: a.tgt ? +(a.air / a.tgt).toFixed(1) : null,
      rz_tgt: a.rz, rz_tgt_share: sh(a, a.s_rz, a.t_rz),
    });
    if (pos === "RB") Object.assign(m, {
      touch_share: sh(a, a.s_touch, a.t_touch), touch_pg: pg(a.ru + a.tgt, a.g),
      rush_att_pg: pg(a.ru, a.g), tgt_pg: pg(a.tgt, a.g),
      rush_rz_att: a.ruz, target_share: sh(a, a.s_tgt, a.t_tgt),
    });
    if (pos === "QB") Object.assign(m, {
      pass_att_pg: pg(a.pa, a.g), rush_att_pg: pg(a.ru, a.g), rush_yd: a.ruyd,
    });
    return m;
  };
  for (const [id, byYear] of acc) {
    const pos = players[id]?.position;
    const seasons = {};
    for (const y of YEARS) if (byYear[y]) seasons[y] = metrics(byYear[y], pos);
    // --- multi-year direction: GATED. Needs >= 2 seasons at >= MIN_SEASON_G games, and a
    // delta past the threshold; otherwise "steady" or an honest null — never a fake arrow.
    const [dm, dthr] = DIR_METRIC[pos] ?? [];
    const qual = YEARS.filter((y) => seasons[y] && seasons[y].g >= MIN_SEASON_G && seasons[y][dm] != null);
    let direction = null;
    if (dm && qual.length >= 2) {
      const from = qual[0], to = qual[qual.length - 1];
      const d = +(seasons[to][dm] - seasons[from][dm]).toFixed(3);
      direction = {
        metric: dm, from: { year: from, value: seasons[from][dm], g: seasons[from].g },
        to: { year: to, value: seasons[to][dm], g: seasons[to].g },
        delta: d, direction: d >= dthr ? "up" : d <= -dthr ? "down" : "steady", threshold: dthr,
      };
    } else if (dm) {
      direction = { metric: dm, direction: null, reason: `only ${qual.length} season(s) with ${MIN_SEASON_G}+ games — no direction claimed` };
    }
    // --- within-season trend (2025): last 4 games played vs first 4. Needs 2*TREND_BLOCK
    // games so the halves never overlap. Catch rate gets an arrow only at real target volume.
    const [tm, tabs, trel] = TREND_METRIC[pos] ?? [];
    const lines = (wk25.get(id) ?? []).sort((a, b) => a.w - b.w);
    let trend = null;
    if (tm && lines.length >= TREND_BLOCK * 2) {
      const first = lines.slice(0, TREND_BLOCK), last = lines.slice(-TREND_BLOCK);
      const key = tm === "tgt_pg" ? "tgt" : tm === "touch_pg" ? "touch" : "ru";
      const avg = (arr) => +(arr.reduce((s, l) => s + l[key], 0) / arr.length).toFixed(1);
      const fv = avg(first), lv = avg(last), d = +(lv - fv).toFixed(1);
      const rel = fv > 0 ? Math.abs(d) / fv : 1;
      let cr = null;
      if ((pos === "WR" || pos === "TE")) {
        const ft = first.reduce((s, l) => s + l.tgt, 0), lt = last.reduce((s, l) => s + l.tgt, 0);
        if (ft >= CR_MIN_TGT && lt >= CR_MIN_TGT) {
          const fc = first.reduce((s, l) => s + l.rec, 0) / ft, lc = last.reduce((s, l) => s + l.rec, 0) / lt;
          const cd = +(lc - fc).toFixed(3);
          cr = { first: +fc.toFixed(3), last: +lc.toFixed(3), delta: cd, direction: cd >= CR_DELTA ? "up" : cd <= -CR_DELTA ? "down" : "steady" };
        } else cr = { direction: null, reason: `under ${CR_MIN_TGT} targets in a 4-game block — catch-rate trend not claimed` };
      }
      trend = {
        season: "2025", metric: tm, games: lines.length,
        first: { games: TREND_BLOCK, per_game: fv, weeks: `${first[0].w}-${first[TREND_BLOCK - 1].w}` },
        last: { games: TREND_BLOCK, per_game: lv, weeks: `${last[0].w}-${last[TREND_BLOCK - 1].w}` },
        delta: d, direction: (Math.abs(d) >= tabs && rel >= trel) ? (d > 0 ? "up" : "down") : "steady",
        gate: `|Δ| >= ${tabs}/g and >= ${Math.round(trel * 100)}% relative`,
        catch_rate: cr,
      };
    } else if (tm) {
      trend = { season: "2025", metric: tm, direction: null, games: lines.length, reason: `${lines.length} games played — needs ${TREND_BLOCK * 2} for a first-4 vs last-4 split` };
    }
    // last season's ACTUAL league-scored production — the baseline the projection is checked against
    const act = s25[id];
    const actPts = act ? rescore(act, pos) : null;
    usageById.set(id, {
      seasons, direction, trend,
      last_season: actPts != null && act.gp ? { year: 2025, pts: actPts, g: act.gp, ppg: +(actPts / act.gp).toFixed(1) } : null,
      method: "weekly stats 2023-25; team totals from the per-week (tm_off_snp,tm_def_snp,tm_st_snp) fingerprint; shares measured over games played",
    });
  }
  console.log(`usage: ${usageById.size} players, ${clusterWarn.length} weeks with a possible team-fingerprint collision${clusterWarn.length ? ` (${clusterWarn.slice(0, 5).join("; ")})` : ""}`);
} catch (e) { usageStatus = `usage compute failed: ${e.message}`; console.log(`usage: ${usageStatus}`); }

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

// Fill the situationFacts disambiguation sets from the pool: a surname shared by >1 pooled
// skill player (Robinson, Brown, Taylor…) or equal to a team nickname can't match on surname
// alone — require the full name so events never bleed across same-surname players.
{
  const surCount = {};
  for (const [, p] of skill) { const ln = (p.full_name ?? "").split(" ").slice(-1)[0]; if (ln) surCount[ln] = (surCount[ln] ?? 0) + 1; }
  sharedSurnames = new Set(Object.entries(surCount).filter(([, n]) => n > 1).map(([s]) => s));
  teamNicknames = new Set(defs.map(([, p]) => p.last_name).filter(Boolean));
}

const rows = [...skill, ...kickers, ...defs].map(([id, p]) => {
  const pr = proj[id];
  const pos = p.position;
  const name = pos === "DEF" ? `${p.first_name} ${p.last_name}` : p.full_name;
  const pts = rescore(pr, pos);
  const adp = pr?.adp_half_ppr && pr.adp_half_ppr < 900 ? pr.adp_half_ppr : null;
  const avail = availability(id, pos, p.age, p.injury_status, p.years_exp);
  // DynastyProcess ID crosswalk + draft capital (null for DEF/unmatched). ids = the clean join key
  // for future ID-based sources; rookie_capital fills a context gap straight from the crosswalk.
  const ext = pidsBySleeper.get(String(id)) ?? null;
  const rookieCap = (p.years_exp === 0 && ext?.draft_ovr != null)
    ? { year: ext.draft_year, round: ext.draft_round, pick: ext.draft_pick, overall: ext.draft_ovr, source: "DynastyProcess db_playerids" }
    : null;
  // clean_researched base (derived-clean flags), then any detailed overlay on top — so adding
  // just a scouting_brief to a clean player (the sweep's common case) keeps his clean
  // risk_flags/injury_history instead of dropping them to the unresearched default.
  let rx = research[id];
  if (cleanIds.has(id)) {
    const yrs = ["2023", "2024", "2025"].map((y) => avail.games_played[y]);
    const hasHistory = yrs.some((v) => v != null);
    const clean = {
      injury_history: hasHistory ? `No significant missed time (${yrs.map((v) => v ?? "--").join("/")}).` : null,
      risk_flags: { suspension: false, contract: false, legal: false, researched: true, notes: ["Swept clean in the league-wide suspension/holdout pass; games-played durable (rookie = no NFL history)."] },
      adp_commentary: null,
    };
    rx = { ...clean, ...(rx ?? {}) };
  }
  rx = rx ?? {};
  if (rx.injury_history !== undefined) { avail.injury_history = rx.injury_history; avail.partial = rx.injury_history == null; }
  return {
    id, name, pos, team: p.team, age: p.age ?? null, years_exp: p.years_exp ?? null,
    bye: byes[p.team] ?? null,   // null for a free agent, or if the schedule fetch failed — never guessed
    rookie: p.years_exp === 0,
    ids: { sleeper: id, fantasypros: ext?.fantasypros ?? null, gsis: ext?.gsis ?? null, pfr: ext?.pfr ?? null, espn: ext?.espn ?? null }, // DynastyProcess crosswalk; join key for ID-based sources
    projection: {
      pts, ppg: pts != null ? +(pts / 17).toFixed(1) : null,
      method: pos === "DEF" ? "partial: only sack/int/fum/blk project; points-allowed tiers do not — low confidence"
        : pos === "K" ? "league bands; 50+ scored at 5 (60+ bonus unprojectable)"
        : "Sleeper projected stat line re-scored with exact league settings",
      sleeper_half_ppr: pr?.pts_half_ppr ?? null, // sanity anchor, NOT the number to use
      updated: TODAY,
    },
    availability: avail,
    situation: { modifier: null, facts: situationFacts(name, pos) }, // modifier set by analysis pass, from facts only
    risk_flags: rx.risk_flags ?? { suspension: null, contract: null, legal: null, researched: false, notes: [] },
    adp: { half_ppr: adp, updated: TODAY },
    adp_commentary: rx.adp_commentary ?? null,
    scouting_brief: rx.scouting_brief ?? null, // evidence layer: what analysts/coaches/players say + scheme fit; null = not scouted (overlay-merged, survives rebuilds)
    fftiers: fftMap.get(normName(name)) ?? null, // Boris Chen half-PPR consensus rank+tier; null = not in his top-200
    ceiling: ceilingById.get(id) ?? null, // weekly spike-week rate; null = thin sample (rookie) or fetch failure
    usage: usageById.get(id) ?? null, // historical share/efficiency + gated trends; null = rookie/K/DEF (no NFL usage) — EVIDENCE + confidence only, never a value input
    context: { contract_year: null, rookie_capital: rookieCap, team_win_total: null, playoff_sos: null },
  };
});

const board = {
  generated: TODAY,
  scoring_basis: "HBGBs 2026 scoring_settings (data/raw/league-2026.json); verified identical to 2025 at renewal 2026-07-22",
  pool: `top ${POOL_SIZE} by Sleeper search_rank + 32 DEF`,
  fftiers: { source: "Boris Chen fftiers (FantasyPros consensus, GMM tiers), half-PPR draft board", status: fftStatus, updated: TODAY, matched: rows.filter((r) => r.fftiers).length },
  player_ids: { source: "DynastyProcess db_playerids (GPL-3.0, daily pipeline): sleeper_id crosswalk to FP/gsis/pfr/espn + NFL draft capital", status: pidsStatus, resolved_fp: rows.filter((r) => r.ids?.fantasypros).length, updated: TODAY },
  ceiling: { source: "Sleeper weekly stats 2023-25 re-scored; spike week = top-5 weekly finish at position", status: ceilingStatus, pos_avg: ceilingPosAvg, boom_line: ceilingBoomLine, spike_rank: SPIKE_RANK, min_weeks: MIN_CEIL_WEEKS, scored: rows.filter((r) => r.ceiling).length, updated: TODAY },
  usage: {
    source: "Sleeper weekly stats 2023-25; team totals via the per-week (tm_off_snp,tm_def_snp,tm_st_snp) team fingerprint",
    role: "EVIDENCE + confidence (role-stability) + trajectory/override only — never an input to asset value or the edge (the projection already prices raw share and age)",
    status: usageStatus, players: usageById.size, updated: TODAY,
    gates: { min_season_games: MIN_SEASON_G, trend_block: TREND_BLOCK, direction_thresholds: DIR_METRIC, trend_thresholds: TREND_METRIC, catch_rate_min_targets: CR_MIN_TGT },
    cluster_warnings: clusterWarn,
  },
  gaps: [
    { field: "usage (rookies / K / DEF)", status: "null by design", fill: "no NFL usage history exists (or the position has none); page shows no-data" },
    { field: "usage.direction / usage.trend", status: "null when under-sampled", fill: `direction needs 2+ seasons at ${MIN_SEASON_G}+ games; trend needs ${TREND_BLOCK * 2}+ games in 2025 — no arrow is claimed below that` },
    { field: "ceiling (rookies / thin sample)", status: "null by design", fill: `<${MIN_CEIL_WEEKS} career weeks -> no stable spike-rate; page shows no-data` },
    { field: "availability.injury_history", status: `researched for top ~35 (overlay); ${Object.keys(research).length} players in draft-research.json`, fill: "extend the web research pass deeper than ~35 as draft nears" },
    { field: "availability.score (rookies)", status: "null by design", fill: "no NFL history exists; page shows no-data" },
    { field: "situation.modifier", status: "unset", fill: "analysis pass over stored facts (facts only, no invented context)" },
    { field: "risk_flags.*", status: "researched for top ~35 (overlay); rest still null", fill: "extend the overlay; re-verify suspensions/holdouts in the final 2 weeks" },
    { field: "context.contract_year", status: "missing", fill: "web (Spotrac/OTC), mostly static once pulled" },
    { field: "context.rookie_capital", status: "filled for rookies from DynastyProcess db_playerids (NFL draft capital); null = veteran or unmatched", fill: "auto from the ID crosswalk" },
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
console.log(`fftiers: status=${fftStatus}, csv-rows=${fftMap.size}, matched to board=${rows.filter((r) => r.fftiers).length}`);
console.log(`player-ids: status=${pidsStatus}, FP-id resolved ${rows.filter((r) => r.ids?.fantasypros).length}/${rows.length}; rookie_capital filled for ${rows.filter((r) => r.context.rookie_capital).length} rookies`);
// usage sanity: team-fingerprint shares must reproduce known 2025 anchors (Chase target share ~32.6%).
for (const nm of ["Ja'Marr Chase", "Bijan Robinson", "Josh Allen"]) {
  const r = rows.find((x) => x.name === nm), s = r?.usage?.seasons?.["2025"];
  if (!s) { console.log(`usage anchor ${nm}: no 2025 usage`); continue; }
  console.log(`usage anchor ${nm}: g=${s.g} snap=${s.snap_share} tgt_share=${s.target_share ?? "-"} touch_share=${s.touch_share ?? "-"} dir=${r.usage.direction?.direction ?? "null"} trend=${r.usage.trend?.direction ?? "null"}`);
}
console.log(`usage: ${rows.filter((r) => r.usage).length}/${rows.length} board players have usage; direction claimed for ${rows.filter((r) => r.usage?.direction?.direction).length}, trend claimed for ${rows.filter((r) => r.usage?.trend?.direction).length}`);
// unmatched fftiers players in the ADP<=120 range = likely name-normalization misses worth checking
const boardNorms = new Set(rows.map((r) => normName(r.name)));
const unmatched = [...fftMap.entries()].filter(([n, v]) => v.rank <= 130 && !boardNorms.has(n)).map(([, v]) => v).slice(0, 15);
if (unmatched.length) console.log(`fftiers top-130 NOT matched to board (${unmatched.length}+):`, unmatched.map((v) => `${v.rank}:${v.pos}`).join(" "));
