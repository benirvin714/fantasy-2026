/* build-draft-aid.mjs — compact payload for the phone Draft Aid (draft.irvinfamily.com).
 *
 * This one is deliberately NOT an HBGBs tool. The aid is for whatever draft you happen to be in,
 * so it carries Boris Chen's tiers in all three scoring formats (standard / half-PPR / PPR) and
 * lets the page pick, rather than baking in this league's half-PPR the way the desktop board does.
 * It builds straight from Sleeper + fftiers instead of from `draft-board.json`, so nothing about
 * the HBGBs player pool, scoring settings or roster shape leaks into it.
 *
 * Sources, all public read-only GETs:
 *   fftiers   s3-us-west-1.amazonaws.com/fftiers/out/weekly-ALL{,-HALF-PPR,-PPR}.csv
 *             FantasyPros expert consensus, GMM-clustered tiers. github.com/borisachen/fftiers
 *   Sleeper   /v1/players/nfl          name, position, team, Sleeper id (the pick-feed join key)
 *             /v1/projections/nfl/...  per-format ADP (adp_std / adp_half_ppr / adp_ppr)
 *             /schedule/nfl/regular/   bye weeks, derived rather than hand-kept
 *
 * Everything degrades to null rather than to a guess: a player with no tier in a format simply has
 * no tier there, and the page sorts him into the ADP tail instead of inventing a rank.
 *
 * Run:  node scripts/build-draft-aid.mjs   (npm run build:draft-aid)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "data", "site", "draft-aid.json");
const SEASON = 2026;

// key -> [fftiers file suffix, Sleeper ADP field, label shown on the toggle]
const FORMATS = {
  std: ["", "adp_std", "Standard"],
  half: ["-HALF-PPR", "adp_half_ppr", "0.5 PPR"],
  ppr: ["-PPR", "adp_ppr", "PPR"],
};

const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

/* Name matching is the weak joint in this pipeline: fftiers publishes display names and Sleeper
   publishes its own. Strip everything that varies between the two — punctuation, generational
   suffixes, case — and compare what is left. */
const normName = (s) => String(s ?? "").toLowerCase()
  .replace(/\./g, "").replace(/'/g, "")
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
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

/* One cached CSV per format. A transient S3 blip during an unattended rebuild should degrade to
   yesterday's tiers, not publish a board with no tiers at all. */
async function fetchTiers(key) {
  const [suffix] = FORMATS[key];
  const url = `https://s3-us-west-1.amazonaws.com/fftiers/out/weekly-ALL${suffix}.csv`;
  const cache = path.join(RAW, `fftiers-${key}.csv`);
  let csv = null, status = "ok";
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    csv = await r.text();
    if (!csv || csv.length < 5000 || !csv.includes("Player.Name")) throw new Error("payload too small / wrong shape");
    fs.writeFileSync(cache, csv);
  } catch (e) {
    if (fs.existsSync(cache)) { csv = fs.readFileSync(cache, "utf8"); status = `fetch failed, using cache: ${e.message}`; }
    else return { map: new Map(), status: `unavailable (no cache): ${e.message}` };
  }
  const map = new Map();
  const lines = csv.trim().split("\n");
  const header = parseCsvLine(lines[0]).map((h) => h.replace(/"/g, ""));
  const col = (n) => header.indexOf(n);
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    const name = c[col("Player.Name")];
    if (!name) continue;
    map.set(normName(name), { rank: +c[col("Rank")], tier: +c[col("Tier")], pos: c[col("Position")] });
  }
  return { map, status };
}

/* A team's bye is the week it appears in no game. Derived rather than hand-kept so it self-updates,
   and validated on the way through — 32 teams, each with exactly one bye, or the map is thrown away
   rather than shipped half-right. */
async function byeWeeks() {
  const cache = path.join(RAW, `byes-${SEASON}.json`);
  try {
    const games = await get(`https://api.sleeper.app/schedule/nfl/regular/${SEASON}`);
    const weeks = [...new Set(games.map((g) => g.week))];
    const teams = [...new Set(games.flatMap((g) => [g.home, g.away]))];
    const map = {};
    for (const t of teams) {
      const played = new Set(games.filter((g) => g.home === t || g.away === t).map((g) => g.week));
      const off = weeks.filter((w) => !played.has(w));
      if (off.length !== 1) throw new Error(`${t} has ${off.length} byes, expected 1`);
      map[t] = off[0];
    }
    if (teams.length !== 32) throw new Error(`${teams.length} teams, expected 32`);
    fs.writeFileSync(cache, JSON.stringify(map));
    return map;
  } catch (e) {
    if (fs.existsSync(cache)) {
      console.warn(`byes: fetch failed (${e.message}); using cache`);
      return JSON.parse(fs.readFileSync(cache, "utf8"));
    }
    console.warn(`byes: UNAVAILABLE (${e.message}) and no cache — every player carries bye: null`);
    return {};
  }
}

// ---- fetch ------------------------------------------------------------------------------------

console.log("Fetching fftiers (3 formats), Sleeper players, projections, schedule...");
const [tiers, players, proj, byes] = await Promise.all([
  (async () => Object.fromEntries(await Promise.all(
    Object.keys(FORMATS).map(async (k) => [k, await fetchTiers(k)])
  )))(),
  get("https://api.sleeper.app/v1/players/nfl"),
  get(`https://api.sleeper.app/v1/projections/nfl/regular/${SEASON}`),
  byeWeeks(),
]);

for (const [k, v] of Object.entries(tiers)) {
  console.log(`  fftiers ${k.padEnd(4)}: ${v.map.size} ranked  (${v.status})`);
}

// ---- index Sleeper's player list by normalised name -------------------------------------------
// Only draftable fantasy positions, and only active players, or the name index fills with retired
// players and practice-squad bodies who can shadow a real match.
const DRAFTABLE = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const byName = new Map();
const byId = new Map();
for (const [id, p] of Object.entries(players)) {
  const pos = p.position;
  if (!DRAFTABLE.has(pos)) continue;
  if (pos !== "DEF" && p.active === false) continue;
  const name = pos === "DEF" ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() : (p.full_name ?? "");
  if (!name) continue;
  const rec = { id: String(id), name, pos, team: p.team ?? null, search_rank: p.search_rank ?? 9999999 };
  byId.set(rec.id, rec);
  const key = `${normName(name)}|${pos}`;
  // Sleeper carries duplicates of the same name; keep the one it ranks highest, which is the one
  // a tier list published for redraft is talking about.
  const prev = byName.get(key);
  if (!prev || rec.search_rank < prev.search_rank) byName.set(key, rec);
}
console.log(`Sleeper: ${byId.size} draftable players indexed`);

// ---- merge ------------------------------------------------------------------------------------

const rows = new Map();   // sleeper id -> row
const unmatched = { std: [], half: [], ppr: [] };

const rowFor = (rec) => {
  let r = rows.get(rec.id);
  if (!r) {
    r = { id: rec.id, n: rec.name, p: rec.pos, t: rec.team, b: byes[rec.team] ?? null, f: {} };
    rows.set(rec.id, r);
  }
  return r;
};

for (const [key, { map }] of Object.entries(tiers)) {
  for (const [nkey, t] of map) {
    // fftiers writes defenses as "Houston Texans" with position DST; Sleeper calls that DEF.
    const pos = t.pos === "DST" ? "DEF" : t.pos;
    const rec = byName.get(`${nkey}|${pos}`);
    if (!rec) { unmatched[key].push(`${t.rank}:${t.pos}`); continue; }
    rowFor(rec).f[key] = { r: t.rank, tr: t.tier };
  }
}

// ADP is attached per format from Sleeper's own projections. A player with an ADP but no tier still
// earns a row — that is the late-round pool you are picking from once the tiers run out.
for (const [id, pr] of Object.entries(proj)) {
  const rec = byId.get(String(id));
  if (!rec) continue;
  for (const [key, [, adpField]] of Object.entries(FORMATS)) {
    const v = pr?.[adpField];
    if (v == null || v >= 900) continue;              // >=900 is Sleeper's "undrafted" sentinel
    const r = rows.get(rec.id) ?? (Object.keys(pr).some((f) => /^adp_/.test(f)) ? rowFor(rec) : null);
    if (!r) continue;
    (r.f[key] ??= {}).a = Math.round(v * 10) / 10;
  }
}

/* Trim to a draft pool. Sleeper carries an ADP for two thousand players, most of whom are never
   picked in any league; keeping them costs 200KB on a phone to render rows nobody scrolls to. A
   player stays if he is tiered in any format, or if any format's ADP puts him inside ADP_FLOOR.
   The deepest sane draft is 16 rounds x 14 teams = 224 picks, so 300 leaves a wide flier margin. */
const ADP_FLOOR = 300;
for (const [id, r] of rows) {
  const keep = Object.values(r.f).some((f) => f.r != null || (f.a != null && f.a <= ADP_FLOOR));
  if (!keep) rows.delete(id);
  // Strip the sentinel-ish deep ADPs off rows that survived on another format's number, so the page
  // never prints "698.8" as if it meant something.
  else for (const f of Object.values(r.f)) if (f.a != null && f.a > ADP_FLOOR) delete f.a;
}

const list = [...rows.values()].sort((a, b) => (a.f.half?.r ?? 9999) - (b.f.half?.r ?? 9999));

const out = {
  generated: new Date().toISOString().slice(0, 10),
  season: SEASON,
  default_format: "half",
  formats: Object.fromEntries(Object.entries(FORMATS).map(([k, [, adpField, label]]) => [k, {
    label,
    adp_field: adpField,
    tiers_status: tiers[k].status,
    ranked: list.filter((r) => r.f[k]?.r != null).length,
    with_adp: list.filter((r) => r.f[k]?.a != null).length,
  }])),
  tiers_source: "Boris Chen fftiers (FantasyPros expert consensus, GMM tiers) — github.com/borisachen/fftiers",
  adp_source: "Sleeper projections ADP, per scoring format",
  players: list,
};

fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`\ndraft-aid.json: ${list.length} players, ${kb} KB`);
for (const [k, v] of Object.entries(out.formats)) {
  console.log(`  ${v.label.padEnd(9)} ${String(v.ranked).padStart(3)} tiered, ${String(v.with_adp).padStart(4)} with ADP`);
}
for (const [k, miss] of Object.entries(unmatched)) {
  if (miss.length) console.log(`  unmatched to Sleeper (${k}): ${miss.length} — ${miss.slice(0, 12).join(" ")}`);
}
