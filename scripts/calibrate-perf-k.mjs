/* Calibrate k for the roster performance module's verdict weight.
 *
 * The module blends each team's results with its projection, weighting results by
 * w = g / (g + k), where g is completed games. k is the number of games at which results and
 * projection are trusted equally. This script measures it from The HBGBs' own 2020-25 seasons
 * instead of picking it (plans/roster-performance-module.md, Q2 and Q9).
 *
 * The test: at every checkpoint g, which blend of "points per game so far" and "what the roster
 * was projected to score" best predicts the team's actual points per game over the REST of the
 * regular season? All three quantities are taken as deviations from the league mean at that
 * checkpoint, because the module ranks teams within a league and a shared level shift cancels.
 *
 * The projection is reconstructed from Sleeper's pre-week weekly projections (dated before
 * kickoff, so no hindsight), re-scored in that season's own scoring settings and run through the
 * same greedy optimal-lineup fill the roster room uses. Two versions, because each is biased in a
 * known direction and together they bracket the truth:
 *   A  next-week   - the roster at week g+1, projected for week g+1 only. Leakage-free, but one
 *                    matchup and any byes make it noisy, which UNDERSTATES what projection knows.
 *   B  rest-of-season, frozen roster - the roster at week g+1, projected over weeks g+1..N.
 *                    Smoother, but later weekly projections know about injuries, which OVERSTATES it.
 *
 * Reads: Sleeper public REST (read-only GETs), data/raw/league-YYYY.json for ids/scoring/weeks.
 * Caches: data/raw/matchups-YYYY.json (small, committed) and data/raw/proj-weekly-YYYY.json
 *         (filtered to that season's rostered players and scoring keys, committed).
 * Writes: data/perf-k.json - the estimates and the evidence behind them.
 *
 * Outcome (2026-09-21): k came out so large (51 leakage-free, unbounded against a rest-of-season
 * projection) that blending was dropped from the design. The module reads standing (results) and
 * strength (projection) separately; this script stays as the evidence for that choice and should
 * be rerun if the question comes back, e.g. once the Pit or the Clash has a season of history.
 *
 *   node scripts/calibrate-perf-k.mjs            # uses caches when present
 *   node scripts/calibrate-perf-k.mjs --refetch  # ignores caches
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "data", "perf-k.json");
const SEASONS = ["2020", "2021", "2022", "2023", "2024", "2025"];
const REFETCH = process.argv.includes("--refetch");

// Historical endpoints are immutable, but the cache-bust costs nothing and keeps the habit uniform.
const get = async (url) => {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}${Math.random()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};
const readJSON = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d) + "\n");

/* ------------------------------------------------------------- scoring (mirrors the roster room) */
const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];
const K_KEYS = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "xpm", "xpmiss",
  "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49"];
const DEF_KEYS = ["sack", "int", "fum_rec", "blk_kick", "safe", "def_td"];
const MISS_KEYS = ["fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49", "fgmiss_50p"];
const KEEP = new Set([...SKILL_KEYS, ...K_KEYS, ...DEF_KEYS, ...MISS_KEYS, "fgm_50p"]);

function makeRescore(scoring) {
  const flat = scoring.fgmiss != null && scoring.fgmiss !== 0;
  return (p, pos) => {
    if (!p) return 0;
    let pts = 0;
    const keys = pos === "K" ? K_KEYS : pos === "DEF" ? DEF_KEYS : SKILL_KEYS;
    for (const k of keys) {
      if (flat && MISS_KEYS.includes(k)) continue;
      if (p[k] != null && scoring[k] != null) pts += p[k] * scoring[k];
    }
    if (pos === "K") {
      if (p.fgm_50p != null) pts += p.fgm_50p * (scoring.fgm_50_59 ?? 5);
      if (flat) for (const k of MISS_KEYS) if (p[k] != null) pts += p[k] * scoring.fgmiss;
    }
    return pts;
  };
}

/* ---------------------------------------------- optimal lineup (greedy; slot eligibility nests) */
const FIXED = ["QB", "RB", "RB", "WR", "WR", "TE", "K", "DEF"];
const FLEX_OK = new Set(["RB", "WR", "TE"]);
function optimal(players) {                     // players: [{pos, pts}]
  const pool = players.filter((p) => p.pos).sort((a, b) => b.pts - a.pts);
  const used = new Array(pool.length).fill(false);
  let total = 0;
  const take = (ok) => {
    const i = pool.findIndex((p, j) => !used[j] && ok(p.pos));
    if (i >= 0) { used[i] = true; total += pool[i].pts; }
  };
  for (const s of FIXED) take((pos) => pos === s);
  take((pos) => FLEX_OK.has(pos));
  take((pos) => FLEX_OK.has(pos));
  return total;
}

/* -------------------------------------------------------------------------------- data pull */
console.log("Fetching the Sleeper player index for positions...");
const index = await get("https://api.sleeper.app/v1/players/nfl");
const posOf = (id) => (/^[A-Z]{2,3}$/.test(id) ? "DEF" : index[id]?.position ?? null);

const seasons = [];
for (const yr of SEASONS) {
  const league = readJSON(path.join(RAW, `league-${yr}.json`));
  const N = league.settings.playoff_week_start - 1;          // regular-season weeks
  const mFile = path.join(RAW, `matchups-${yr}.json`);
  const pFile = path.join(RAW, `proj-weekly-${yr}.json`);

  let matchups;
  if (!REFETCH && fs.existsSync(mFile)) matchups = readJSON(mFile).weeks;
  else {
    matchups = {};
    for (let w = 1; w <= N; w++) {
      const rows = await get(`https://api.sleeper.app/v1/league/${league.league_id}/matchups/${w}`);
      matchups[w] = rows.map((r) => ({ roster_id: r.roster_id, points: r.points, players: r.players ?? [] }));
    }
    writeJSON(mFile, { league_id: league.league_id, season: yr, regular_weeks: N,
      source: "api.sleeper.app/v1/league/<id>/matchups/<week>, trimmed to roster_id/points/players", weeks: matchups });
  }

  let proj;
  if (!REFETCH && fs.existsSync(pFile)) proj = readJSON(pFile).weeks;
  else {
    const rostered = new Set(Object.values(matchups).flat().flatMap((r) => r.players));
    proj = {};
    for (let w = 1; w <= N; w++) {
      const all = await get(`https://api.sleeper.app/v1/projections/nfl/regular/${yr}/${w}`);
      proj[w] = {};
      for (const id of rostered) {
        const line = all[id];
        if (!line) continue;
        const slim = {};
        for (const [k, v] of Object.entries(line)) if (KEEP.has(k) && v) slim[k] = v;
        proj[w][id] = slim;
      }
      process.stdout.write(`  ${yr} wk${w} `);
    }
    console.log();
    writeJSON(pFile, { season: yr, source: "api.sleeper.app/v1/projections/nfl/regular/<season>/<week> (pre-week), filtered to that season's rostered players and scoring keys", weeks: proj });
  }

  const rescore = makeRescore(league.scoring_settings);
  const projWeek = (players, w) => optimal(players.map((id) => ({ pos: posOf(id), pts: rescore(proj[w]?.[id], posOf(id)) })));
  seasons.push({ yr, N, matchups, projWeek });
  console.log(`${yr}: ${N} regular weeks, ${Object.keys(matchups).length} weeks of matchups`);
}

/* ------------------------------------------------------------------------- build observations */
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const obs = [];              // {yr, g, R, PA, PB, T}  - all as deviations from the league mean
let unposed = 0;
for (const S of seasons) {
  const ids = S.matchups[1].map((r) => r.roster_id);
  const pts = (id, w) => S.matchups[w].find((r) => r.roster_id === id)?.points ?? 0;
  const roster = (id, w) => S.matchups[w].find((r) => r.roster_id === id)?.players ?? [];
  for (const w in S.matchups) for (const r of S.matchups[w]) for (const p of r.players) if (!posOf(p)) unposed++;
  for (let g = 1; g < S.N; g++) {
    const rows = ids.map((id) => {
      const R = mean(Array.from({ length: g }, (_, i) => pts(id, i + 1)));
      const T = mean(Array.from({ length: S.N - g }, (_, i) => pts(id, g + 1 + i)));
      const rost = roster(id, g + 1);
      const PA = S.projWeek(rost, g + 1);
      const PB = mean(Array.from({ length: S.N - g }, (_, i) => S.projWeek(rost, g + 1 + i)));
      return { id, R, T, PA, PB };
    });
    const c = (k) => mean(rows.map((x) => x[k]));
    const m = { R: c("R"), T: c("T"), PA: c("PA"), PB: c("PB") };
    for (const x of rows) obs.push({ yr: S.yr, g, R: x.R - m.R, T: x.T - m.T, PA: x.PA - m.PA, PB: x.PB - m.PB });
  }
}
console.log(`\n${obs.length} team-checkpoints across ${SEASONS.length} seasons; ${unposed} roster slots had no known position (scored 0)`);

/* ------------------------------------------------------------------------------------ fitting */
// Log-spaced 0.5 .. 1000: the first run pinned at a linear 40 ceiling, so the optimum has to be allowed to land far out.
const KGRID = Array.from({ length: 300 }, (_, i) => +(0.5 * Math.pow(2000, i / 299)).toFixed(2));
const sse = (rows, P, k) => rows.reduce((s, o) => { const w = o.g / (o.g + k); const e = w * o.R + (1 - w) * o[P] - o.T; return s + e * e; }, 0);
const bestK = (rows, P) => KGRID.reduce((b, k) => { const e = sse(rows, P, k); return e < b.e ? { k, e } : b; }, { k: null, e: Infinity });

// Unconstrained best w at each g (least squares of T - P on R - P): checks the g/(g+k) SHAPE.
function freeW(rows, P) {
  const byG = {};
  for (const o of rows) (byG[o.g] ??= []).push(o);
  return Object.entries(byG).map(([g, rs]) => {
    let num = 0, den = 0;
    for (const o of rs) { const x = o.R - o[P], y = o.T - o[P]; num += x * y; den += x * x; }
    return { g: +g, n: rs.length, w: +(num / den).toFixed(3) };
  });
}
// Rank agreement, the thing the headline actually shows.
function spearman(a, b) {
  const rank = (v) => { const s = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], j) => (r[i] = j)); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  return 1 - (6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0)) / (n * (n * n - 1));
}
function rankCheck(P, k, g) {
  const groups = {};
  for (const o of obs.filter((o) => o.g === g)) (groups[o.yr] ??= []).push(o);
  const avg = (f) => +mean(Object.values(groups).map((rs) => spearman(rs.map(f), rs.map((o) => o.T)))).toFixed(3);
  const w = g / (g + k);
  return { g, results_only: avg((o) => o.R), projection_only: avg((o) => o[P]), blend: avg((o) => w * o.R + (1 - w) * o[P]) };
}

const result = {};
for (const P of ["PA", "PB"]) {
  const all = bestK(obs, P);
  const loso = SEASONS.map((yr) => ({ held_out: yr, k: bestK(obs.filter((o) => o.yr !== yr), P).k }));
  const base = { results_only: sse(obs, P, 0.0001), projection_only: sse(obs, P, 1e9) };
  result[P] = {
    k: all.k,
    rmse: +Math.sqrt(all.e / obs.length).toFixed(2),
    rmse_results_only: +Math.sqrt(base.results_only / obs.length).toFixed(2),
    rmse_projection_only: +Math.sqrt(base.projection_only / obs.length).toFixed(2),
    leave_one_season_out: loso,
    free_w_by_g: freeW(obs, P).map((x) => ({ ...x, curve: +(x.g / (x.g + all.k)).toFixed(3) })),
    rank_agreement: [2, 4, 6, 8, 10].map((g) => rankCheck(P, all.k, g)),
  };
}

// Lower bound with no projection at all: k0 = within-team weekly variance / between-team true variance.
const within = [], seasonMeans = [];
for (const S of seasons) for (const id of S.matchups[1].map((r) => r.roster_id)) {
  const xs = Array.from({ length: S.N }, (_, i) => S.matchups[i + 1].find((r) => r.roster_id === id)?.points ?? 0);
  const m = mean(xs);
  within.push(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  seasonMeans.push({ yr: S.yr, m, N: S.N });
}
const sigma2 = mean(within);
const tau2 = mean(SEASONS.map((yr) => {
  const ms = seasonMeans.filter((x) => x.yr === yr); const mm = mean(ms.map((x) => x.m));
  return ms.reduce((s, x) => s + (x.m - mm) ** 2, 0) / (ms.length - 1) - sigma2 / ms[0].N;
}));

/* ------------------------------------------------------------------------------------ report */
/* No midpoint. The first version reported the bracket midpoint as "k", and with B unbounded that
   printed k = 525.5, a number that means nothing. A is the leakage-free estimate, so it is the
   one quoted; B is reported as what it is, a bound. And k is a FINDING, not a module input: this
   result is why the module reads standing and strength separately instead of blending them
   (plans/roster-performance-module.md, Q14). */
const CEILING = KGRID[KGRID.length - 1];
const unbounded = (k) => k >= CEILING;
const out = {
  generated: new Date().toISOString().slice(0, 10),
  k_leakage_free: result.PA.k,
  k_rest_of_season: unbounded(result.PB.k) ? null : result.PB.k,
  k_rest_of_season_unbounded: unbounded(result.PB.k),
  finding: `Results add little to nothing beyond Sleeper's in-season projections when predicting a team's rest-of-season scoring. Leakage-free k = ${result.PA.k} (results weight ${Math.round(4 / (4 + result.PA.k) * 100)}% at week 4, ${Math.round(13 / (13 + result.PA.k) * 100)}% at week 13); against a rest-of-season projection the optimum is ${unbounded(result.PB.k) ? "projection alone (k unbounded)" : "k = " + result.PB.k}. Weekly noise dwarfs the true spread between teams, and the projections are updated from play to date, so results would count the same evidence twice.`,
  used_as: "Evidence only, not a live input. The module does not blend: standing comes from results (they decide playoff seeding, whatever their predictive value) and strength comes from projection.",
  basis: "HBGBs 2020-25 regular seasons. k minimizes squared error predicting each team's rest-of-season points/game (as deviation from the league mean) from w*results + (1-w)*projection, w = g/(g+k), over a log grid 0.5-1000. Projection A = next-week pre-week projection of the current roster's optimal lineup (leakage-free, noisy: understates projection). Projection B = the same roster projected over the rest of the season (smoother, mild injury leakage: overstates projection).",
  n_observations: obs.length,
  no_projection_lower_bound: { sigma2_weekly: +sigma2.toFixed(1), tau2_true_strength: +tau2.toFixed(1), k0: +(sigma2 / tau2).toFixed(1),
    note: "k with NO projection prior (league mean only). Any real projection shrinks the unexplained spread, so the calibrated k should sit above this." },
  projection_A_next_week: result.PA,
  projection_B_rest_of_season: result.PB,
};
writeJSON(OUT, out);

console.log(`\nno-projection lower bound  k0 = ${out.no_projection_lower_bound.k0}  (sigma2 ${out.no_projection_lower_bound.sigma2_weekly}, tau2 ${out.no_projection_lower_bound.tau2_true_strength})`);
for (const [P, label] of [["PA", "A next-week"], ["PB", "B rest-of-season"]]) {
  const r = result[P];
  console.log(`\n${label}: k = ${r.k}   rmse ${r.rmse}  (results-only ${r.rmse_results_only}, projection-only ${r.rmse_projection_only})`);
  console.log("  leave-one-season-out k: " + r.leave_one_season_out.map((x) => `${x.held_out}:${x.k}`).join("  "));
  console.log("  free w by g vs curve:   " + r.free_w_by_g.map((x) => `g${x.g} ${x.w}/${x.curve}`).join("  "));
  console.log("  rank agreement (Spearman vs rest-of-season):");
  for (const x of r.rank_agreement) console.log(`    g=${String(x.g).padStart(2)}  results ${x.results_only}  projection ${x.projection_only}  blend ${x.blend}`);
}
console.log(`\n${out.finding}\n  ->  ${path.relative(ROOT, OUT)}`);
