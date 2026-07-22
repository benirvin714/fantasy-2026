// Build data/flex-split.json — measured FLEX usage across all HBGBs seasons.
// Run on demand: node scripts/measure-flex-split.mjs
// Read-only GETs against Sleeper public REST.
//
// WHY THIS EXISTS
// ---------------
// league-profile.md line 60 states a positional value ladder ("elite RB ~+154, WR ~+133,
// TE ~+98 ...") explicitly labelled structural math from the scoring rules. Every number
// in it depends on where replacement level sits, and replacement level depends on how many
// players at each position the league actually STARTS each week. With 2 FLEX slots that is
// not a rulebook fact — it is a behavioural one, and it has never been measured.
//
// This measures it: every FLEX slot, every regular-season week, every season. The output is
// the exchange rate the draft board currently lacks (its spike-week metric is within-position
// only, so it cannot say whether a TE spiking 30% of weeks beats an RB spiking 30%).
//
// HONESTY CONTRACT (project ground rule): fields we cannot derive are null with a reason —
// never filled with plausible values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "flex-split.json");
const TODAY = new Date().toISOString().slice(0, 10);
const SEASONS = [2020, 2021, 2022, 2023, 2024, 2025];
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

// ---- league config straight from the archived raw files (no assumptions) -----
const cfg = {};
for (const y of SEASONS) {
  const l = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "raw", `league-${y}.json`), "utf8"));
  const rp = l.roster_positions;
  cfg[y] = {
    leagueId: l.league_id,
    rosterPositions: rp,
    flexIdx: rp.map((p, i) => [p, i]).filter(([p]) => p === "FLEX").map(([, i]) => i),
    lastRegularWeek: l.settings.playoff_week_start - 1,
    fixed: FLEX_ELIGIBLE.reduce((a, p) => ({ ...a, [p]: rp.filter((x) => x === p).length }), {}),
    teams: l.total_rosters,
  };
}

console.log("Fetching player metadata...");
const players = await get("https://api.sleeper.app/v1/players/nfl");
const posOf = (id) => (id && id !== "0" ? players[id]?.position ?? null : null);

// ---- pull every regular-season week -----------------------------------------
const obs = []; // one row per FLEX slot filled
const gaps = [];
for (const y of SEASONS) {
  const { leagueId, flexIdx, lastRegularWeek } = cfg[y];
  const weeks = Array.from({ length: lastRegularWeek }, (_, i) => i + 1);
  const pulled = await Promise.all(
    weeks.map((w) =>
      get(`https://api.sleeper.app/v1/league/${leagueId}/matchups/${w}`).catch((e) => {
        gaps.push(`${y} wk${w}: ${e.message}`);
        return null;
      })
    )
  );
  let n = 0;
  pulled.forEach((wk, i) => {
    if (!wk) return;
    for (const team of wk) {
      if (!Array.isArray(team.starters)) continue;
      for (const idx of flexIdx) {
        const pid = team.starters[idx];
        obs.push({
          season: y,
          week: weeks[i],
          rosterId: team.roster_id,
          playerId: pid ?? null,
          pos: posOf(pid),
          pts: team.players_points?.[pid] ?? null, // already in THIS league's scoring
        });
        n++;
      }
    }
  });
  console.log(`  ${y}: ${n} flex slots across weeks 1-${lastRegularWeek}`);
}

// ---- the split ---------------------------------------------------------------
const filled = obs.filter((o) => FLEX_ELIGIBLE.includes(o.pos));
const empty = obs.filter((o) => !o.playerId || o.playerId === "0");
const odd = obs.filter((o) => o.playerId && o.playerId !== "0" && !FLEX_ELIGIBLE.includes(o.pos));

const shareOf = (rows) => {
  const tot = rows.length || 1;
  return FLEX_ELIGIBLE.reduce((a, p) => ({ ...a, [p]: rows.filter((r) => r.pos === p).length / tot }), {});
};
const pct = (v) => (v * 100).toFixed(1).padStart(5) + "%";

console.log(`\n${"=".repeat(72)}\nFLEX SPLIT — ${obs.length} slot-weeks, ${filled.length} filled with an eligible player\n${"=".repeat(72)}`);
console.log(`empty/unfilled: ${empty.length}   non-eligible or unknown position: ${odd.length}`);
console.log("\nseason   n      RB      WR      TE");
for (const y of SEASONS) {
  const s = shareOf(filled.filter((o) => o.season === y));
  const n = filled.filter((o) => o.season === y).length;
  console.log(`${y}  ${String(n).padStart(4)}  ${pct(s.RB)}  ${pct(s.WR)}  ${pct(s.TE)}`);
}
const pooled = shareOf(filled);
console.log(`pooled ${String(filled.length).padStart(5)}  ${pct(pooled.RB)}  ${pct(pooled.WR)}  ${pct(pooled.TE)}`);

// ---- what it implies for replacement level ------------------------------------
const TEAMS = cfg[2025].teams;
const FLEX_SLOTS = cfg[2025].flexIdx.length;
const effective = FLEX_ELIGIBLE.reduce(
  (a, p) => ({ ...a, [p]: cfg[2025].fixed[p] + FLEX_SLOTS * pooled[p] }),
  { QB: cfg[2025].rosterPositions.filter((x) => x === "QB").length }
);

console.log(`\n${"=".repeat(72)}\nIMPLIED REPLACEMENT LEVEL (${TEAMS} teams, ${FLEX_SLOTS} FLEX)\n${"=".repeat(72)}`);
console.log("pos   fixed  +flex   effective starters/team   league-wide starters (= replacement rank)");
for (const p of ["QB", ...FLEX_ELIGIBLE]) {
  const fixed = cfg[2025].rosterPositions.filter((x) => x === p).length;
  const fromFlex = p === "QB" ? 0 : FLEX_SLOTS * pooled[p];
  const eff = effective[p];
  console.log(
    `${p.padEnd(5)} ${fixed.toFixed(2).padStart(5)}  ${fromFlex.toFixed(2).padStart(5)}   ` +
    `${eff.toFixed(2).padStart(21)}   ${String(Math.round(eff * TEAMS)).padStart(3)}  (${p}${Math.round(eff * TEAMS)})`
  );
}

// ---- did the FLEX pick actually pay off by position? --------------------------
const scored = filled.filter((o) => Number.isFinite(o.pts));
console.log(`\n${"=".repeat(72)}\nREALIZED FLEX PRODUCTION BY POSITION (league scoring, ${scored.length} scored slots)\n${"=".repeat(72)}`);
console.log("pos     n     mean pts   median");
for (const p of FLEX_ELIGIBLE) {
  const v = scored.filter((o) => o.pos === p).map((o) => o.pts).sort((a, b) => a - b);
  if (!v.length) continue;
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  console.log(`${p.padEnd(5)} ${String(v.length).padStart(5)}   ${mean.toFixed(2).padStart(7)}   ${v[Math.floor(v.length / 2)].toFixed(2).padStart(6)}`);
}
console.log("\nThis is what the FLEX slot RETURNED by position, not what the position is worth —");
console.log("managers choose who to start, so it is a selected sample. Read it as a check that");
console.log("the split is not obviously irrational, not as a value estimate.");

// ---- write -------------------------------------------------------------------
fs.writeFileSync(OUT, JSON.stringify({
  _meta: {
    purpose: "Measured FLEX usage across HBGBs seasons; supplies the replacement level that league-profile.md line 60's value ladder assumes structurally.",
    generated: TODAY,
    source: "Sleeper public REST /league/{id}/matchups/{week}, regular-season weeks only",
    caveat: "Split is behavioural, not structural: it reflects what THIS room started, including weeks a manager had no good alternative. It is the right input for replacement level (realized league-wide demand) but is not evidence about which position is better.",
    observations: obs.length,
    filled: filled.length,
    gaps: gaps.length ? gaps : null,
  },
  seasons: Object.fromEntries(SEASONS.map((y) => {
    const rows = filled.filter((o) => o.season === y);
    return [y, { n: rows.length, share: shareOf(rows), lastRegularWeek: cfg[y].lastRegularWeek }];
  })),
  pooled_share: pooled,
  effective_starters_per_team: effective,
  replacement_rank: Object.fromEntries(
    ["QB", ...FLEX_ELIGIBLE].map((p) => [p, Math.round(effective[p] * TEAMS)])
  ),
}, null, 2));
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
if (gaps.length) console.log(`GAPS (weeks that failed to fetch): ${gaps.join("; ")}`);
