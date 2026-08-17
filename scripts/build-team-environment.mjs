#!/usr/bin/env node
// Build data/site/team-environment.json - the offensive-environment layer.
//
// Answers "how many points is this offense expected to score, and how much of that
// lands in fantasy-startable hands in THIS league's format". It is CONTEXT, not value:
// nothing here moves a player's draft-$ or edge. It exists so a pick can be checked
// against the offense the player is attached to.
//
// Three independent signals, deliberately kept separate rather than blended into one
// number. A blend hides disagreement, and the disagreement is the useful part:
//   1. pf/ppg - Mike Clay's projected points scored (ESPN draft-kit PDF, refetched)
//   2. vegas  - season win total, the market's view (static, dated, hand-entered)
//   3. core   - Sleeper 2026 projections re-scored to HBGBs settings, summed over a
//               FIXED starter shape (QB1 + RB1-2 + WR1-3 + TE1) so a team is not
//               rewarded merely for having more draftable bodies.
//
// Usage:
//   node scripts/build-team-environment.mjs [--offline]
//
// --offline skips the 5MB PDF fetch and uses the committed snapshot. The snapshot is
// refreshed on every successful live parse, so the offline path degrades to the last
// good numbers rather than to nulls.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "site", "team-environment.json");
const SNAPSHOT = path.join(ROOT, "data", "raw", "clay-team-projections.json");
const OFFLINE = process.argv.includes("--offline");

const CLAY_URL = "https://g.espncdn.com/s/ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf";

// Season win totals. Slow-moving market number, hand-entered with its source and date so
// a stale value is visible rather than silent. Re-check at any big injury or trade.
const VEGAS = {
  as_of: "2026-07-23",
  label: "FOX Sports - 2026 win totals, all 32 teams",
  url: "https://www.foxsports.com/stories/nfl/2026-nfl-win-totals-over-unders-all-32-squads",
  totals: {
    ARI: 3.5, ATL: 6.5, BAL: 11.5, BUF: 10.5, CAR: 7.5, CHI: 9.5, CIN: 10.5, CLE: 5.5,
    DAL: 9.5, DEN: 9.5, DET: 10.5, GB: 9.5, HOU: 9.5, IND: 7.5, JAX: 8.5, KC: 10.5,
    LV: 5.5, LAC: 9.5, LAR: 11.5, MIA: 4.5, MIN: 8.5, NE: 10.5, NO: 7.5, NYG: 7.5,
    NYJ: 5.5, PHI: 10.5, PIT: 8.5, SF: 9.5, SEA: 10.5, TB: 8.5, TEN: 6.5, WAS: 7.5,
  },
};

const NAME2ABBR = {
  ArizonaCardinals: "ARI", AtlantaFalcons: "ATL", BaltimoreRavens: "BAL", BuffaloBills: "BUF",
  CarolinaPanthers: "CAR", ChicagoBears: "CHI", CincinnatiBengals: "CIN", ClevelandBrowns: "CLE",
  DallasCowboys: "DAL", DenverBroncos: "DEN", DetroitLions: "DET", GreenBayPackers: "GB",
  HoustonTexans: "HOU", IndianapolisColts: "IND", JacksonvilleJaguars: "JAX", KansasCityChiefs: "KC",
  LasVegasRaiders: "LV", LosAngelesChargers: "LAC", LosAngelesRams: "LAR", MiamiDolphins: "MIA",
  MinnesotaVikings: "MIN", NewEnglandPatriots: "NE", NewOrleansSaints: "NO", NewYorkGiants: "NYG",
  NewYorkJets: "NYJ", PhiladelphiaEagles: "PHI", PittsburghSteelers: "PIT", SanFrancisco49ers: "SF",
  SeattleSeahawks: "SEA", TampaBayBuccaneers: "TB", TennesseeTitans: "TEN", WashingtonCommanders: "WAS",
};

const today = new Date().toISOString().slice(0, 10);

/* ---------- 1. Clay projected points ------------------------------------------------
   The guide is a PDF of FlateDecode streams. Each team page carries a week-by-week
   score projection whose footer row is "Total <for> <against> <winprob>%". We inflate
   the streams, pull the text-showing operators, and read that row. The whole parse is
   gated on a sanity check (32 teams, plausible point range) - a silently-changed layout
   must fall back to the snapshot, never emit half a league. */

function pdfText(buf) {
  const OCT = new RegExp("\\\\([0-7]{3})", "g");
  const ESC = new RegExp("\\\\([()\\\\])", "g");
  const STR = new RegExp("\\((?:\\\\.|[^\\\\()])*\\)", "g");
  const pages = [];
  let i = 0;
  while (true) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let a = s + 6;
    if (buf[a] === 0x0d) a++;
    if (buf[a] === 0x0a) a++;
    const e = buf.indexOf("endstream", a);
    if (e < 0) break;
    try {
      const inf = zlib.inflateSync(buf.subarray(a, e)).toString("latin1");
      if (inf.includes("Tj") || inf.includes("TJ")) {
        const parts = [];
        let m;
        STR.lastIndex = 0;
        while ((m = STR.exec(inf))) {
          parts.push(m[0].slice(1, -1).replace(ESC, "$1")
            .replace(OCT, (_, o) => String.fromCharCode(parseInt(o, 8))));
        }
        if (parts.length > 5) pages.push(parts.join(" "));
      }
    } catch { /* not a flate stream (image, font); skip */ }
    i = e + 9;
  }
  return pages;
}

function parseClay(buf) {
  const out = {};
  for (const page of pdfText(buf)) {
    const flat = page.replace(/\s+/g, "");
    const name = flat.match(/2026([A-Za-z49]+?)Projections/);
    const abbr = name && NAME2ABBR[name[1]];
    if (!abbr || out[abbr]) continue;
    const tot = flat.match(/Total(\d{3})(\d{3})(\d{1,2})%/);
    const wins = flat.match(/PROJECTEDWINS:([\d.]+)\(NFLRANK:(\d+)\)/);
    if (!tot) continue;
    const pf = +tot[1], pa = +tot[2];
    if (pf < 150 || pf > 700 || pa < 150 || pa > 700) continue; // layout drifted
    out[abbr] = { pf, pa, proj_wins: wins ? +wins[1] : null };
  }
  return out;
}

async function getClay() {
  if (!OFFLINE) {
    try {
      const r = await fetch(CLAY_URL, { headers: { "user-agent": "hbgbs-hq/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parseClay(Buffer.from(await r.arrayBuffer()));
      const n = Object.keys(parsed).length;
      if (n !== 32) throw new Error(`parsed ${n}/32 teams, layout likely changed`);
      const snap = { fetched: today, source: CLAY_URL, teams: parsed };
      fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 1) + "\n");
      console.log(`Clay: live parse OK (32 teams), snapshot refreshed`);
      return { teams: parsed, mode: "live", as_of: today };
    } catch (e) {
      console.error(`Clay: live fetch/parse failed (${e.message}) - falling back to snapshot`);
    }
  }
  if (!fs.existsSync(SNAPSHOT)) throw new Error("no Clay snapshot on disk and live parse unavailable");
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  console.log(`Clay: using snapshot from ${snap.fetched}`);
  return { teams: snap.teams, mode: "snapshot", as_of: snap.fetched };
}

/* ---------- 2. league-format core ---------------------------------------------------
   Full player universe, not the draft board's top-200 pool: capping at the pool made
   five teams report QB 0 simply because their starter fell outside the draftable
   cutoff, which reads as "no quarterback" rather than "not worth drafting". */

const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td",
  "rush_2pt", "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];

async function getCore() {
  const scoring = JSON.parse(
    fs.readFileSync(path.join(ROOT, "data", "raw", "league-2026.json"), "utf8")
  ).scoring_settings;

  const bust = `cb=${Date.now()}`; // Sleeper sits behind a stale-while-revalidate CDN
  const grab = async (url) => {
    const r = await fetch(`${url}?${bust}`);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
  };
  const [players, proj] = await Promise.all([
    grab("https://api.sleeper.app/v1/players/nfl"),
    grab("https://api.sleeper.app/v1/projections/nfl/regular/2026"),
  ]);

  const rescore = (p) => {
    let pts = 0;
    for (const k of SKILL_KEYS) if (p[k] != null && scoring[k] != null) pts += p[k] * scoring[k];
    return +pts.toFixed(1);
  };

  const teams = new Map();
  for (const [id, pr] of Object.entries(proj)) {
    const meta = players[id];
    if (!meta?.team || !["QB", "RB", "WR", "TE"].includes(meta.position)) continue;
    const pts = rescore(pr);
    if (pts <= 0) continue;
    if (!teams.has(meta.team)) teams.set(meta.team, { list: [], pass_yd: 0, rush_yd: 0 });
    const t = teams.get(meta.team);
    t.list.push({ name: `${meta.first_name} ${meta.last_name}`, pos: meta.position, pts });
    t.pass_yd += pr.pass_yd || 0;
    t.rush_yd += pr.rush_yd || 0;
  }

  const out = {};
  for (const [team, t] of teams) {
    const by = (p) => t.list.filter((x) => x.pos === p).sort((a, b) => b.pts - a.pts);
    const sum = (arr, n) => +arr.slice(0, n).reduce((a, x) => a + x.pts, 0).toFixed(1);
    const qb = by("QB"), rb = by("RB"), wr = by("WR"), te = by("TE");
    const yds = t.pass_yd + t.rush_yd;
    out[team] = {
      core: +(sum(qb, 1) + sum(rb, 2) + sum(wr, 3) + sum(te, 1)).toFixed(1),
      parts: { qb: sum(qb, 1), rb: sum(rb, 2), wr: sum(wr, 3), te: sum(te, 1) },
      qb1: qb[0]?.name ?? null,
      pass_share: yds ? +(t.pass_yd / yds).toFixed(3) : null,
    };
  }
  return out;
}

/* ---------- assemble ---------------------------------------------------------------- */

const clay = await getClay();
const core = await getCore();

const missing = Object.keys(clay.teams).filter((t) => !core[t]);
if (missing.length) console.error(`WARN: no Sleeper core for ${missing.join(", ")}`);

let teams = Object.entries(clay.teams).map(([team, c]) => ({
  team,
  pf: c.pf,
  ppg: +(c.pf / 17).toFixed(1),
  pa: c.pa,
  point_diff: c.pf - c.pa,
  proj_wins: c.proj_wins,
  vegas_win_total: VEGAS.totals[team] ?? null,
  core: core[team]?.core ?? null,
  core_parts: core[team]?.parts ?? null,
  pass_share: core[team]?.pass_share ?? null,
  qb1: core[team]?.qb1 ?? null,
}));

teams.sort((a, b) => b.pf - a.pf);
teams.forEach((t, i) => { t.rank = i + 1; });

const coreOrder = [...teams].filter((t) => t.core != null).sort((a, b) => b.core - a.core);
coreOrder.forEach((t, i) => { t.core_rank = i + 1; });
for (const t of teams) {
  if (t.core_rank == null) t.core_rank = null;
  // negative = fantasy core ranks better than the offense's real scoring supports
  t.gap = t.core_rank == null ? null : t.core_rank - t.rank;
}

const payload = {
  generated: today,
  scoring_basis: "core = Sleeper 2026 projections re-scored to HBGBs settings (half-PPR, 4-pt pass TD), summed QB1 + RB1-2 + WR1-3 + TE1",
  note: "Context layer. Does not feed draft-$, edge, or the confidence band.",
  sources: {
    points: { label: "Mike Clay 2026 NFL Projection Guide (ESPN)", url: CLAY_URL, as_of: clay.as_of, mode: clay.mode },
    vegas: { label: VEGAS.label, url: VEGAS.url, as_of: VEGAS.as_of },
    core: { label: "Sleeper 2026 projections re-scored locally", as_of: today },
  },
  teams,
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + "\n");
console.log(`\nwrote ${teams.length} teams to data/site/team-environment.json`);
console.log("rk team   PF   PPG  coreRk  pass%");
for (const t of teams) {
  console.log(
    `${String(t.rank).padStart(2)} ${t.team.padEnd(4)} ${String(t.pf).padStart(4)} ` +
    `${String(t.ppg).padStart(5)}  ${String(t.core_rank ?? "-").padStart(5)}  ` +
    `${t.pass_share == null ? "  - " : String(Math.round(t.pass_share * 100)).padStart(4)}%`
  );
}
