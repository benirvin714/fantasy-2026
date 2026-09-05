#!/usr/bin/env node
/* build-player-news.mjs — one dossier per rostered player, for the click-through on the dashboard.
 *
 * Everything here already exists somewhere in data/site; the point of this file is that none of it
 * is reachable from a player's name. The draft board carries the scouting brief and the price, the
 * events feed carries what changed this week, and the roster room knows who is actually rostered.
 * Joining them at build time means the browser fetches one 200KB file instead of the 800KB board.
 *
 * Inputs (all local, no network):
 *   <league out_dir>/roster-room.json  — who is rostered, and the league-scored projection
 *   data/site/draft-board.json         — scouting brief, ADP + commentary, availability, risk flags
 *   data/site/nfl-events.json          — the dated feed, already tagged with player names
 * Output:
 *   <league out_dir>/player-news.json
 *
 * The draft board and the events feed are shared across leagues on purpose: a scouting brief, an
 * ADP, an availability score and a news item are facts about a player, not about a league. Only the
 * roster join and the projection are per-league, and both come from that league's own roster room.
 *
 * Run it after the daily refresh, since two of the three inputs move daily.
 *   node scripts/build-player-news.mjs [--league=hbgbs|pit]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLeague } from "./lib/leagues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = resolveLeague();

/* LOCAL date, not toISOString() (UTC) — see the build-stamp note in progress.md. After ~7pm Central
   a UTC stamp files today's build under tomorrow's date, which made this file's `generated` disagree
   with the roster room's on the same run and would trip the dialog's own staleness check a day early. */
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const read = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.error(`Missing input: ${rel}. Nothing is written — a partial dossier file would read as "no news" for every player it silently dropped.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
};

const room = read(`${L.out_dir}/roster-room.json`);
const board = read("data/site/draft-board.json");
const events = read("data/site/nfl-events.json");

/* Name matching is the one join here that isn't an id, because the events feed is written by a
   research pass that names people the way sources do. Normalising drops case, punctuation and the
   generational suffix, which covers every mismatch seen so far ("Tyrone Tracy Jr." vs "Tyrone
   Tracy"). Anything still unmatched is reported at the end rather than dropped in silence. */
const norm = (s) => String(s ?? "")
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
  .replace(/[^a-z]/g, "");

const rostered = new Map();   // id -> { name, pos, team, pts, bye, roster_id, owner, where }
for (const t of room.teams) {
  const add = (p, where) => {
    if (!p) return;
    rostered.set(p.id, {
      id: p.id, name: p.name, pos: p.pos, team: p.team ?? null, pts: p.pts ?? null,
      bye: p.bye ?? null, injury: p.injury ?? null,
      roster_id: t.roster_id, owner: t.owner, is_me: !!t.is_me, where,
    });
  };
  for (const s of t.slots) add(s.player, s.slot);
  for (const p of t.bench) add(p, "BN");
}
if (!rostered.size) {
  console.error("roster-room.json has no rostered players. Build that first.");
  process.exit(1);
}

const byId = new Map(board.players.map((p) => [p.id, p]));
const byName = new Map();
for (const [id, r] of rostered) byName.set(norm(r.name), id);

/* Events, newest first, bucketed by the players they name. */
const evByPlayer = new Map();
const unmatched = new Set();
for (const e of events.events) {
  for (const n of e.players ?? []) {
    const id = byName.get(norm(n));
    if (!id) { unmatched.add(n); continue; }
    if (!evByPlayer.has(id)) evByPlayer.set(id, []);
    evByPlayer.get(id).push({
      date: e.date, type: e.type, headline: e.headline, detail: e.detail,
      so_what: e.so_what ?? null, source: e.source ?? null,
      /* An event naming four players is usually about one of them. Saying which other names it
         touched is cheaper than making the reader open all four to find that out. */
      also: (e.players ?? []).filter((x) => norm(x) !== norm(rostered.get(id).name)),
    });
  }
}
for (const list of evByPlayer.values()) list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

const players = {};
let withBrief = 0, withEvents = 0, offBoard = 0;
for (const [id, r] of rostered) {
  const b = byId.get(id);
  if (!b) offBoard++;
  const ev = evByPlayer.get(id) ?? [];
  if (ev.length) withEvents++;
  const sb = b?.scouting_brief;
  if (sb?.prose) withBrief++;

  players[id] = {
    id, name: r.name, pos: r.pos, team: r.team, bye: r.bye,
    roster: { roster_id: r.roster_id, owner: r.owner, is_me: r.is_me, slot: r.where },
    projection: b?.projection
      ? { pts: b.projection.pts, ppg: b.projection.ppg ?? null, updated: b.projection.updated ?? null }
      : (r.pts != null ? { pts: r.pts, ppg: null, updated: null } : null),
    adp: b?.adp?.half_ppr != null ? { half_ppr: b.adp.half_ppr, updated: b.adp.updated ?? null } : null,
    adp_commentary: b?.adp_commentary ?? null,
    availability: b?.availability
      ? {
          score: b.availability.score ?? null,
          expected_games: b.availability.expected_games ?? null,
          status: b.availability.current_injury_status ?? r.injury ?? null,
          history: b.availability.injury_history ?? null,
        }
      : (r.injury ? { score: null, expected_games: null, status: r.injury, history: null } : null),
    brief: sb?.prose
      ? {
          prose: sb.prose,
          role_stability: sb.role_stability ?? null,
          scheme_fit: sb.scheme_fit ?? null,
          rationale: sb.rationale ?? null,
          sources: (sb.sources ?? []).map((s) => ({ label: s.label, url: s.url, date: s.date ?? null, type: s.type ?? null })),
        }
      : null,
    situation: b?.situation?.facts?.length ? b.situation.facts : [],
    risk_notes: b?.risk_flags?.notes?.length ? b.risk_flags.notes : [],
    events: ev,
  };
}

const out = {
  generated: TODAY,
  sources: {
    events: events.updated ?? null,
    draft_board: board.generated ?? null,
    roster_room: room.generated ?? null,
  },
  coverage: {
    rostered: rostered.size,
    with_scouting_brief: withBrief,
    with_recent_events: withEvents,
    off_board: offBoard,
    unmatched_event_names: [...unmatched].sort(),
  },
  players,
};

const dest = path.join(ROOT, ...L.out_dir.split("/"), "player-news.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
const kb = (fs.statSync(dest).size / 1024).toFixed(0);

console.log(`${L.out_dir}/player-news.json — ${L.name}, ${rostered.size} rostered players, ${kb}KB`);
console.log(`  scouting brief: ${withBrief}   recent events: ${withEvents}   off the draft board: ${offBoard}`);
console.log(`  feeds: events ${out.sources.events} · board ${out.sources.draft_board} · room ${out.sources.roster_room}`);
if (unmatched.size) {
  console.log(`  ${unmatched.size} event names matched nobody rostered (expected — the feed covers the whole NFL):`);
  console.log(`    ${[...unmatched].sort().join(", ")}`);
}
