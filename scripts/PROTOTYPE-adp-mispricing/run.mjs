// PROTOTYPE — THROWAWAY SHELL. Wipe this whole directory once the answer is captured.
//
// Deviation from the prototype skill's LOGIC branch, stated up front: the question here is
// statistical, not a state machine, so there's no TUI to drive by hand. The skill's real
// constraint is honoured instead — the logic that answers the question lives in a pure,
// liftable module (mispricing.mjs); this file is the disposable I/O + reporting shell.
//
// Run:  node scripts/PROTOTYPE-adp-mispricing/run.mjs
//
// Sources (all free, read-only, no auth):
//   price  — FantasyFootballCalculator /api/v1/adp/half-ppr (12tm). Late-August snapshot.
//   payoff — Sleeper /v1/stats/nfl/regular/{year} (pts_half_ppr, gp).
//   meta   — Sleeper /v1/players/nfl (position, birth_date).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitCurves, attachResiduals, loess, ols, mean, sd, pearson, spearman, tercileSpread,
} from "./mispricing.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".cache-WIPE-ME");
fs.mkdirSync(CACHE, { recursive: true });

const SEASONS = [2018, 2019, 2020, 2021, 2022, 2023, 2024]; // 2025 has no FFC data — verified
const TRAIN = [2018, 2019, 2020, 2021];
const TEST = [2022, 2023, 2024];
const SKILL = ["QB", "RB", "WR", "TE"];

const cached = async (key, url) => {
  const f = path.join(CACHE, key + ".json");
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  process.stdout.write(`  fetching ${key}... `);
  const r = await fetch(url, { headers: { "user-agent": "adp-mispricing-prototype/0.1" } });
  const j = await r.json();
  fs.writeFileSync(f, JSON.stringify(j));
  console.log("ok");
  return j;
};

const norm = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|iii|ii|iv|v)$/, "");
const num = (v) => (Number.isFinite(v) ? v : null); // Sleeper omits pts_half_ppr on some rows
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? "  n/a" : v.toFixed(d).padStart(6));
const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

// ------------------------------------------------------------------ load
console.log("Loading (cached after first run)...");
const players = await cached("players-nfl", "https://api.sleeper.app/v1/players/nfl");
const stats = {};
for (const y of [2017, ...SEASONS]) {
  stats[y] = await cached(`stats-${y}`, `https://api.sleeper.app/v1/stats/nfl/regular/${y}`);
}
const adp = {};
for (const y of SEASONS) {
  adp[y] = await cached(
    `ffc-${y}`,
    `https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?teams=12&year=${y}&position=all`
  );
}

// Sleeper lookup: normalized name + position -> [player_id]
const byKey = new Map();
for (const [pid, p] of Object.entries(players)) {
  const pos = p.position;
  if (!pos) continue;
  const nm = p.search_full_name ? norm(p.search_full_name) : norm(`${p.first_name}${p.last_name}`);
  if (!nm) continue;
  const k = `${nm}|${pos}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(pid);
}

// ------------------------------------------------------------------ build panel
hr("STAGE 1 — PANEL COVERAGE (honest match rates)");
console.log("season  ffc_rows  skill_rows  skill_matched  skill_miss  drafts  window");
const rows = [];
const missSkill = [];
for (const y of SEASONS) {
  const meta = adp[y].meta;
  let skillTot = 0, skillHit = 0;
  for (const p of adp[y].players) {
    const pos = p.position === "PK" ? "K" : p.position;
    const isSkill = SKILL.includes(pos);
    if (isSkill) skillTot++;
    const cands = byKey.get(`${norm(p.name)}|${pos}`) ?? [];
    // Prefer a candidate that actually has a stat row that season (disambiguates same-name players)
    const pid = cands.find((c) => stats[y][c]) ?? cands[0];
    if (!pid) {
      if (isSkill && missSkill.length < 14) missSkill.push(`${y} ${p.name} (${pos})`);
      continue;
    }
    if (isSkill) skillHit++;
    const s = stats[y][pid] ?? {};
    const prior = stats[y - 1][pid];
    const bd = players[pid]?.birth_date;
    const pts = Number.isFinite(s.pts_half_ppr) ? s.pts_half_ppr : 0; // no stat row = played, scored 0
    const gp = Number.isFinite(s.gp) ? s.gp : 0;
    rows.push({
      season: y, pid, name: p.name, pos,
      adp: p.adp, stdev: p.stdev, timesDrafted: p.times_drafted,
      points: pts, gp, ppg: gp > 0 ? pts / gp : null,
      priorPts: num(prior?.pts_half_ppr),
      priorGp: num(prior?.gp),
      priorPpg: prior && prior.gp > 0 && Number.isFinite(prior.pts_half_ppr)
        ? prior.pts_half_ppr / prior.gp
        : null,
      isRookie: prior ? 0 : 1,
      age: bd ? (y - Number(bd.slice(0, 4))) + (8 - Number(bd.slice(5, 7))) / 12 : null,
    });
  }
  console.log(
    `${y}   ${String(adp[y].players.length).padStart(7)}  ${String(skillTot).padStart(10)}  ` +
    `${String(skillHit).padStart(13)}  ${String(skillTot - skillHit).padStart(10)}  ` +
    `${String(meta.total_drafts).padStart(6)}  ${meta.start_date}→${meta.end_date}`
  );
}
console.log(`\nunmatched SKILL players (K/DEF misses are expected and irrelevant — both excluded):`);
console.log(`  ${missSkill.join("; ") || "none"}`);

// Normalize points within season (controls scoring-environment drift across 2018-2024).
// Denominator is the all-skill season mean, so ONE base rescales the index back to points
// for display — per-position rescaling would double-count the positional level.
const skill = rows.filter((r) => SKILL.includes(r.pos));
const seasonMeans = [];
for (const y of SEASONS) {
  const yr = skill.filter((r) => r.season === y);
  const mPts = mean(yr.map((r) => r.points));
  seasonMeans.push(mPts);
  const played = yr.filter((r) => r.ppg != null);
  const mPpg = mean(played.map((r) => r.ppg));
  for (const r of yr) {
    r.pointsIdx = r.points / mPts;
    r.ppgIdx = r.ppg == null ? null : r.ppg / mPpg;
  }
}
const IDX_BASE = mean(seasonMeans); // avg points of a drafted skill player, 2018-24
console.log(`\nskill-position panel: ${skill.length} player-seasons (K/DEF excluded from all modelling)`);
console.log(`  by pos: ${SKILL.map((p) => `${p}=${skill.filter((r) => r.pos === p).length}`).join("  ")}`);

// ------------------------------------------------------------------ value curve
hr("STAGE 2 — THE MARKET'S IMPLIED VALUE CURVE  (realized half-PPR pts, pooled 2018-24)");
const cPts = fitCurves(skill, "pointsIdx");
const PROBE = [1, 6, 12, 24, 36, 60, 90, 120];
console.log("        " + PROBE.map((a) => String(a).padStart(7)).join("") + "   <- overall ADP");
for (const pos of SKILL) {
  if (!cPts[pos]) continue;
  const yr = skill.filter((r) => r.pos === pos);
  const row = PROBE.map((a) => {
    const near = yr.filter((r) => Math.abs(Math.log(r.adp) - Math.log(a)) < 0.35).length;
    return near >= 5 ? fmt(cPts[pos](Math.log(a)) * IDX_BASE, 0) + " " : "      ·";
  }).join("");
  console.log(`${pos.padEnd(4)}  ${row}`);
}
console.log(`\n(half-PPR season points. '·' = fewer than 5 players ever drafted near that ADP at`);
console.log(` this position, so the curve has no support there and is not reported.)`);

// ------------------------------------------------------------------ decomposition
hr("STAGE 3 — DECOMPOSITION: when the market is wrong, is it GAMES or PER-GAME?");
attachResiduals(skill, cPts, "pointsIdx", "rPts");
attachResiduals(skill, fitCurves(skill, "gp"), "gp", "rGp");
attachResiduals(skill, fitCurves(skill.filter((r) => r.ppgIdx != null), "ppgIdx"), "ppgIdx", "rPpg");

console.log("pos    n     corr(err, games_err)  corr(err, perGame_err)   var_share_games");
for (const pos of SKILL) {
  const sub = skill.filter((r) => r.pos === pos && r.rPts != null && r.rGp != null && r.rPpg != null);
  if (sub.length < 30) continue;
  const e = sub.map((r) => r.rPts), g = sub.map((r) => r.rGp), p = sub.map((r) => r.rPpg);
  const cg = pearson(e, g), cp = pearson(e, p);
  console.log(
    `${pos.padEnd(5)} ${String(sub.length).padStart(4)}  ${fmt(cg, 3)}                ${fmt(cp, 3)}` +
    `                 ${fmt((cg * cg) / (cg * cg + cp * cp), 3)}`
  );
}
console.log("\nvar_share_games = cg²/(cg²+cp²): rough split of market error into availability vs production.");

// ------------------------------------------------------------------ residual model
// Number.isFinite, not `!= null` — NaN passes a null check and silently poisons the whole fit.
const modelRows = skill.filter((r) =>
  [r.rPts, r.age, r.stdev, r.adp].every(Number.isFinite) && r.stdev > 0 &&
  (r.isRookie || [r.priorPpg ?? 0, r.priorGp ?? 0].every(Number.isFinite))
);
const design = (r) => [
  Math.log(r.adp),
  r.age,
  r.isRookie,
  r.isRookie ? 0 : (r.priorPpg ?? 0),
  r.isRookie ? 0 : (r.priorGp ?? 0),
  r.stdev / r.adp,
  r.pos === "RB" ? 1 : 0,
  r.pos === "WR" ? 1 : 0,
  r.pos === "TE" ? 1 : 0,
];
const LABELS = ["intercept", "log(ADP)", "age", "isRookie", "priorPPG", "priorGP", "relStdev", "RB", "WR", "TE"];

hr("STAGE 4 — WHAT EXPLAINS THE RESIDUAL?  (in-sample, all seasons — descriptive only)");
const full = ols(modelRows.map(design), modelRows.map((r) => r.rPts));
console.log(`n=${full.n}   R²=${full.r2.toFixed(4)}   (dropped ${skill.length - modelRows.length} rows: no birth_date or no stdev)\n`);
console.log("term          coef      se       t");
full.beta.forEach((b, i) =>
  console.log(`${LABELS[i].padEnd(12)}${fmt(b, 4)}  ${fmt(full.se[i], 4)}  ${fmt(full.t[i], 2)}`)
);

// ------------------------------------------------------------------ walk-forward
hr("STAGE 5 — WALK-FORWARD: does any of it survive out of sample?");
const tr = modelRows.filter((r) => TRAIN.includes(r.season));
const te = modelRows.filter((r) => TEST.includes(r.season));
console.log(`train ${TRAIN.join(",")}  n=${tr.length}      test ${TEST.join(",")}  n=${te.length}\n`);

const m = ols(tr.map(design), tr.map((r) => r.rPts));
const predict = (r) => design(r).reduce((s, v, i) => s + v * m.beta[i + 1], m.beta[0]);
const pred = te.map(predict);
const act = te.map((r) => r.rPts);

console.log(`out-of-sample Pearson (pred vs actual residual):  ${pearson(pred, act).toFixed(4)}`);
console.log(`out-of-sample Spearman:                           ${spearman(pred, act).toFixed(4)}`);
const t3 = tercileSpread(pred, act);
console.log(`\ntercile test — mean ACTUAL residual by predicted tercile (index units, ~1.0 = avg drafted player):`);
console.log(`  predicted-cheapest third : ${fmt(t3.top, 4)}`);
console.log(`  middle third             : ${fmt(t3.middle, 4)}`);
console.log(`  predicted-most-overpriced: ${fmt(t3.bottom, 4)}`);
console.log(`  spread (top - bottom)    : ${fmt(t3.top - t3.bottom, 4)}   n per tercile ≈ ${Math.floor(t3.n / 3)}`);
console.log(`\nresidual sd in test set: ${sd(act).toFixed(4)} — compare the spread against this. A spread`);
console.log(`well under 1 sd is noise dressed as signal.`);

console.log("\nper-test-season stability (spread must not flip sign):");
for (const y of TEST) {
  const s = te.filter((r) => r.season === y);
  if (s.length < 30) { console.log(`  ${y}: n=${s.length} — too thin to split`); continue; }
  const sp = tercileSpread(s.map(predict), s.map((r) => r.rPts));
  console.log(`  ${y}: n=${s.length}  spread=${fmt(sp.top - sp.bottom, 4)}  (cheap ${fmt(sp.top, 3)} vs rich ${fmt(sp.bottom, 3)})`);
}

// ------------------------------------------------------------------ truncation
hr("STAGE 6 — TRUNCATION: how much of the payoff distribution has no ADP at all?");
console.log("share of each season's actual positional finishers who were NOT in the FFC pool:");
console.log("season   QB(top12)   RB(top24)   WR(top24)   TE(top12)");
const drafted = new Set(rows.map((r) => `${r.season}|${r.pid}`));
for (const y of SEASONS) {
  const cells = [["QB", 12], ["RB", 24], ["WR", 24], ["TE", 12]].map(([pos, n]) => {
    const fin = Object.entries(stats[y])
      .filter(([pid, s]) => players[pid]?.position === pos && Number.isFinite(s.pts_half_ppr))
      .sort((a, b) => b[1].pts_half_ppr - a[1].pts_half_ppr)
      .slice(0, n);
    const undr = fin.filter(([pid]) => !drafted.has(`${y}|${pid}`)).length;
    return `${String(undr).padStart(2)}/${n} ${((undr / n) * 100).toFixed(0).padStart(3)}%`;
  });
  console.log(`${y}    ${cells.join("   ")}`);
}
console.log("\nThese players have no price, so they are invisible to every residual above.");
console.log("Any claim about late-round value is censored until they're given a shadow ADP.");

// ------------------------------------------------------------------ positional mispricing
hr("STAGE 7 — POSITIONAL MISPRICING (pooled curve + VORP)");
console.log("Stages 2-5 fit ONE CURVE PER POSITION, which forces each position's residuals to");
console.log("mean zero — positional mispricing is invisible by construction. This stage fits a");
console.log("SINGLE pooled curve over value-over-replacement instead, so a position that the");
console.log("market systematically underpays shows up as a non-zero mean residual.\n");

// Replacement = 12 teams x starters/position (2.5 RB and 3.5 WR absorb the flex).
const STARTERS = { QB: 1, RB: 2.5, WR: 3.5, TE: 1 };
const repl = {};
for (const y of SEASONS) {
  repl[y] = {};
  for (const pos of SKILL) {
    const ranked = Object.entries(stats[y])
      .filter(([pid, s]) => players[pid]?.position === pos && Number.isFinite(s.pts_half_ppr))
      .map(([, s]) => s.pts_half_ppr)
      .sort((a, b) => b - a);
    repl[y][pos] = ranked[Math.round(12 * STARTERS[pos]) - 1] ?? 0;
  }
}
console.log("replacement baselines (half-PPR season points at QB12 / RB30 / WR42 / TE12):");
console.log("season " + SKILL.map((p) => p.padStart(7)).join(""));
for (const y of SEASONS) console.log(`${y}  ` + SKILL.map((p) => fmt(repl[y][p], 0) + " ").join(""));

for (const y of SEASONS) {
  const yr = skill.filter((r) => r.season === y);
  const raw = yr.map((r) => r.points - repl[y][r.pos]);
  const s = sd(raw) || 1;
  yr.forEach((r, i) => { r.vorpIdx = raw[i] / s; });
}
const pooled = loess(skill.map((r) => Math.log(r.adp)), skill.map((r) => r.vorpIdx), { span: 0.4 });
for (const r of skill) r.rVorp = r.vorpIdx - pooled(Math.log(r.adp));

console.log("\nmean residual VORP by position (units = 1 sd of that season's drafted-player VORP):");
console.log("pos    n     mean_resid    t      read");
for (const pos of SKILL) {
  const sub = skill.filter((r) => r.pos === pos && Number.isFinite(r.rVorp)).map((r) => r.rVorp);
  const t = mean(sub) / (sd(sub) / Math.sqrt(sub.length));
  const read = Math.abs(t) < 2 ? "priced fairly" : mean(sub) > 0 ? "UNDERPRICED" : "OVERPRICED";
  console.log(`${pos.padEnd(5)} ${String(sub.length).padStart(4)}  ${fmt(mean(sub), 3)}     ${fmt(t, 2)}   ${read}`);
}

console.log("\nsame test, split by draft phase (is the mispricing concentrated somewhere?):");
console.log("pos    early(ADP<=36)        late(ADP>36)");
for (const pos of SKILL) {
  const cell = (f) => {
    const sub = skill.filter((r) => r.pos === pos && f(r) && Number.isFinite(r.rVorp)).map((r) => r.rVorp);
    if (sub.length < 20) return `n=${String(sub.length).padStart(3)} too thin   `;
    const t = mean(sub) / (sd(sub) / Math.sqrt(sub.length));
    return `n=${String(sub.length).padStart(3)} ${fmt(mean(sub), 3)} (t${fmt(t, 1)})`;
  };
  console.log(`${pos.padEnd(5)}  ${cell((r) => r.adp <= 36)}   ${cell((r) => r.adp > 36)}`);
}

console.log("\nper-season sign stability of the positional effect (must not flip to be real):");
console.log("pos   " + SEASONS.map((y) => String(y).padStart(7)).join(""));
for (const pos of SKILL) {
  const cells = SEASONS.map((y) => {
    const sub = skill.filter((r) => r.pos === pos && r.season === y && Number.isFinite(r.rVorp)).map((r) => r.rVorp);
    return sub.length < 8 ? "      ·" : fmt(mean(sub), 2) + " ";
  });
  console.log(`${pos.padEnd(5)} ` + cells.join(""));
}
