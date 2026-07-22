// Build data/positional-ladder.json — the MEASURED positional value ladder.
// Run on demand: node scripts/measure-positional-ladder.mjs
// Read-only GETs against Sleeper public REST. Requires data/flex-split.json.
//
// WHY THIS EXISTS
// ---------------
// league-profile.md line 60 asserts a ladder — "elite RB ~+154, elite WR ~+133, elite TE
// ~+98, elite rushing QB ~+98, elite pocket QB ~+56, best DEF ~+28, best K ~+21" — and
// line 23 labels the whole section structural math from the scoring rules. This measures
// the same quantity from six seasons of actual NFL production re-scored in HBGBs format,
// using the replacement ranks measured in scripts/measure-flex-split.mjs.
//
// TWO REPLACEMENT DEFINITIONS, reported as a bracket rather than picking one:
//   season  — the Nth-best player by regular-season TOTAL. What you get if you draft the
//             replacement-level guy and start him all year. Conservative.
//   weekly  — the Nth-best player EACH WEEK, summed. What perfect streaming would return.
//             Unachievable (needs hindsight), so it is a ceiling, not a target.
// True replacement sits between them. Any single number here would be a choice disguised
// as a measurement.
//
// HONESTY CONTRACT (project ground rule): fields we cannot derive are null with a reason
// in meta.gaps — never filled with plausible values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "positional-ladder.json");
const TODAY = new Date().toISOString().slice(0, 10);
const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
const POS = ["QB", "RB", "WR", "TE"];
const NORM_WEEKS = 14;   // league-profile.md line 60 states a 14-week regular season
const RUSH_QB_YD = 350;  // chosen cut for "rushing QB" — stated, not derived

// Structural claims under test (league-profile.md line 60)
const STRUCTURAL = { RB: 154, WR: 133, TE: 98, QB_rush: 98, QB_pocket: 56 };

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

const scoring = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", "league-2025.json"), "utf8")).scoring_settings;
const flexPath = path.join(ROOT, "data", "flex-split.json");
if (!fs.existsSync(flexPath)) {
  console.error("missing data/flex-split.json — run: node scripts/measure-flex-split.mjs");
  process.exit(1);
}
const REPL_RANK = JSON.parse(fs.readFileSync(flexPath, "utf8")).replacement_rank;

// Skill stat keys map 1:1 onto scoring_settings keys (same convention as build-draft-board.mjs).
const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];
const rescore = (line) => {
  let pts = 0;
  for (const k of SKILL_KEYS) if (line?.[k] != null && scoring[k] != null) pts += line[k] * scoring[k];
  return pts;
};

const cfg = {};
for (const y of SEASONS) {
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `league-${y}.json`), "utf8"));
  cfg[y] = { lastRegularWeek: l.settings.playoff_week_start - 1 };
}

console.log("Fetching player metadata...");
const players = await get("https://api.sleeper.app/v1/players/nfl");

// ---- pull weekly stats, re-score in league format ----------------------------
const season = {}; // season -> pos -> [{id, total}]
const weekly = {}; // season -> pos -> [ [pts sorted desc] per week ]
for (const y of SEASONS) {
  const weeks = Array.from({ length: cfg[y].lastRegularWeek }, (_, i) => i + 1);
  const files = await Promise.all(
    weeks.map((w) => get(`https://api.sleeper.app/v1/stats/nfl/regular/${y}/${w}`).catch(() => ({})))
  );
  const totals = new Map();
  weekly[y] = Object.fromEntries(POS.map((p) => [p, []]));
  for (const wk of files) {
    const perPos = Object.fromEntries(POS.map((p) => [p, []]));
    for (const [id, line] of Object.entries(wk)) {
      const pos = players[id]?.position;
      if (!POS.includes(pos)) continue;
      const pts = rescore(line);
      perPos[pos].push(pts);
      totals.set(id, (totals.get(id) ?? 0) + pts);
    }
    for (const p of POS) weekly[y][p].push(perPos[p].sort((a, b) => b - a));
  }
  season[y] = Object.fromEntries(POS.map((p) => [p,
    [...totals.entries()]
      .filter(([id]) => players[id]?.position === p)
      .map(([id, total]) => ({ id, total, rushYd: null }))
      .sort((a, b) => b.total - a.total),
  ]));
  console.log(`  ${y}: ${files.length} weeks re-scored, ${totals.size} players`);
}

// rush yards per QB-season, for the rushing/pocket split
for (const y of SEASONS) {
  const weeks = Array.from({ length: cfg[y].lastRegularWeek }, (_, i) => i + 1);
  const files = await Promise.all(
    weeks.map((w) => get(`https://api.sleeper.app/v1/stats/nfl/regular/${y}/${w}`).catch(() => ({})))
  );
  const ry = new Map();
  for (const wk of files) for (const [id, line] of Object.entries(wk)) {
    if (players[id]?.position !== "QB") continue;
    ry.set(id, (ry.get(id) ?? 0) + (line.rush_yd ?? 0));
  }
  for (const q of season[y].QB) q.rushYd = ry.get(q.id) ?? 0;
}

// ---- replacement + elite ------------------------------------------------------
const perWeekScale = (y) => NORM_WEEKS / cfg[y].lastRegularWeek; // 13-week seasons -> 14-week terms
const rows = [];
for (const y of SEASONS) {
  const k = perWeekScale(y);
  for (const p of POS) {
    const n = REPL_RANK[p];
    const replSeason = (season[y][p][n - 1]?.total ?? 0) * k;
    const replWeekly = weekly[y][p].reduce((s, wkSorted) => s + (wkSorted[n - 1] ?? 0), 0) * k;
    rows.push({ season: y, pos: p, replSeason, replWeekly, replRank: n });
  }
}

const eliteOf = (y, p, filter = null) => {
  const pool = filter ? season[y][p].filter(filter) : season[y][p];
  const k = perWeekScale(y);
  return {
    top1: (pool[0]?.total ?? 0) * k,
    top3: (pool.slice(0, 3).reduce((s, x) => s + x.total, 0) / Math.min(3, pool.length || 1)) * k,
    name: players[pool[0]?.id]?.full_name ?? null,
  };
};

const hr = (t) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);

hr(`REPLACEMENT LEVEL (measured ranks: ${POS.map((p) => p + REPL_RANK[p]).join(" ")}), 14-week terms`);
console.log("season   " + POS.map((p) => `${p}: season/weekly`.padStart(20)).join(""));
for (const y of SEASONS) {
  const cells = POS.map((p) => {
    const r = rows.find((x) => x.season === y && x.pos === p);
    return `${r.replSeason.toFixed(0)}/${r.replWeekly.toFixed(0)}`.padStart(20);
  });
  console.log(`${y}   ` + cells.join(""));
}
const avg = (p, key) => rows.filter((r) => r.pos === p).reduce((s, r) => s + r[key], 0) / SEASONS.length;
console.log("mean    " + POS.map((p) => `${avg(p, "replSeason").toFixed(0)}/${avg(p, "replWeekly").toFixed(0)}`.padStart(20)).join(""));

hr("MEASURED LADDER vs league-profile.md line 60 (elite = positional #1, 14-week terms)");
console.log("                       measured VOR (season repl)   measured VOR (weekly repl)   structural   verdict");
const ladder = {};
const report = (label, key, get1) => {
  const vals = SEASONS.map((y) => get1(y));
  const vorS = vals.map((v, i) => v.top1 - rows.find((r) => r.season === SEASONS[i] && r.pos === key.split("_")[0])[ "replSeason" ]);
  const vorW = vals.map((v, i) => v.top1 - rows.find((r) => r.season === SEASONS[i] && r.pos === key.split("_")[0])["replWeekly"]);
  const mS = vorS.reduce((s, x) => s + x, 0) / vorS.length;
  const mW = vorW.reduce((s, x) => s + x, 0) / vorW.length;
  const struct = STRUCTURAL[key];
  const inBracket = struct >= Math.min(mS, mW) && struct <= Math.max(mS, mW);
  const verdict = inBracket ? "inside bracket" : struct > Math.max(mS, mW) ? "OVERSTATED" : "UNDERSTATED";
  ladder[key] = { measured_season_repl: +mS.toFixed(1), measured_weekly_repl: +mW.toFixed(1), structural: struct, verdict, per_season_season_repl: vorS.map((v) => +v.toFixed(1)) };
  console.log(
    `${label.padEnd(22)} ${("+" + mS.toFixed(0)).padStart(12)}${" ".repeat(16)}${("+" + mW.toFixed(0)).padStart(9)}` +
    `${" ".repeat(16)}${("+" + struct).padStart(6)}   ${verdict}`
  );
};
report("elite RB", "RB", (y) => eliteOf(y, "RB"));
report("elite WR", "WR", (y) => eliteOf(y, "WR"));
report("elite TE", "TE", (y) => eliteOf(y, "TE"));
report("elite rushing QB", "QB_rush", (y) => eliteOf(y, "QB", (q) => q.rushYd >= RUSH_QB_YD));
report("elite pocket QB", "QB_pocket", (y) => eliteOf(y, "QB", (q) => q.rushYd < RUSH_QB_YD));
console.log(`\n"inside bracket" = the structural estimate falls between the two replacement`);
console.log(`definitions, i.e. it is not distinguishable from measured. rushing QB cut: >=${RUSH_QB_YD} rush yd.`);

hr("PER-SEASON STABILITY (VOR vs season-total replacement; sign and rough magnitude)");
console.log("claim              " + SEASONS.map((y) => String(y).padStart(8)).join(""));
for (const [k, v] of Object.entries(ladder)) {
  console.log(k.padEnd(19) + v.per_season_season_repl.map((x) => ("+" + x.toFixed(0)).padStart(8)).join(""));
}

fs.writeFileSync(OUT, JSON.stringify({
  _meta: {
    purpose: "Measured positional value ladder in HBGBs scoring, testing the structural estimates at league-profile.md line 60.",
    generated: TODAY,
    method: `Sleeper weekly stats ${SEASONS[0]}-${SEASONS.at(-1)} re-scored with league-2025 scoring_settings; regular-season weeks only; scaled to a ${NORM_WEEKS}-week season.`,
    replacement_ranks: REPL_RANK,
    replacement_ranks_source: "data/flex-split.json (measured, 1640 FLEX slot-weeks)",
    rushing_qb_cut_yd: RUSH_QB_YD,
    gaps: [
      "K and DEF not measured. DEF touchdown stat keys (td, misc_td, def_st_td) do not map cleanly onto the scoring_settings DEF keys, so a DEF total would silently undercount. league-profile.md line 60's 'best DEF ~+28, best K ~+21' remains unvalidated.",
      "Elite = positional #1 each season. A top-3 mean is also stored per position but the headline verdicts use #1, matching the wording 'elite RB' rather than 'elite RB tier'.",
    ],
  },
  ladder,
  replacement_by_season: rows,
}, null, 2));
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
