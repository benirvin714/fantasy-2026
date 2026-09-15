// Publish gate for /waivers: checks a league's waivers.json against step 7-8 of
// .claude/commands/waivers.md and against that league's LIVE Sleeper rosters.
//
// The opposite contract to validate-events.mjs, on purpose. That one quarantines item by item and
// always exits 0 so a 4am run never wedges. This one BLOCKS: the failure it exists for is a
// rostered player recommended as an add, which happened on 2026-09-15 (Devaughn Vele, on bwalsh89's
// roster, published to the HBGBs board and corrected by hand an hour later). A board that fails
// here must not be committed. Everything that is a judgment rather than a fact is a warning.
//
// ERRORS (exit 1)
//   - a target is on any roster in the league, or can't be resolved to exactly one Sleeper player
//   - a drop_player isn't on my roster
//   - the order breaks the step-7 sort, or rank isn't 1..N in file order
//   - a bad enum, a missing/over-60 hook, a non-integer bid_amount, a number in bid_amount for a
//     league with no pricing model, a non-numeric worth where worth is a sort key
//   - fills_empty_slot missing, on a non-PURSUE, or absent while my starters show an empty slot
// WARNINGS (exit 0)
//   - fewer than 15 targets (step 7 allows it when the pool is honestly thin)
//   - fills_empty_slot set with no `0` in starters (a bye- or injury-based empty can't be checked
//     from the rosters endpoint alone)
//   - `generated` isn't today, an enum not written lowercase, an em-dash in prose
// Exit 2: Sleeper unreachable. Treat as a failed gate, not a pass: the roster check is the point.
//
// Usage:
//   node scripts/validate-waivers.mjs --league=pit
//   node scripts/validate-waivers.mjs --all        every league in scripts/lib/leagues.mjs
//   node scripts/validate-waivers.mjs --league=pit --file=<path>   check a draft board before writing it

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAGUES, resolveLeague } from "./lib/leagues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALL = process.argv.includes("--all");
const FILE = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
if (ALL && FILE) { console.error("--file checks one league's board; use it with --league, not --all."); process.exit(1); }
const targets = ALL ? Object.values(LEAGUES) : [resolveLeague(process.argv.slice(2).filter((a) => !a.startsWith("--file=")))];

// Sleeper REST is Cloudflare-cached and serves stale rosters (CLAUDE.md), so every read is cache-busted.
const get = async (url) => {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}${Math.random().toString(36).slice(2, 7)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

const V = { pursue: 0, watch: 1, avoid: 2 };
const C = { high: 0, med: 1, low: 2 };
const P = { high: 0, medium: 1, low: 2 };
const today = new Date().toLocaleDateString("en-CA");   // YYYY-MM-DD in local time, as /waivers writes it

let players;
try { players = await get("https://api.sleeper.app/v1/players/nfl"); }
catch (e) { console.error(`Sleeper unreachable (${e.message}); gate NOT passed.`); process.exit(2); }

// Name + team, not name alone: "DeVonta Smith" is both an Eagles WR and a Panthers CB.
const byName = new Map();
for (const [id, p] of Object.entries(players)) {
  if (!p.team || !p.first_name) continue;
  const k = `${p.first_name} ${p.last_name}`.toLowerCase();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push({ id, team: p.team });
}
const resolve = (name, team) => {
  const all = byName.get(String(name).toLowerCase()) ?? [];
  const onTeam = team ? all.filter((c) => c.team === team) : all;
  return (onTeam.length ? onTeam : all).map((c) => c.id);
};

let failed = false;
for (const L of targets) {
  const file = FILE ? path.resolve(FILE) : path.join(ROOT, L.out_dir, "waivers.json");
  const errs = [], warns = [];
  if (!fs.existsSync(file)) { console.log(`${L.key}: skip, ${L.out_dir}/waivers.json does not exist`); continue; }

  let d;
  try { d = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { console.log(`${L.key}: FAIL, not valid JSON (${e.message})`); failed = true; continue; }

  let rosters;
  try { rosters = await get(`https://api.sleeper.app/v1/league/${L.league_id}/rosters`); }
  catch (e) { console.error(`${L.key}: Sleeper unreachable (${e.message}); gate NOT passed.`); process.exit(2); }

  const owner = new Map();
  for (const r of rosters) for (const pid of r.players ?? []) owner.set(pid, r.roster_id);
  const me = rosters.find((r) => r.roster_id === L.my_roster);
  const mine = new Set(me?.players ?? []);
  const emptySlots = (me?.starters ?? []).filter((s) => !s || s === "0").length;
  // A league without a FAAB model ships unpriced by design (waivers.md step 6a).
  const priced = L.faab_model != null;

  const list = Array.isArray(d.targets) ? d.targets : [];
  if (!Array.isArray(d.targets)) errs.push("no targets array");
  if (d.generated !== today) warns.push(`generated ${d.generated}, today is ${today}`);
  if (list.length < 15) warns.push(`${list.length} targets (step 7 asks for 15 unless the pool is thin; say why in note)`);

  const lc = (s) => String(s ?? "").toLowerCase();
  list.forEach((t, i) => {
    const who = t.player ?? `target ${i + 1}`;
    if (t.rank !== i + 1) errs.push(`${who}: rank ${t.rank} at position ${i + 1}`);
    for (const [field, map] of [["verdict", V], ["confidence", C], ["pressure", P]]) {
      if (!(lc(t[field]) in map)) errs.push(`${who}: ${field} "${t[field]}"`);
      else if (t[field] !== lc(t[field])) warns.push(`${who}: ${field} "${t[field]}" should be lowercase`);
    }
    if (!t.hook) errs.push(`${who}: no hook`);
    else if (t.hook.length > 60) errs.push(`${who}: hook is ${t.hook.length} chars (max 60)`);
    if (!(t.bid_amount === null || Number.isInteger(t.bid_amount))) errs.push(`${who}: bid_amount must be an integer or null`);
    if (!priced && t.bid_amount !== null) errs.push(`${who}: bid_amount ${t.bid_amount} in a league with no pricing model`);
    if (priced && typeof t.worth !== "number") errs.push(`${who}: worth must be a number here (it is a sort key)`);
    if (typeof t.fills_empty_slot !== "boolean") errs.push(`${who}: fills_empty_slot missing`);
    else if (t.fills_empty_slot && lc(t.verdict) !== "pursue") errs.push(`${who}: fills_empty_slot on a ${t.verdict}`);
    if (/—/.test(JSON.stringify(t))) warns.push(`${who}: em-dash in prose`);

    const ids = resolve(t.player, t.team);
    if (ids.length !== 1) errs.push(`${who} (${t.team}): matches ${ids.length} Sleeper players`);
    for (const id of ids) {
      if (owner.has(id)) errs.push(`${who}: ROSTERED by roster ${owner.get(id)}${owner.get(id) === L.my_roster ? " (mine)" : ""}`);
    }
    if (t.drop_player) {
      if (!resolve(t.drop_player).some((id) => mine.has(id))) errs.push(`${who}: drop_player "${t.drop_player}" is not on my roster`);
    }
  });

  const flagged = list.filter((t) => t.fills_empty_slot === true).length;
  if (emptySlots > 0 && flagged === 0) errs.push(`my starters show ${emptySlots} empty slot(s) and no target has fills_empty_slot`);
  if (flagged > emptySlots) warns.push(`${flagged} fills_empty_slot vs ${emptySlots} \`0\` slot(s) in starters; fine only if the extra is a bye or injury hole`);

  const key = (t) => [t.fills_empty_slot ? 0 : 1, V[lc(t.verdict)] ?? 9, priced ? -(Number(t.worth) || 0) : 0, C[lc(t.confidence)] ?? 9, P[lc(t.pressure)] ?? 9, String(t.player)];
  const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; } return 0; };
  const want = [...list].sort(cmp);
  const firstBad = want.findIndex((t, i) => t !== list[i]);
  if (firstBad >= 0) errs.push(`sort: position ${firstBad + 1} should be ${want[firstBad].player}, is ${list[firstBad].player}`);

  const status = errs.length ? "FAIL" : "OK";
  console.log(`${L.key}: ${status}, ${list.length} targets, ${errs.length} error(s), ${warns.length} warning(s)`);
  for (const e of errs) console.log(`  ERROR  ${e}`);
  for (const w of warns) console.log(`  warn   ${w}`);
  if (errs.length) failed = true;
}
process.exit(failed ? 1 : 0);
