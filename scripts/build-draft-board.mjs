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
// Mean-VORP is variance-blind, but this league pays for ceiling ("draft for spike
// weeks", league-profile.md §10). Re-score every player-week 2023-25 in league
// format; a "spike week" = finishing at/above the position's top-SPIKE_RANK weekly
// line. spike_week_rate = share of a player's weeks that spiked. Feeds the draft
// board's ceiling column + the ceiling-tilt knob. Degrades to null (with reason)
// on fetch failure or thin sample (rookies) — never fabricated.
const SPIKE_RANK = 5;        // a spike week ~ a top-5 weekly finish at the position
const MIN_CEIL_WEEKS = 10;   // fewer real games than this -> null (no stable estimate)
const CEIL_POS = ["QB", "RB", "WR", "TE"];
let ceilingById = new Map(), ceilingPosAvg = {}, ceilingStatus = "ok", ceilingBoomLine = {};
try {
  const t0 = Date.now();
  const YEARS = ["2023", "2024", "2025"], WEEKS = Array.from({ length: 18 }, (_, i) => i + 1);
  const weekly = await Promise.all(
    YEARS.flatMap((y) => WEEKS.map((w) =>
      get(`https://api.sleeper.app/v1/stats/nfl/regular/${y}/${w}`).catch(() => ({}))))
  );
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
  console.log(`ceiling: ${weekly.length} weeks fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${ceilingById.size} players scored, boom lines ${JSON.stringify(ceilingBoomLine)}, pos avg ${JSON.stringify(ceilingPosAvg)}`);
} catch (e) { ceilingStatus = `weekly fetch/compute failed: ${e.message}`; console.log(`ceiling: ${ceilingStatus}`); }

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
  // detailed overlay first; else expand a clean_researched id into derived-clean flags
  let rx = research[id];
  if (!rx && cleanIds.has(id)) {
    const yrs = ["2023", "2024", "2025"].map((y) => avail.games_played[y]);
    const hasHistory = yrs.some((v) => v != null);
    rx = {
      injury_history: hasHistory ? `No significant missed time (${yrs.map((v) => v ?? "--").join("/")}).` : null,
      risk_flags: { suspension: false, contract: false, legal: false, researched: true, notes: ["Swept clean in the league-wide suspension/holdout pass; games-played durable (rookie = no NFL history)."] },
      adp_commentary: null,
    };
  }
  rx = rx ?? {};
  if (rx.injury_history !== undefined) { avail.injury_history = rx.injury_history; avail.partial = rx.injury_history == null; }
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
    availability: avail,
    situation: { modifier: null, facts: situationFacts(name, pos) }, // modifier set by analysis pass, from facts only
    risk_flags: rx.risk_flags ?? { suspension: null, contract: null, legal: null, researched: false, notes: [] },
    adp: { half_ppr: adp, updated: TODAY },
    adp_commentary: rx.adp_commentary ?? null,
    fftiers: fftMap.get(normName(name)) ?? null, // Boris Chen half-PPR consensus rank+tier; null = not in his top-200
    ceiling: ceilingById.get(id) ?? null, // weekly spike-week rate; null = thin sample (rookie) or fetch failure
    context: { contract_year: null, rookie_capital: null, team_win_total: null, playoff_sos: null },
  };
});

const board = {
  generated: TODAY,
  scoring_basis: "HBGBs 2025 scoring_settings (data/raw/league-2025.json); re-verify at 2026 renewal",
  pool: `top ${POOL_SIZE} by Sleeper search_rank + 32 DEF`,
  fftiers: { source: "Boris Chen fftiers (FantasyPros consensus, GMM tiers), half-PPR draft board", status: fftStatus, updated: TODAY, matched: rows.filter((r) => r.fftiers).length },
  ceiling: { source: "Sleeper weekly stats 2023-25 re-scored; spike week = top-5 weekly finish at position", status: ceilingStatus, pos_avg: ceilingPosAvg, boom_line: ceilingBoomLine, spike_rank: SPIKE_RANK, min_weeks: MIN_CEIL_WEEKS, scored: rows.filter((r) => r.ceiling).length, updated: TODAY },
  gaps: [
    { field: "ceiling (rookies / thin sample)", status: "null by design", fill: `<${MIN_CEIL_WEEKS} career weeks -> no stable spike-rate; page shows no-data` },
    { field: "availability.injury_history", status: `researched for top ~35 (overlay); ${Object.keys(research).length} players in draft-research.json`, fill: "extend the web research pass deeper than ~35 as draft nears" },
    { field: "availability.score (rookies)", status: "null by design", fill: "no NFL history exists; page shows no-data" },
    { field: "situation.modifier", status: "unset", fill: "analysis pass over stored facts (facts only, no invented context)" },
    { field: "risk_flags.*", status: "researched for top ~35 (overlay); rest still null", fill: "extend the overlay; re-verify suspensions/holdouts in the final 2 weeks" },
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
console.log(`fftiers: status=${fftStatus}, csv-rows=${fftMap.size}, matched to board=${rows.filter((r) => r.fftiers).length}`);
// unmatched fftiers players in the ADP<=120 range = likely name-normalization misses worth checking
const boardNorms = new Set(rows.map((r) => normName(r.name)));
const unmatched = [...fftMap.entries()].filter(([n, v]) => v.rank <= 130 && !boardNorms.has(n)).map(([, v]) => v).slice(0, 15);
if (unmatched.length) console.log(`fftiers top-130 NOT matched to board (${unmatched.length}+):`, unmatched.map((v) => `${v.rank}:${v.pos}`).join(" "));
