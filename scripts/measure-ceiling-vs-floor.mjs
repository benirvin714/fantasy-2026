// Build data/ceiling-vs-floor.json — does week-to-week VARIANCE actually help?
// Run on demand: node scripts/measure-ceiling-vs-floor.mjs
// Read-only GETs against Sleeper public REST.
//
// WHY THIS EXISTS
// ---------------
// league-profile.md §10 says the 6-of-10 playoff field means "floor matters less,
// ceiling matters more — draft and trade for spike weeks". §4 says punt TE, partly
// BECAUSE elite TE is volatile. At TE those two rules point opposite ways, and the
// conflict is currently unresolved in a file that gets drafted from.
//
// This tests §10's premise directly. The theory is unambiguous: in head-to-head, at a
// fixed mean, variance helps you if you are BELOW the bar and hurts you if you are
// ABOVE it. A 6-of-10 field is a LOW bar (top 60%), which predicts variance should
// hurt good teams — the opposite of what §10 assumes. So this is a real test, not a
// confirmation exercise.
//
// SAMPLE IS SMALL AND STATED UP FRONT: 6 seasons x 10 teams = 60 team-seasons. That
// detects a large effect and nothing subtle. Reported with power caveats, not dressed up.
//
// HONESTY CONTRACT (project ground rule): fields we cannot derive are null with a reason.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "ceiling-vs-floor.json");
const TODAY = new Date().toISOString().slice(0, 10);
const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

function ols(X, y) { // X = rows of predictors, intercept added
  const n = y.length, k = X[0].length + 1;
  const D = X.map((r) => [1, ...r]);
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => D.reduce((s, r) => s + r[i] * r[j], 0)));
  const b = Array.from({ length: k }, (_, i) => D.reduce((s, r, ri) => s + r[i] * y[ri], 0));
  const solve = (A0, b0) => {
    const M = A0.map((r, i) => [...r, b0[i]]);
    for (let c = 0; c < k; c++) {
      let p = c; for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < k; r++) { const f = M[r][c] / M[c][c]; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; }
    }
    const x = new Array(k).fill(0);
    for (let i = k - 1; i >= 0; i--) { let s = M[i][k]; for (let j = i + 1; j < k; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  };
  const beta = solve(A, b); if (!beta) return null;
  const fit = D.map((r) => r.reduce((s, v, i) => s + v * beta[i], 0));
  const res = y.map((v, i) => v - fit[i]);
  const rss = res.reduce((s, e) => s + e * e, 0);
  const s2 = rss / (n - k);
  const se = [];
  for (let i = 0; i < k; i++) { const e = new Array(k).fill(0); e[i] = 1; const c = solve(A, e); se.push(c ? Math.sqrt(Math.max(0, s2 * c[i])) : NaN); }
  const ybar = mean(y);
  return { beta, se, t: beta.map((v, i) => v / se[i]), r2: 1 - rss / y.reduce((s, v) => s + (v - ybar) ** 2, 0), n };
}

console.log("Fetching player metadata...");
const players = await get("https://api.sleeper.app/v1/players/nfl");

const teamSeasons = [];
for (const y of SEASONS) {
  const lg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `league-${y}.json`), "utf8"));
  const rosters = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `rosters-${y}.json`), "utf8"));
  const bracket = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `winners-bracket-${y}.json`), "utf8"));
  const madePlayoffs = new Set(bracket.flatMap((m) => [m.t1, m.t2]).filter((v) => typeof v === "number"));
  const champ = bracket.find((m) => m.p === 1)?.w ?? null;
  const lastWeek = lg.settings.playoff_week_start - 1;

  const weeks = await Promise.all(
    Array.from({ length: lastWeek }, (_, i) => get(`https://api.sleeper.app/v1/league/${lg.league_id}/matchups/${i + 1}`).catch(() => null))
  );

  // weekly score + TE-slot points per roster
  const byRoster = new Map(rosters.map((r) => [r.roster_id, { scores: [], tePts: [] }]));
  for (const wk of weeks) {
    if (!wk) continue;
    for (const t of wk) {
      const rec = byRoster.get(t.roster_id);
      if (!rec || typeof t.points !== "number") continue;
      rec.scores.push(t.points);
      const teId = t.starters?.[5]; // roster_positions index 5 = TE, identical all six seasons
      rec.tePts.push(players[teId]?.position === "TE" ? (t.players_points?.[teId] ?? 0) : 0);
    }
  }

  // all-play: how many of the other 9 you outscored, every week (schedule-independent quality)
  const nWeeks = Math.max(...[...byRoster.values()].map((v) => v.scores.length));
  const allPlay = new Map([...byRoster.keys()].map((k) => [k, 0]));
  let allPlayGames = 0;
  for (let w = 0; w < nWeeks; w++) {
    const wkScores = [...byRoster.entries()].map(([id, v]) => [id, v.scores[w]]).filter(([, s]) => typeof s === "number");
    for (const [id, s] of wkScores) allPlay.set(id, allPlay.get(id) + wkScores.filter(([id2, s2]) => id2 !== id && s > s2).length);
    allPlayGames = wkScores.length - 1;
  }

  for (const r of rosters) {
    const rec = byRoster.get(r.roster_id);
    if (!rec || rec.scores.length < 5) continue;
    teamSeasons.push({
      season: y, rosterId: r.roster_id,
      wins: r.settings.wins, losses: r.settings.losses,
      meanScore: mean(rec.scores), sdScore: sd(rec.scores),
      cv: sd(rec.scores) / mean(rec.scores),
      allPlayPct: allPlay.get(r.roster_id) / (nWeeks * allPlayGames),
      madePlayoffs: madePlayoffs.has(r.roster_id) ? 1 : 0,
      champion: champ === r.roster_id ? 1 : 0,
      teShare: mean(rec.tePts) / mean(rec.scores),
      weeks: rec.scores.length,
    });
  }
  console.log(`  ${y}: ${rosters.length} teams, weeks 1-${lastWeek}, playoff field ${[...madePlayoffs].sort((a, b) => a - b).join(",")}`);
}

const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d).padStart(8) : "     n/a");

hr(`SAMPLE: ${teamSeasons.length} team-seasons (${SEASONS.length} seasons x 10 teams)`);
console.log(`playoff teams: ${teamSeasons.filter((t) => t.madePlayoffs).length}   champions: ${teamSeasons.filter((t) => t.champion).length}`);
console.log(`\nmean weekly score: ${mean(teamSeasons.map((t) => t.meanScore)).toFixed(1)}`);
console.log(`mean weekly sd:    ${mean(teamSeasons.map((t) => t.sdScore)).toFixed(1)}  (coefficient of variation ${mean(teamSeasons.map((t) => t.cv)).toFixed(3)})`);
console.log(`corr(mean, sd):    ${(() => { const a = teamSeasons.map((t) => t.meanScore), b = teamSeasons.map((t) => t.sdScore), ma = mean(a), mb = mean(b); return (a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0) * b.reduce((s, v) => s + (v - mb) ** 2, 0))).toFixed(3); })()}`);

hr("TEST A — do WINS respond to variance, holding scoring constant?");
const A = ols(teamSeasons.map((t) => [t.meanScore, t.sdScore]), teamSeasons.map((t) => t.wins));
console.log(`n=${A.n}  R²=${A.r2.toFixed(3)}\n`);
console.log("term         coef       se        t");
["intercept", "meanScore", "sdScore"].forEach((l, i) => console.log(`${l.padEnd(12)}${f(A.beta[i], 4)} ${f(A.se[i], 4)} ${f(A.t[i], 2)}`));
console.log(`\nsdScore t = ${A.t[2].toFixed(2)}. |t| < 2 means variance has no detectable effect on wins`);
console.log(`once scoring level is controlled for.`);

hr("TEST B — do PLAYOFF ODDS respond to variance, holding scoring constant?");
const B = ols(teamSeasons.map((t) => [t.meanScore, t.sdScore]), teamSeasons.map((t) => t.madePlayoffs));
console.log("term         coef       se        t");
["intercept", "meanScore", "sdScore"].forEach((l, i) => console.log(`${l.padEnd(12)}${f(B.beta[i], 5)} ${f(B.se[i], 5)} ${f(B.t[i], 2)}`));

hr("TEST C — the theory's actual prediction: variance should help the WEAK, hurt the STRONG");
const med = [...teamSeasons.map((t) => t.meanScore)].sort((a, b) => a - b)[Math.floor(teamSeasons.length / 2)];
for (const [label, rows] of [["above-median scoring", teamSeasons.filter((t) => t.meanScore >= med)], ["below-median scoring", teamSeasons.filter((t) => t.meanScore < med)]]) {
  const sdMed = [...rows.map((r) => r.sdScore)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  const hi = rows.filter((r) => r.sdScore >= sdMed), lo = rows.filter((r) => r.sdScore < sdMed);
  console.log(`\n${label} (n=${rows.length}):`);
  console.log(`  high-variance half: ${mean(hi.map((r) => r.wins)).toFixed(2)} wins, ${(100 * mean(hi.map((r) => r.madePlayoffs))).toFixed(0)}% made playoffs  (n=${hi.length})`);
  console.log(`  low-variance half : ${mean(lo.map((r) => r.wins)).toFixed(2)} wins, ${(100 * mean(lo.map((r) => r.madePlayoffs))).toFixed(0)}% made playoffs  (n=${lo.length})`);
  console.log(`  variance effect   : ${(mean(hi.map((r) => r.wins)) - mean(lo.map((r) => r.wins)) > 0 ? "+" : "")}${(mean(hi.map((r) => r.wins)) - mean(lo.map((r) => r.wins))).toFixed(2)} wins`);
}
console.log(`\nTheory predicts NEGATIVE above the median and POSITIVE below it. Anything else`);
console.log(`is noise or a broken premise.`);

hr("TEST D — did variance buy wins the scoring didn't earn? (actual vs all-play)");
const D = ols(teamSeasons.map((t) => [t.allPlayPct, t.sdScore]), teamSeasons.map((t) => t.wins));
console.log("term          coef       se        t");
["intercept", "allPlayPct", "sdScore"].forEach((l, i) => console.log(`${l.padEnd(13)}${f(D.beta[i], 4)} ${f(D.se[i], 4)} ${f(D.t[i], 2)}`));
console.log(`\nall-play% is schedule-independent scoring quality. If variance manufactured wins,`);
console.log(`sdScore would load positively HERE even if it did not in Test A.`);

hr("TEST E — TE-specific: did leaning on TE scoring correlate with anything?");
const sorted = [...teamSeasons].sort((a, b) => b.teShare - a.teShare);
const top = sorted.slice(0, 15), bot = sorted.slice(-15);
console.log(`share of team scoring from the TE slot: mean ${(100 * mean(teamSeasons.map((t) => t.teShare))).toFixed(1)}%\n`);
console.log(`  top third by TE share (n=${top.length}): ${mean(top.map((t) => t.wins)).toFixed(2)} wins, ${(100 * mean(top.map((t) => t.madePlayoffs))).toFixed(0)}% playoffs, TE share ${(100 * mean(top.map((t) => t.teShare))).toFixed(1)}%`);
console.log(`  bot third by TE share (n=${bot.length}): ${mean(bot.map((t) => t.wins)).toFixed(2)} wins, ${(100 * mean(bot.map((t) => t.madePlayoffs))).toFixed(0)}% playoffs, TE share ${(100 * mean(bot.map((t) => t.teShare))).toFixed(1)}%`);
console.log(`\nDescriptive only. TE share is an OUTCOME (a good TE scores more), not a strategy,`);
console.log(`so this cannot separate "drafted a TE early" from "the TE happened to be good".`);

fs.writeFileSync(OUT, JSON.stringify({
  _meta: {
    purpose: "Tests league-profile.md §10's premise that a 6-of-10 playoff field makes ceiling worth more than floor. Bears directly on the §4-vs-§10 conflict at TE.",
    generated: TODAY,
    sample: `${teamSeasons.length} team-seasons`,
    power_warning: "n=60 detects a large effect and nothing subtle. A null here is 'not detectable at this sample size', NOT 'proven absent'.",
    gaps: ["Champion-level analysis (n=6) is not attempted — the playoff tournament is where variance should help most, and it is the part this sample cannot speak to at all."],
  },
  tests: {
    A_wins_on_mean_and_sd: { terms: ["intercept", "meanScore", "sdScore"], beta: A.beta, t: A.t, r2: A.r2 },
    B_playoffs_on_mean_and_sd: { terms: ["intercept", "meanScore", "sdScore"], beta: B.beta, t: B.t, r2: B.r2 },
    D_wins_on_allplay_and_sd: { terms: ["intercept", "allPlayPct", "sdScore"], beta: D.beta, t: D.t, r2: D.r2 },
  },
  team_seasons: teamSeasons,
}, null, 2));
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
