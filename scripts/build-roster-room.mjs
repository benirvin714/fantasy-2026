/* Roster room — every team in the league as a scouting object.
 *
 * Reads the post-draft rosters, prices every rostered player in THIS league's scoring, then
 * answers four questions per team:
 *   1. how good is it        -> optimal starting lineup under this league's slot shape
 *   2. where is it strong    -> per-slot and per-position rank against the other teams
 *   3. who owns it           -> the owner dossier, where the league has one
 *   4. what can I get        -> trades that raise BOTH lineups, searched exhaustively, not guessed
 *
 * Nothing here is a judgment call the script invented. Every number traces to a projection, a
 * lineup recomputation, or a count over raw Sleeper transactions; every sentence of prose is
 * assembled from those numbers. Where a player can't be priced he is named and excluded rather
 * than assumed, because a missing projection silently read as 0 would fake a weakness.
 *
 * Runs per league:  node scripts/build-roster-room.mjs [--league=hbgbs|pit]
 * Output: <league out_dir>/roster-room.json   Page: site/rosters.html
 *
 * Two things vary by league and both are branches rather than assumptions. A league whose scoring
 * is not the draft board's re-prices every rostered player from Sleeper's raw projected stat lines
 * instead of reading the board's points. A league with no history (year one) has no owner dossiers
 * and no trade archive, so it reports the moves its teams have actually made this season instead of
 * a behavioural read it has no evidence for.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLeague, ordinal as ORD_N, spell } from "./lib/leagues.mjs";
import { weekSchedule, gameFor, weekProjections, weekActuals, hasWeekLine } from "./lib/nfl-week.mjs";
import * as PERF from "./lib/performance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = resolveLeague();
const LEAGUE_ID = L.league_id;
const OUT = path.join(ROOT, ...L.out_dir.split("/"), "roster-room.json");
const MY_ROSTER = L.my_roster;

// LOCAL date, not toISOString() (UTC) — see the build-stamp note in progress.md.
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

// Sleeper sits behind Cloudflare with stale-while-revalidate; anything fast-changing needs a
// unique param or you can read a roster that predates the last three transactions.
const get = async (url) => {
  const sep = url.includes("?") ? "&" : "?";
  const r = await fetch(`${url}${sep}cb=${Date.now()}${Math.random()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

/* ------------------------------------------------------------------ inputs */
console.log("Fetching league state, rosters, users, draft...");
const [league, rosters, users, state] = await Promise.all([
  get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}`),
  get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/rosters`),
  get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/users`),
  get("https://api.sleeper.app/v1/state/nfl"),
]);

const drafts = await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/drafts`);
const draft = drafts.find((d) => d.status === "complete") ?? drafts[0] ?? null;
const picks = draft && draft.status === "complete"
  ? await get(`https://api.sleeper.app/v1/draft/${draft.draft_id}/picks`)
  : [];

/* Read from the live roster count, never hardcoded: a team count that disagrees with the league is
   the kind of quiet wrongness every guard in this file exists to prevent. */
const TEAMS = rosters.length;

const board = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "site", "draft-board.json"), "utf8"));
const byId = new Map(board.players.map((p) => [p.id, p]));

/* Rosters are only meaningful once the draft has run. Ten empty rosters would produce ten
   identical "0 points, weak everywhere" cards, which reads as analysis and is noise. */
const filled = rosters.filter((r) => (r.players ?? []).length > 0).length;
if (filled < rosters.length) {
  console.error(`Refusing to build: ${filled}/${rosters.length} rosters have players. ` +
    `The draft (${draft ? draft.status : "none"}) has to finish first.`);
  process.exit(1);
}

/* -------------------------------------- pricing the handful of players outside the board pool
   The board is the top 200 skill players + 32 DEF. A 15-round draft reaches past that, so a few
   last-round fliers arrive with no entry. Rather than drop them (they would vanish off a bench
   that really does hold them) they get the same treatment the board gives everyone: Sleeper's
   2026 projected stat line re-scored with this league's exact settings. */
const scoring = JSON.parse(
  fs.readFileSync(path.join(ROOT, ...L.scoring_snapshot.split("/")), "utf8")).scoring_settings;
const SKILL_KEYS = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt",
  "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost"];
const K_KEYS = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "xpm", "xpmiss",
  "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49"];
const DEF_KEYS = ["sack", "int", "fum_rec", "blk_kick", "safe", "def_td"];
/* Sleeper's kicker projection only carries fgmiss_40_49 and fgmiss_50p, so a league that bands its
   miss penalties can never be scored exactly from it. A league with a FLAT `fgmiss` can: the
   penalty is the same at every distance, so it applies to every miss bucket the projection has.
   The HBGBs bands; the Panther Pit is flat. Handling both here rather than assuming one is what
   lets a second league share this script without its kickers being scored in someone else's rules. */
const MISS_KEYS = ["fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49", "fgmiss_50p"];
const FLAT_MISS = scoring.fgmiss != null && scoring.fgmiss !== 0;

function rescore(p, pos) {
  if (!p) return null;
  let pts = 0;
  const keys = pos === "K" ? K_KEYS : pos === "DEF" ? DEF_KEYS : SKILL_KEYS;
  for (const k of keys) {
    if (FLAT_MISS && MISS_KEYS.includes(k)) continue;   // charged below instead, at one flat rate
    if (p[k] != null && scoring[k] != null) pts += p[k] * scoring[k];
  }
  if (pos === "K") {
    if (p.fgm_50p != null) pts += p.fgm_50p * (scoring.fgm_50_59 ?? 5);
    if (FLAT_MISS) for (const k of MISS_KEYS) if (p[k] != null) pts += p[k] * scoring.fgmiss;
  }
  return +pts.toFixed(1);
}

/* ------------------------------------------------------ what on a board entry is format-specific
   The merge below keeps everything on a board record except the projection, on the stated grounds
   that the rest is league-agnostic. That was true while every league was half PPR. It is not true
   any more, and the two exceptions are easy to miss because neither one announces itself:

     - `adp` is literally `{ half_ppr: <n> }` - Sleeper publishes adp_std / adp_half_ppr / adp_ppr
       and build-draft-board.mjs reads the half. In a full-PPR league that number is another
       format's market, and pass-catchers are exactly where the two markets disagree.
     - `fftiers` is Boris Chen's weekly-ALL-HALF-PPR.csv. He publishes a -PPR file too (the phone
       Draft Aid already fetches all three); the desktop board bakes in the half.

   Rather than ship either one under the wrong league's label, a league whose reception value does
   not match the board's drops both and says so in `basis`. The scouting brief, availability, bye
   week and risk flags genuinely are format-agnostic and are kept. The better fix is for
   build-draft-board.mjs to carry all three formats the way build-draft-aid.mjs does; until it
   does, dropping beats guessing. */
const BOARD_REC = 0.5;                       // build-draft-board.mjs: adp_half_ppr + weekly-ALL-HALF-PPR
const REC_MATCHES = (scoring.rec ?? 0) === BOARD_REC;
const boardMarket = (rec) => {
  if (REC_MATCHES) return rec;
  const { adp, adp_commentary, fftiers, ...rest } = rec;
  return rest;
};
if (!REC_MATCHES) {
  console.log(`${L.name} scores receptions at ${scoring.rec}, the board at ${BOARD_REC} — dropping the board's half-PPR ADP and Boris Chen tiers rather than relabelling them.`);
}

const rosteredIds = [...new Set(rosters.flatMap((r) => r.players))];
/* The draft board's projection.pts is scored in the HBGBs' settings. For that league the board's
   number IS this league's number and is used as-is; for any other league it is another league's
   arithmetic wearing this league's label, so every rostered player is re-priced from the raw stat
   lines. The board's league-agnostic half - ADP, Boris Chen tier, scouting brief, availability -
   is still read straight through, because none of it depends on scoring. */
const offBoard = L.board_scored
  ? rosteredIds.filter((id) => !byId.has(id))
  : rosteredIds;
/* Kept at file scope: the performance section below needs the same two feeds (positions for
   dropped players, and prices for the free-agent pool), and fetching 5MB twice is not free. */
let allPlayers = null, proj = null;
if (offBoard.length) {
  console.log(L.board_scored
    ? `${offBoard.length} rostered player(s) outside the board pool — pricing from Sleeper directly.`
    : `Re-pricing all ${offBoard.length} rostered players in ${L.name}'s own scoring.`);
  [allPlayers, proj] = await Promise.all([
    get("https://api.sleeper.app/v1/players/nfl"),
    get("https://api.sleeper.app/v1/projections/nfl/regular/2026"),
  ]);
  let repriced = 0, added = 0, unknown = 0;
  for (const id of offBoard) {
    const onBoard = byId.get(id);
    const sp = allPlayers[id];
    if (!onBoard && !sp) { console.warn(`  ${id}: unknown to Sleeper — listed as unpriced`); unknown++; continue; }
    const pos = onBoard ? onBoard.pos : sp.position;
    const pts = rescore(proj[id], pos);
    const projection = { pts, method: `Sleeper projected stat line re-scored with ${L.name}'s exact scoring_settings` };
    if (onBoard) {
      /* MERGE, never replace. Everything else on a board entry - bye week, ADP, the scouting
         brief, the availability model, risk flags - is league-agnostic and is the reason the two
         leagues share one board. Overwriting the record to change one number would silently drop
         the bye weeks the risk panel counts stacks from. */
      byId.set(id, { ...boardMarket(onBoard), projection });
      repriced++;
    } else {
      byId.set(id, {
        id, name: `${sp.first_name} ${sp.last_name}`.trim(), pos, team: sp.team, age: sp.age,
        years_exp: sp.years_exp, bye: null, rookie: sp.years_exp === 0, off_board: true,
        projection,
        availability: { current_injury_status: sp.injury_status || null },
        adp: {}, risk_flags: {},
      });
      added++;
      console.log(`  off board: ${sp.first_name} ${sp.last_name} (${pos} ${sp.team}) = ${pts} pts`);
    }
  }
  if (repriced) console.log(`  ${repriced} board players re-priced in ${L.name}'s scoring, everything else on their record kept.`);
  if (added) console.log(`  ${added} player(s) priced from Sleeper directly (outside the board pool).`);
  if (unknown) console.log(`  ${unknown} unknown to Sleeper — left unpriced.`);
}

/* ------------------------------------------------------- the week in front of the roster
   Everything above prices a season. A season number is the right basis for a trade and the wrong
   one for a Sunday: it cannot tell you that your WR2 is on a bye, and it flattens a Thursday
   kickoff into the same cell as a Monday night one. So each rostered player also carries the one
   week the league is currently on - who he plays, when that game starts, and what he is projected
   to score in it.

   Priced by the same rescore() the rest of this build uses, so the week number and the season
   number are the same arithmetic over the same source in the same league's settings. What it is
   NOT is a slice of the season projection: Sleeper publishes a separate week-N stat line, and this
   reads that. Summing seventeen of them will land near the season figure without matching it, and
   neither one is wrong.

   A missing week number is null, never zero. A player on a bye still has a projection row - it
   just holds nothing but an ADP field, which prices to 0.0 and would read on the page as
   "projected to score nothing" when the truth is "no projection was published". */
/* WHICH WEEK. Sleeper's display_week lags by design: it still read 1 at midday on Tuesday
   2026-09-15, with all 32 of week 1's games final and week 2 four days away. That is correct for
   the Sleeper app, which is still showing you last week's box scores, and wrong for this panel,
   which exists to tell you who to play. So the week is chosen from the schedule rather than from
   either state field: start at display_week, and if every one of its games is already complete,
   roll forward to the next week that has any. Derived from what the games did rather than from what
   a field is supposed to mean, so it cannot drift when Sleeper changes when that field flips. */
let WEEK = Math.max(1, +state.display_week || +state.week || 1);
let sched = await weekSchedule(state.season, WEEK);
if (WEEK < 18 && sched.teams_playing > 0 && [...sched.byTeam.values()].every((g) => g.completed)) {
  const next = await weekSchedule(state.season, WEEK + 1);
  if (next.teams_playing > 0) {
    console.log(`  week ${WEEK} is complete (all ${sched.teams_playing} teams played) — the panel rolls to week ${WEEK + 1}, which is the one still to play.`);
    WEEK += 1;
    sched = next;
  }
}
console.log(`\nWeek ${WEEK}: fetching the schedule and this week's projections...`);
const wproj = await weekProjections(state.season, WEEK);
const wact = await weekActuals(LEAGUE_ID, WEEK);
for (const w of sched.warnings) console.warn(`  ! ${w}`);
if (wproj.error) console.warn(`  ! week ${WEEK} projections unavailable (${wproj.error}) — every player's week number will be null and the page will say so.`);
if (wact.error) console.warn(`  ! week ${WEEK} results unavailable (${wact.error}) — finished games will keep showing their kickoff rather than a score.`);

const weekPts = new Map();
for (const id of rosteredIds) {
  const row = wproj.rows[id];
  if (!hasWeekLine(row)) continue;
  const p = byId.get(id);
  weekPts.set(id, rescore(row, p ? p.pos : null));
}
/* What he actually scored, attached only once his game is over.
   `game.completed` is ESPN's own boolean and is the gate, NOT the presence of a number: every
   rostered player carries a players_points entry from kickoff onward, and it reads 0 until he does
   something. Gating on the number would turn "has not played yet" and "played and scored nothing"
   into the same cell, and those are the two readings a lineup decision most needs kept apart.

   A game in progress at build time is reported as such rather than as a result. The build runs
   twice a day, so an afternoon run lands mid-window on a Sunday: the number is real but partial,
   and the page labels it instead of presenting half a game as a final score. */
const DESIGNATED_OUT = new Set(["Out", "Doubtful", "IR", "PUP", "NFI", "Sus", "DNR", "COV"]);
const outFor = (p) => {
  const d = p && p.availability ? p.availability.current_injury_status : null;
  return d && DESIGNATED_OUT.has(d) ? d : null;
};

const weekOf = (id) => {
  const p = byId.get(id);
  const game = gameFor(sched, p ? p.team : null, p ? p.bye : null);
  const live = !!game && !game.completed && game.status === "STATUS_IN_PROGRESS";
  const done = !!game && game.completed === true;
  const scored = wact.pts.has(id) ? wact.pts.get(id) : null;
  return {
    week_pts: weekPts.has(id) ? weekPts.get(id) : null,
    week_actual: (done || live) && scored != null ? { pts: scored, final: done } : null,
    game,
  };
};
{
  const idle = rosteredIds.filter((id) => {
    const g = weekOf(id).game;
    return g && g.status === "unknown";
  });
  const scored = rosteredIds.filter((id) => weekOf(id).week_actual != null);
  const finals = [...sched.byTeam.values()].filter((g) => g.completed).length;
  console.log(`  ${sched.teams_playing}/32 teams play in week ${WEEK} · ${weekPts.size}/${rosteredIds.length} rostered players have a week-${WEEK} projection`);
  const gated = rosteredIds.filter((id) => outFor(byId.get(id)) && weekPts.has(id));
  if (gated.length) console.log(`  ${gated.length} player(s) held out of every week-${WEEK} lineup on their Sleeper designation despite carrying a projection: ` +
    gated.map((id) => `${byId.get(id).name} (${outFor(byId.get(id))}, ${weekPts.get(id)} pts)`).join(", "));
  console.log(`  ${finals} of those teams have finished · ${scored.length} rostered player(s) carry a result (league-scored by Sleeper, not recomputed here)`);
  if (sched.canceled.length) console.log(`  canceled: ${sched.canceled.join("; ")}`);
  /* Not a bye and not a game: either the schedule is short a row or a player is on a team code the
     schedule does not carry. Named rather than swallowed, because the page renders it as an honest
     blank and a silent one would look identical to a bye. */
  if (idle.length) console.warn(`  ! ${idle.length} rostered player(s) have neither a week-${WEEK} game nor a bye: ` +
    idle.map((id) => `${byId.get(id)?.name ?? id} (${byId.get(id)?.team ?? "?"})`).join(", "));
}

/* ------------------------------------------- owner dossiers, parsed from league-tendencies.md
   Parsed rather than copied into JSON: the markdown is the one home for these facts, and a copy
   would rot the first time a dossier is revised. The parser is strict on purpose — if the file's
   shape changes it fails the build instead of shipping nine owners out of ten. */
function parseDossiers() {
  const md = fs.readFileSync(path.join(ROOT, ...L.dossiers.split("/")), "utf8");
  const out = new Map();
  // "### mfkr (commissioner, roster 1)" and "### ThatWasButtery — you (roster 10). Self-scout."
  for (const sec of md.split(/^### /m).slice(1)) {
    const head = sec.split("\n", 1)[0];
    const m = head.match(/roster (\d+)\)/);
    if (!m) continue;
    const fields = {};
    for (const line of sec.split("\n")) {
      const f = line.match(/^-\s+\*\*([^:*]+):\*\*\s*(.+)$/);
      if (f) fields[f[1].trim().toLowerCase().replace(/ habits$/, "")] = f[2].trim();
    }
    out.set(+m[1], { owner: head.split(/\s+[—(]/)[0].trim(), ...fields });
  }
  return out;
}
/* A league with no dossier file has no owner read, and that is a fact rather than a failure: the
   Panther Pit is in its first season and nobody has done anything yet to have tendencies about.
   The strict guard still applies to any league that DOES claim dossiers - partial tendencies are
   worse than none, because nine owners out of ten reads as complete. */
const dossiers = L.dossiers ? parseDossiers() : new Map();
if (L.dossiers && dossiers.size !== rosters.length) {
  console.error(`Refusing to build: parsed ${dossiers.size} dossiers from ${L.dossiers}, ` +
    `expected ${rosters.length}. The "### <owner> (roster N)" heading shape changed — fix the ` +
    `parser rather than shipping partial tendencies.`);
  process.exit(1);
}

/* ------------------------------------------ trade history, counted from the raw archive
   The dossier prose states these counts; recomputing them here means the page's partner ranking
   cannot drift away from the file it quotes, and it gives a number to sort partners by. */
function tradeHistory() {
  const per = {}, channel = {}, years = {};
  let total = 0;
  for (let y = L.trade_archive.from; y <= L.trade_archive.to; y++) {
    const f = path.join(ROOT, "data", "raw", `transactions-${y}.json`);
    if (!fs.existsSync(f)) continue;
    const tr = JSON.parse(fs.readFileSync(f, "utf8"))
      .filter((t) => t.type === "trade" && t.status === "complete");
    total += tr.length;
    years[y] = tr.length;
    for (const t of tr) {
      const ids = t.roster_ids || [];
      for (const a of ids) {
        per[a] = (per[a] || 0) + 1;
        channel[a] = channel[a] || {};
        for (const b of ids) if (a !== b) channel[a][b] = (channel[a][b] || 0) + 1;
      }
    }
  }
  return { per, channel, total, years, seasons: `${L.trade_archive.from}-${L.trade_archive.to}` };
}

/* ---------------------------------------------- moves: what a year-one league can actually say
   With no archive there is no behavioural read to make, so the page reports observed activity
   instead of inferred appetite: completed transactions this season, per roster, straight off
   Sleeper. In week 1 that is zero for everybody and says so; by week 6 it is a real signal, and
   unlike a borrowed appetite band it was never wrong in the meantime. */
async function seasonMoves() {
  const per = {}, kinds = { trade: 0, waiver: 0, free_agent: 0 };
  const through = Math.max(1, +state.week || 1);
  let total = 0;
  for (let w = 1; w <= through; w++) {
    let tx = [];
    try { tx = await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/transactions/${w}`); }
    catch { continue; }   // a week Sleeper will not serve is skipped, not counted as zero moves
    for (const t of tx) {
      if (t.status !== "complete") continue;
      total++;
      if (kinds[t.type] != null) kinds[t.type]++;
      for (const rid of t.roster_ids || []) per[rid] = (per[rid] || 0) + 1;
    }
  }
  return { per, total, kinds, through_week: through };
}

const trades = L.trade_archive ? tradeHistory() : null;
const moves = L.trade_archive ? null : await seasonMoves();
if (moves) console.log(`No trade archive for ${L.name} — counted ${moves.total} completed move(s) through week ${moves.through_week}.`);

/* --------------------------------------------------------------------- the lineup model
   QB / RB / RB / WR / WR / TE / FLEX / FLEX / K / DEF, five bench, one IR. Greedy is provably
   optimal here because slot eligibility nests: the dedicated slots take the best at each position
   (any legal lineup must carry two RBs, so it can only lose by carrying worse ones), then the two
   FLEX take the best of everything left. That property is what makes the marginal-gain search
   below trustworthy — it compares true optima, not two greedy approximations. */
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
const FLEX_OK = new Set(["RB", "WR", "TE"]);
const ptsOf = (p) => (p && p.projection && p.projection.pts != null ? p.projection.pts : null);

/* `score` is a parameter so the week lineup reuses this greedy rather than growing a second copy of
   it. The optimality proof is a property of the slot shape (eligibility nests: every QB slot taker
   is a QB, every FLEX taker is an RB/WR/TE), not of which number is being maximised, so it holds
   for any scorer. Season is the default and that path is unchanged. */
function assignLineup(ids, score = ptsOf) {
  const pool = ids.map((id) => byId.get(id)).filter((p) => p && score(p) != null);
  const byPos = {};
  for (const p of pool) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  for (const k in byPos) byPos[k].sort((a, b) => score(b) - score(a));
  const used = new Set(), lineup = [];
  const take = (arr) => {
    const p = (arr || []).find((x) => !used.has(x.id));
    if (p) used.add(p.id);
    return p || null;
  };
  for (const slot of SLOTS) {
    if (slot === "FLEX") {
      const cands = pool.filter((p) => FLEX_OK.has(p.pos) && !used.has(p.id))
        .sort((a, b) => score(b) - score(a));
      lineup.push({ slot, player: take(cands) });
    } else lineup.push({ slot, player: take(byPos[slot]) });
  }
  const bench = pool.filter((p) => !used.has(p.id)).sort((a, b) => score(b) - score(a));
  const unpriced = ids.filter((id) => score(byId.get(id)) == null);
  const total = +lineup.reduce((a, s) => a + (score(s.player) || 0), 0).toFixed(1);
  return { lineup, bench, unpriced, total };
}
const lineupPts = (ids) => assignLineup(ids).total;

/* ------------------------------------------------------------------------ team objects */
const nameOf = {};
for (const u of users) nameOf[u.user_id] = u.display_name;
const slotOf = {};
for (const p of picks) if (p.round === 1) slotOf[p.roster_id] = p.draft_slot;
const draftRoundOf = new Map();
for (const p of picks) draftRoundOf.set(p.player_id, p.round);

const teams = rosters
  .map((r) => ({
    roster_id: r.roster_id,
    owner: nameOf[r.owner_id] || String(r.owner_id),
    user_id: r.owner_id,
    is_me: r.roster_id === MY_ROSTER,
    draft_slot: slotOf[r.roster_id] != null ? slotOf[r.roster_id] : null,
    ids: r.players,
    ...assignLineup(r.players),
  }))
  .sort((x, y) => x.roster_id - y.roster_id);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1);
};

/* Rank each team at every slot against the others. Slot rank is the honest read of a weakness:
   "your RB2 is 9th of 10 at that slot" is actionable in a way "7th in RB points" is not. */
const slotTable = SLOTS.map((slot, i) => {
  const vals = teams.map((t) => ({ rid: t.roster_id, pts: ptsOf(t.lineup[i].player) || 0 }));
  const sorted = [...vals].sort((a, b) => b.pts - a.pts);
  const rank = {};
  sorted.forEach((v, ix) => { rank[v.rid] = ix + 1; });
  return { slot, index: i, median: median(vals.map((v) => v.pts)), best: sorted[0].pts, rank };
});

const POSES = ["QB", "RB", "WR", "TE", "K", "DEF"];
for (const t of teams) {
  t.starting_by_pos = {};
  for (const pos of POSES) {
    const inLineup = t.lineup.filter((s) => s.player && s.player.pos === pos);
    t.starting_by_pos[pos] = {
      pts: +inLineup.reduce((a, s) => a + ptsOf(s.player), 0).toFixed(1),
      starters: inLineup.length,
      rostered: t.ids.filter((id) => byId.get(id) && byId.get(id).pos === pos).length,
    };
  }
}

/* ------------------------------------------- this week's lineup, and how close each call is
   The `lineup` above is the SEASON optimum, which is the right basis for judging a roster and the
   wrong one for setting a lineup on Sunday. Rerunning the same greedy over week_pts gives the week
   optimum, and the difference between the two is the start/sit advice: who the season lineup would
   have you play that this week's numbers would not.

   HOW CLOSE the call is matters as much as which way it goes, and it is the half a colour alone
   cannot carry. Measured over weeks 2-8 of 2026 across 200 skill players with a real line, a
   player's own weekly projection moves with a median coefficient of variation of 7.8% - about 0.8
   points on a 10-point player - so the gap between two players wobbles by roughly 1.1 points
   (0.8 x sqrt 2) from nothing but the projection being refreshed. A 0.2-point edge is therefore not
   an edge, and CLOSE_PTS marks the band where this file is ordering names it cannot actually
   separate. It is NOT a claim about forecast accuracy against reality, which is far wider; it is
   the narrower and checkable claim that below this gap the projection is not even self-consistent.

   Availability is decided before points and is not a judgment: no published week line (Sleeper
   omits one for a player it has Out, PUP, Doubtful or IR) and a bye both mean he cannot be in the
   lineup, so he is marked `sit` with that as the stated reason rather than with a number. */
const CLOSE_PTS = 1.5;

/* AVAILABILITY IS DECIDED BEFORE POINTS, and it needs its own gate rather than leaning on a missing
   projection. §1.27 observed that Sleeper publishes no weekly stat line for a player it lists Out,
   and that is true of the week in progress and NOT true of the week ahead: on 2026-09-15, with week
   1 finished, TreVeyon Henderson and Zay Flowers were both live-listed Out and both carried a full
   week-2 projection (8.4 and 14.4). Ranking on points alone would have put two players the league
   lists as unavailable into the recommended lineup, in green, which is the one mistake a start/sit
   panel cannot make.

   Doubtful is gated with Out: the designation means the team expects him not to play. Questionable
   is NOT gated - it resolves to active far more often than not, and benching every Questionable
   player would empty half a lineup every week.

   The designations on the board are refreshed by the daily draft-board build from Sleeper's live
   player records, so this self-corrects: the Tuesday leftovers from last week's report clear when
   the new week's report lands, and the next build flips the call back. The projection itself is
   still published and still shown in the Wk column, because it is a real number about the player;
   what changes is only whether he can be in the lineup. */
const weekScore = (p) => (p && weekPts.has(p.id) && !outFor(p) ? weekPts.get(p.id) : null);

for (const t of teams) {
  const wk = assignLineup(t.ids, weekScore);
  const inWeek = new Set(wk.lineup.map((s) => s.player && s.player.id).filter(Boolean));
  t.week_lineup = wk;
  t.week_call = new Map();
  for (const id of t.ids) {
    const p = byId.get(id);
    const g = weekOf(id).game;
    if (weekScore(p) == null) {
      const out = outFor(p);
      t.week_call.set(id, {
        start: false, margin: null, close: false,
        why: g && g.status === "bye"
          ? `On bye in week ${WEEK}.`
          : out
            ? `Sleeper lists him ${out}${weekPts.has(id) ? `, so he is out of the lineup whatever his ${weekPts.get(id)}-point projection says` : ""}. Availability is decided before points. If the designation clears, the next build puts him back.`
            : `No week-${WEEK} projection published. Not a judgment about him, just nothing to rank.`,
      });
      continue;
    }
    if (inWeek.has(id)) {
      /* What the lineup loses if he sits: the week optimum minus the best lineup available without
         him. That is the real cost of the swap, not a raw points difference, because his
         replacement may cascade through the FLEX slots. */
      const without = assignLineup(t.ids.filter((x) => x !== id), weekScore).total;
      const margin = +(wk.total - without).toFixed(1);
      t.week_call.set(id, {
        start: true, margin, close: margin < CLOSE_PTS,
        why: margin < CLOSE_PTS
          ? `In the week-${WEEK} lineup, but only by ${margin} — inside the ${CLOSE_PTS}-point band where the projection cannot separate two players. Treat it as a coin flip.`
          : `In the week-${WEEK} lineup. Benching him costs ${margin} projected points.`,
      });
    } else {
      /* What he would add: the best single slot he could take, against the man holding it. Zero or
         negative for everyone on a correctly optimal bench, so it is reported as how far short. */
      let best = -Infinity, over = null;
      for (const s of wk.lineup) {
        if (!s.player || !(s.slot === "FLEX" ? FLEX_OK.has(p.pos) : s.slot === p.pos)) continue;
        const d = weekScore(p) - weekScore(s.player);
        if (d > best) { best = d; over = s.player; }
      }
      const short = best === -Infinity ? null : +(-best).toFixed(1);
      t.week_call.set(id, {
        start: false, margin: short, close: short != null && short < CLOSE_PTS,
        why: short == null
          ? `No slot he is eligible for in week ${WEEK}.`
          : short < CLOSE_PTS
            ? `Out of the week-${WEEK} lineup by ${short}, against ${over.name} — inside the ${CLOSE_PTS}-point band where the projection cannot separate two players. Treat it as a coin flip.`
            : `${short} short of ${over.name}, the weakest starter he could replace in week ${WEEK}.`,
      });
    }
  }
}

const posTable = {};
for (const pos of POSES) {
  const vals = teams.map((t) => ({ rid: t.roster_id, pts: t.starting_by_pos[pos].pts }));
  const sorted = [...vals].sort((a, b) => b.pts - a.pts);
  const rank = {};
  sorted.forEach((v, i) => { rank[v.rid] = i + 1; });
  posTable[pos] = { median: median(vals.map((v) => v.pts)), rank };
}
[...teams].sort((a, b) => b.total - a.total).forEach((t, i) => { t.starter_rank = i + 1; });
const leagueMedianStarters = median(teams.map((t) => t.total));

/* ------------------------------------------------------ surplus: who else would start him
   The cleanest definition of a trade asset in a five-bench league is a player who improves
   someone else's starting lineup while sitting on yours. Counted by actually recomputing the
   other optimal lineups with him inserted, not by comparing ranks. */
for (const t of teams) {
  for (const p of t.bench) {
    let starts = 0, best = 0, bestRid = null;
    for (const o of teams) {
      if (o.roster_id === t.roster_id) continue;
      const g = +(lineupPts([...o.ids, p.id]) - o.total).toFixed(1);
      if (g > 0) { starts++; if (g > best) { best = g; bestRid = o.roster_id; } }
    }
    p._surplus = {
      starts_on: starts, best_gain: best, best_team: bestRid,
      own_cost: +(t.total - lineupPts(t.ids.filter((x) => x !== p.id))).toFixed(1),
    };
  }
}

/* ---------------------------------------------------------------------- trade search
   Exhaustive over 1-for-1 and 2-for-1 between my roster and each other team. A proposal survives
   only if BOTH optimal lineups go up — one-sided "wins" are the fastest way to make a trade page
   useless. The 2-for-1 rule is the league doctrine made literal: with two FLEX and only five bench
   spots, concentrating two startable pieces into one better one is structurally +EV here, so the
   test is that they take on MORE raw projected points than they give (quantity) while I take the
   better single player (quality) and free a bench slot. */
const GAIN_1 = 5;                        // season points, roughly 0.3/wk. Below this is projection noise.
const GAIN_2_ME = 8, GAIN_2_THEM = 5;

const rawPts = (id) => ptsOf(byId.get(id)) || 0;
const label = (id) => {
  const p = byId.get(id);
  return {
    id, name: p ? p.name : id, pos: p ? p.pos : "?", team: p ? p.team : null,
    pts: ptsOf(p), round: draftRoundOf.has(id) ? draftRoundOf.get(id) : null,
  };
};

const me = teams.find((t) => t.roster_id === MY_ROSTER);

function proposalsFor(them) {
  const out = [], mine = me.ids, theirs = them.ids;

  for (const a of mine) {
    for (const b of theirs) {
      const myGain = +(lineupPts([...mine.filter((x) => x !== a), b]) - me.total).toFixed(1);
      if (myGain < GAIN_1) continue;
      const thGain = +(lineupPts([...theirs.filter((x) => x !== b), a]) - them.total).toFixed(1);
      if (thGain < GAIN_1) continue;
      out.push({ kind: "1-for-1", give: [label(a)], get: [label(b)], my_gain: myGain, their_gain: thGain, frees_bench: 0 });
    }
  }

  for (let i = 0; i < mine.length; i++) {
    for (let j = i + 1; j < mine.length; j++) {
      const a1 = mine[i], a2 = mine[j];
      const rest = mine.filter((x) => x !== a1 && x !== a2);
      for (const b of theirs) {
        if (rawPts(a1) + rawPts(a2) <= rawPts(b)) continue;   // they must gain volume, or it is not a consolidation
        const myGain = +(lineupPts([...rest, b]) - me.total).toFixed(1);
        if (myGain < GAIN_2_ME) continue;
        const thGain = +(lineupPts([...theirs.filter((x) => x !== b), a1, a2]) - them.total).toFixed(1);
        if (thGain < GAIN_2_THEM) continue;
        out.push({ kind: "2-for-1", give: [label(a1), label(a2)], get: [label(b)], my_gain: myGain, their_gain: thGain, frees_bench: 1 });
      }
    }
  }

  // Dedupe on the player coming back, keeping the version that pays me most: ten variants of
  // "get McBride" is a wall, not a set of options.
  const best = new Map();
  for (const p of out.sort((x, y) => y.my_gain - x.my_gain || y.their_gain - x.their_gain)) {
    const k = p.get.map((g) => g.id).join("+");
    if (!best.has(k)) best.set(k, p);
  }
  return [...best.values()].slice(0, 4);
}

/* ------------------------------------------------------------------ complementarity
   Most pairs of post-draft rosters have no deal that clears the mutual-gain bar, and a card that
   just says "no proposals" is the least useful thing this page could print. What helps is the raw
   material underneath — but the obvious way to measure it is wrong. Scoring a player by what he
   would add to the other lineup just ranks him by how good he is: Jonathan Taylor "fits" all nine
   teams, which is true and worth nothing.
   The signal is the DIFFERENCE. `net` is what a player adds to the receiving lineup minus what he
   costs the one losing him, so it is positive only where he is worth more over there than here.
   That is the whole basis of a trade, and it is why these two lists are exactly the candidate pool
   the 1-for-1 search draws from: a deal needs a positive-net player going each way. */
const gainOf = (team, id) => +(lineupPts([...team.ids, id]) - team.total).toFixed(1);
const costOf = (team, id) => +(team.total - lineupPts(team.ids.filter((x) => x !== id))).toFixed(1);

function fitWith(them) {
  /* Sorted by net, then by what the player costs the side giving him up — cheapest first. That
     second key is doing more work than it looks. Net collapses to a constant for every player who
     slots into the same hole, because both legs are measured against the same replacement level;
     the gap is a property of the two rosters, not of the player. So a five-name list at an
     identical net is not a bug, it is the answer: the surplus is worth exactly that much either
     way, and the move is to hand over the one it costs you least to lose. */
  const rank = (a, b) => b.net - a.net || a.cost - b.cost;
  const priced = (ids, gainTeam, costTeam) => ids
    .map((id) => {
      const gain = gainOf(gainTeam, id), cost = costOf(costTeam, id);
      return { ...label(id), gain, cost, net: +(gain - cost).toFixed(1) };
    })
    .filter((x) => x.net > 0).sort(rank).slice(0, 5);

  const they_have = priced(them.ids, me, them);
  const they_want = priced(me.ids, them, me);

  let note;
  if (they_have.length && they_want.length) {
    note = `Live in both directions: ${they_have.length} of their players are worth more in your lineup than in theirs, ` +
      `and ${they_want.length} of yours are worth more in theirs. A real negotiation exists here even where no packaged deal below clears the bar.`;
  } else if (they_have.length) {
    note = "One-way fit — they hold players worth more to you than to them, but nothing you own is worth more over there. " +
      "You are the side that has to overpay.";
  } else if (they_want.length) {
    note = "One-way fit the other way — you hold surplus they could use and they hold none you can use. Sell, do not swap.";
  } else {
    note = "No surplus mismatch in either direction. Every player on both rosters is already worth at least as much where he is.";
  }
  const tied = they_want.length > 1 && they_want[0].net === they_want[they_want.length - 1].net;
  if (tied) {
    note += ` Every name on your side nets the same ${signed(they_want[0].net, 1)} — they all fill the same slot over there, ` +
      `so the one to actually send is the cheapest, ${they_want[0].name}.`;
  }
  return { they_have, they_want, note };
}

/* ------------------------------------------------ appetite: will this owner even trade
   Six seasons, 22 trades. The distribution is the point — half the league is functionally a dead
   end, and a page that offers them deals anyway wastes the reader's attention. */
function appetite(rid) {
  const n = trades.per[rid] || 0;
  if (n >= 9) return { band: "hub", n, note: `${n} of the league's ${trades.total} trades since 2020 — the market moves through this roster.` };
  if (n >= 5) return { band: "active", n, note: `${n} trades since 2020 — answers offers.` };
  if (n >= 3) return { band: "reachable", n, note: `${n} trades since 2020 — occasional, worth an ask.` };
  if (n >= 1) return { band: "cold", n, note: `${n} trade${n === 1 ? "" : "s"} in six seasons — long odds.` };
  return { band: "dead", n, note: "Zero trades in six seasons. Treat anything below as theoretical." };
}

/* ----------------------------------------------------- risks the lineup total cannot show */
function risks(t) {
  const starters = t.lineup.map((s) => s.player).filter(Boolean);
  const byWeek = {};
  for (const p of starters) if (p.bye) (byWeek[p.bye] = byWeek[p.bye] || []).push(`${p.name} (${p.pos})`);
  const bye_stacks = Object.entries(byWeek)
    .filter(([, v]) => v.length >= 3)
    .map(([wk, v]) => ({ week: +wk, n: v.length, players: v }))
    .sort((a, b) => b.n - a.n);
  const injured = starters.filter((p) => p.availability && p.availability.current_injury_status)
    .map((p) => ({ name: p.name, pos: p.pos, status: p.availability.current_injury_status }));
  const fragile = starters
    .filter((p) => p.availability && p.availability.score != null && p.availability.score < 0.9)
    .map((p) => ({ name: p.name, pos: p.pos, score: p.availability.score, why: p.availability.injury_history || null }))
    .sort((a, b) => a.score - b.score).slice(0, 3);
  const flagged = starters
    .filter((p) => p.risk_flags && (p.risk_flags.suspension || p.risk_flags.legal || p.risk_flags.contract))
    .map((p) => ({ name: p.name, pos: p.pos, notes: p.risk_flags.notes || [] }));
  return { bye_stacks, injured, fragile, flagged };
}

/* ------------------------------------- the summary, assembled from numbers rather than written
   Every clause restates something this script computed. No adjective appears that is not a direct
   restatement of a rank. If a team is unremarkable it says so rather than reaching for colour. */
const ORD = ORD_N;
const signed = (x, d = 0) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
/* Grading thresholds scaled to the league size, and identical to the page's colours (rosters.js and
   roster-table.js) so the prose and the table can never disagree. Top third a strength, bottom third
   a weakness: 3/8 in ten teams, 4/9 in twelve, 5/10 in fourteen. A bench player is surplus when he
   would start on the ten-team share of 4 of 9 other lineups: 4 of 9, 5 of 11, 6 of 13. */
const THIRD = Math.max(1, Math.round(TEAMS / 3));
const isStrength = (rank) => rank <= THIRD;
const isWeakness = (rank) => rank > TEAMS - THIRD;
const SURPLUS_STARTS = Math.ceil((TEAMS - 1) * 4 / 9);

function summarize(t, strengths, weaknesses, r) {
  const s = [];
  s.push(`${ORD(t.starter_rank)} of ${TEAMS} in projected starting points (${t.total.toFixed(0)}), ` +
    `${signed(t.total - leagueMedianStarters)} against the league median.`);
  if (strengths.length) {
    const a = strengths[0];
    s.push(`Built on ${a.pos}: ${a.pts.toFixed(0)} starting points, ${ORD(a.rank)} in the league, ${signed(a.vs_median)} on the median.`);
  }
  if (weaknesses.length) {
    const w = weaknesses[0];
    s.push(`${w.pos} is the hole — ${w.pts.toFixed(0)} points, ${ORD(w.rank)}, ${w.vs_median.toFixed(0)} behind.`);
  } else {
    s.push(`Nothing sits in the bottom ${spell(THIRD)}, which is its own problem: no deficit to fix and no surplus to sell.`);
  }
  const dep = t.bench.filter((p) => p._surplus.starts_on >= SURPLUS_STARTS);
  if (dep.length) {
    s.push(`${dep.length} bench player${dep.length === 1 ? "" : "s"} would start on ${spell(SURPLUS_STARTS)} or more other teams ` +
      `(${dep.slice(0, 3).map((p) => p.name).join(", ")}) — that is the tradeable surplus.`);
  } else {
    s.push(`No bench player would start on ${spell(SURPLUS_STARTS)} other teams, so there is little here to trade from.`);
  }
  if (r.bye_stacks.length) {
    const b = r.bye_stacks[0];
    s.push(`Week ${b.week} takes ${b.n} starters off the field at once, and five bench spots do not cover that.`);
  }
  return s.join(" ");
}

for (const t of teams) {
  const slots = t.lineup.map((s, i) => ({
    slot: s.slot,
    player: s.player ? {
      ...label(s.player.id),
      ...weekOf(s.player.id),
      week_call: t.week_call.get(s.player.id) ?? null,
      bye: s.player.bye != null ? s.player.bye : null,
      adp: s.player.adp && s.player.adp.half_ppr != null ? s.player.adp.half_ppr : null,
      injury: s.player.availability ? s.player.availability.current_injury_status || null : null,
    } : null,
    rank: slotTable[i].rank[t.roster_id],
    vs_median: +((ptsOf(s.player) || 0) - slotTable[i].median).toFixed(1),
  }));

  const posRows = POSES.map((pos) => ({
    pos,
    pts: t.starting_by_pos[pos].pts,
    rank: posTable[pos].rank[t.roster_id],
    vs_median: +(t.starting_by_pos[pos].pts - posTable[pos].median).toFixed(1),
    starters: t.starting_by_pos[pos].starters,
    rostered: t.starting_by_pos[pos].rostered,
  }));
  // K and DEF are streaming positions in this format; a rank at either says nothing about roster
  // quality, so they are reported but never called a strength or a weakness.
  const gradable = posRows.filter((p) => p.pos !== "K" && p.pos !== "DEF");
  const strengths = gradable.filter((p) => isStrength(p.rank)).sort((a, b) => a.rank - b.rank);
  const weaknesses = gradable.filter((p) => isWeakness(p.rank)).sort((a, b) => b.rank - a.rank);

  const r = risks(t);
  const d = dossiers.get(t.roster_id) || {};

  t.out = {
    roster_id: t.roster_id, owner: t.owner, user_id: t.user_id, is_me: t.is_me,
    draft_slot: t.draft_slot,
    starter_pts: t.total, starter_rank: t.starter_rank,
    vs_league_median: +(t.total - leagueMedianStarters).toFixed(1),
    bench_pts: +t.bench.reduce((a, p) => a + ptsOf(p), 0).toFixed(1),
    /* The same two totals for week WEEK, and the count they were taken over. A bye or an
       unprojected player contributes nothing and is excluded rather than counted as zero, so the
       count is what makes the total readable: "84.2 over 8 of 10 starters" says something a bare
       84.2 does not, which is that two of the slots are not playing. */
    week: (() => {
      const s = t.lineup.map((x) => x.player && weekPts.get(x.player.id)).filter((v) => v != null);
      const b = t.bench.map((p) => weekPts.get(p.id)).filter((v) => v != null);
      /* What the lineup on THIS PANEL has scored so far. Deliberately not Sleeper's own team total
         for the week: that one is over the lineup Ben actually set, and these slots are the optimal
         lineup this build computed. The two are usually the same and occasionally are not, and
         printing Sleeper's number under a table of different players would be quietly wrong. Only
         finished games count, so this figure never mixes a final score with half of one. */
      const done = t.lineup
        .map((x) => x.player && weekOf(x.player.id).week_actual)
        .filter((a) => a && a.final)
        .map((a) => a.pts);
      return {
        n: WEEK,
        starter_pts: +s.reduce((a, v) => a + v, 0).toFixed(1),
        starter_n: s.length, starter_of: t.lineup.length,
        bench_pts: +b.reduce((a, v) => a + v, 0).toFixed(1),
        bench_n: b.length, bench_of: t.bench.length,
        scored_pts: +done.reduce((a, v) => a + v, 0).toFixed(1),
        scored_n: done.length,
        /* The season lineup against the week lineup: who comes in, who goes out, and what the whole
           change is worth. Reported as two GROUPS rather than as pairs, because there is no pairing
           to report: both are unordered sets, and lining them up by index invents a swap ("A in for
           B") out of two positions in two lists. The gain is the honest one, the week optimum
           against what the season lineup would produce on this week's numbers, with a player the
           league lists unavailable counted at zero, which is what starting him actually returns.
           Empty when the two lineups agree, which is the common case and should read as silence. */
        optimal_pts: t.week_lineup.total,
        changes: (() => {
          const season = t.lineup.map((x) => x.player).filter(Boolean);
          const seasonIds = new Set(season.map((p) => p.id));
          const week = t.week_lineup.lineup.map((x) => x.player).filter(Boolean);
          const weekIds = new Set(week.map((p) => p.id));
          const inn = week.filter((p) => !seasonIds.has(p.id));
          const out = season.filter((p) => !weekIds.has(p.id));
          if (!inn.length && !out.length) return null;
          const seasonOnWeek = season.reduce((a, p) => a + (weekScore(p) ?? 0), 0);
          return {
            in: inn.map((p) => p.name),
            out: out.map((p) => p.name),
            gain: +(t.week_lineup.total - seasonOnWeek).toFixed(1),
            close: [...inn, ...out].filter((p) => (t.week_call.get(p.id) || {}).close === true).length,
            unavailable: out.filter((p) => outFor(p)).map((p) => `${p.name} (${outFor(p)})`),
            /* A slot the roster cannot fill at all. Couples Clash week 2: two WRs rostered, one of
               them Out, so WR2 stays empty and the change list is two out against one in. Counted
               rather than left to be inferred from a list that does not balance. */
            unfilled: t.week_lineup.lineup.filter((x) => !x.player).map((x) => x.slot),
          };
        })(),
      };
    })(),
    summary: summarize(t, strengths, weaknesses, r),
    slots, by_pos: posRows, strengths, weaknesses, risks: r,
    bench: t.bench.map((p) => ({ ...label(p.id), ...weekOf(p.id), week_call: t.week_call.get(p.id) ?? null, bye: p.bye != null ? p.bye : null, ...p._surplus })),
    unpriced: t.unpriced.map((id) => ({
      id, name: byId.get(id) ? byId.get(id).name : id,
      note: "no 2026 projection — excluded from every total on this page",
    })),
    /* One of these two is always null. A league with an archive gets the behavioural read; a
       year-one league gets the observed move count and no read at all. The page branches on which
       is present rather than on a league key, so a third league needs no front-end change. */
    tendencies: L.dossiers ? {
      draft: d.draft || null, faab: d.faab || null, trades: d.trades || null,
      exploit: d.exploit || null, history: d.history || null,
      appetite: appetite(t.roster_id),
      channel_with_me: (trades.channel[MY_ROSTER] || {})[t.roster_id] || 0,
    } : null,
    moves: moves ? {
      n: moves.per[t.roster_id] || 0,
      through_week: moves.through_week,
      note: (moves.per[t.roster_id] || 0) === 0
        ? `No completed moves through week ${moves.through_week}.`
        : `${moves.per[t.roster_id]} completed move(s) through week ${moves.through_week} — trades, waiver claims and free-agent adds.`,
    } : null,
    proposals: t.is_me ? [] : proposalsFor(t),
    fit: t.is_me ? null : fitWith(t),
  };
}

/* ------------------------------------------------------ roster performance (the HQ module)
   Design of record: plans/roster-performance-module.md. The arithmetic lives in
   scripts/lib/performance.mjs; this section fetches, prices and routes.

   Two readings, deliberately not blended (Q14): STANDING, which results decide, and STRENGTH,
   which the projection predicts. Around them sit the two luck checks (all-play for the schedule,
   scored-vs-projected for the players), lineup efficiency, a bye look-ahead, and up to three
   actions ROUTED from the waiver board and the trade search - this section never invents a
   candidate of its own (Q6), and says so when nothing on either list addresses a gap. */
console.log("\nRoster performance...");
const lset = league.settings || {};
const REG_WEEKS = Math.max(1, (+lset.playoff_week_start || 15) - 1);
const PLAYOFF_TEAMS = +lset.playoff_teams || null;
const DEADLINE = lset.trade_deadline != null ? +lset.trade_deadline : null;   // 99 = no deadline
if (!allPlayers) allPlayers = await get("https://api.sleeper.app/v1/players/nfl");
if (!proj) proj = await get(`https://api.sleeper.app/v1/projections/nfl/regular/${league.season}`);
const posOf = (id) => /^[A-Z]{2,3}$/.test(id) ? "DEF" : (byId.get(id)?.pos ?? allPlayers[id]?.position ?? null);
const teamOf = (id) => /^[A-Z]{2,3}$/.test(id) ? id : (byId.get(id)?.team ?? allPlayers[id]?.team ?? null);
const nameOfPlayer = (id) => byId.get(id)?.name ?? (allPlayers[id] ? `${allPlayers[id].first_name} ${allPlayers[id].last_name}`.trim() : id);
const r1 = (x) => (x == null ? null : +x.toFixed(1));

/* A week counts only once every game in it is final (Q12). WEEK already rolled forward past a
   fully finished week, so everything before it is final by construction; WEEK itself counts only
   as a partial, shown but never scored. Capped at the regular season: playoff weeks do not move a
   standing. */
const FINAL = [];
for (let w = 1; w <= Math.min(WEEK - 1, REG_WEEKS); w++) FINAL.push(w);
const started = [...sched.byTeam.values()].some((g) => g.completed || g.status === "STATUS_IN_PROGRESS");
const allDone = sched.teams_playing > 0 && [...sched.byTeam.values()].every((g) => g.completed);

/* Past weeks' projections are immutable once the week is played, so each is fetched once and kept
   in a local, uncommitted cache (data/raw/cache/, gitignored), slimmed to the lines that carry a
   real projection and the keys rescore() reads. The full feed is several MB a week. */
const PCACHE = path.join(ROOT, "data", "raw", "cache");
const KEEP_KEYS = new Set([...SKILL_KEYS, ...K_KEYS, ...DEF_KEYS, ...MISS_KEYS, "fgm_50p", "gp"]);
async function pastWeekProj(w) {
  const f = path.join(PCACHE, `proj-${league.season}-w${w}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const wp = await weekProjections(league.season, w);
  if (wp.error) { console.warn(`  ! week ${w} projections unavailable (${wp.error}) — that week's scored-vs-projected is left out.`); return null; }
  const slim = {};
  for (const [id, row] of Object.entries(wp.rows)) {
    if (!hasWeekLine(row)) continue;
    const s = {};
    for (const [k, v] of Object.entries(row)) if (KEEP_KEYS.has(k) && v) s[k] = v;
    slim[id] = s;
  }
  fs.mkdirSync(PCACHE, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(slim));
  return slim;
}

const finalWeeks = [];
for (const w of FINAL) {
  const rows = await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${w}`);
  finalWeeks.push({ w, rows, proj: await pastWeekProj(w) });
}
const results = PERF.weeklyResults(finalWeeks.map(({ w, rows }) => ({
  w, rows: rows.map((r) => ({ roster_id: r.roster_id, matchup_id: r.matchup_id, pts: r.custom_points ?? r.points ?? 0 })),
})));

/* Per team, per final week: the two luck checks and the efficiency read.
   - scored vs projected covers SKILL starters only (QB/RB/WR/TE). DEF points-allowed tiers never
     project (see basis.caveat) and kicker misses only half do, so including either would book a
     structural projection gap as "luck" every single week.
   - efficiency is the hindsight optimum over everyone rostered that week, scored by Sleeper,
     against what the started lineup actually scored. Hindsight on purpose: it measures the points
     that were on the roster and not in the lineup, which is the one gap a manager owns. */
const perTeam = new Map();
for (const t of teams) {
  const weeks = [];
  for (const { w, rows, proj: pw } of finalWeeks) {
    const row = rows.find((r) => r.roster_id === t.roster_id);
    const res = (results.get(t.roster_id) || []).find((x) => x.w === w);
    if (!row || !res) continue;
    const starters = row.starters || [], sp = row.starters_points || [];
    let act = 0, pr = 0, skill = 0;
    starters.forEach((id, i) => {
      const pos = posOf(id);
      if (!id || id === "0" || !PERF.SKILL.has(pos)) return;
      skill++;
      act += sp[i] ?? 0;
      pr += pw && pw[id] ? rescore(pw[id], pos) : 0;
    });
    const pp = row.players_points || {};
    const opt = PERF.optimal((row.players || []).map((id) => ({ id, pos: posOf(id), pts: pp[id] ?? 0 })));
    const startedSet = new Set(starters.filter((x) => x && x !== "0"));
    const optSet = new Set(opt.starters.map((p) => p.id));
    weeks.push({
      w, pts: r1(res.pts), result: res.result, ap: res.ap,
      opp: res.opp, opp_pts: r1(res.opp_pts),
      proj_skill: pw ? r1(pr) : null, act_skill: r1(act), gap: pw ? r1(act - pr) : null,
      optimal: r1(opt.total), lost: r1(Math.max(0, opt.total - res.pts)),
      swap: optSet.size && [...optSet].some((id) => !startedSet.has(id)) ? {
        in: [...optSet].filter((id) => !startedSet.has(id)).map(nameOfPlayer),
        out: [...startedSet].filter((id) => !optSet.has(id)).map(nameOfPlayer),
      } : null,
    });
  }
  const g = weeks.length;
  const rec = { w: 0, l: 0, t: 0 }, ap = { w: 0, l: 0, t: 0 };
  let pf = 0, exp = 0, gap = 0, gapN = 0, lost = 0;
  for (const x of weeks) {
    if (x.result === "W") rec.w++; else if (x.result === "L") rec.l++; else if (x.result === "T") rec.t++;
    ap.w += x.ap.w; ap.l += x.ap.l; ap.t += x.ap.t;
    exp += (x.ap.w + x.ap.t / 2) / Math.max(1, TEAMS - 1);
    pf += x.pts; lost += x.lost;
    if (x.gap != null) { gap += x.gap; gapN++; }
  }
  perTeam.set(t.roster_id, {
    roster_id: t.roster_id, owner: t.owner, is_me: t.is_me, g, weeks,
    ...rec, pf: r1(pf), pf_pg: g ? r1(pf / g) : null,
    ap, ap_pct: ap.w + ap.l + ap.t ? +((ap.w + ap.t / 2) / (ap.w + ap.l + ap.t)).toFixed(3) : null,
    exp_wins: r1(exp), luck_wins: r1(rec.w + rec.t / 2 - exp),
    gap_pg: gapN ? r1(gap / gapN) : null, lost_pg: g ? r1(lost / g) : null, lost: r1(lost),
    strength_rank: t.starter_rank, starter_pts: t.total,
  });
}
const perfRows = [...perTeam.values()];
const table = PLAYOFF_TEAMS ? PERF.standings(perfRows, PLAYOFF_TEAMS) : perfRows;
const RK = {
  pf: PERF.rankBy(perfRows, "pf_pg"), ap: PERF.rankBy(perfRows, "ap_pct"),
  gap: PERF.rankBy(perfRows, "gap_pg"), eff: PERF.rankBy(perfRows, "lost_pg", false),
};

/* Cross-check against Sleeper's own standings, but only when both describe the same weeks: the
   roster record updates on Sleeper's schedule, not ESPN's, so a mismatch mid-Tuesday is timing. */
for (const r of rosters) {
  const s = r.settings || {}, m = perTeam.get(r.roster_id);
  const games = (s.wins || 0) + (s.losses || 0) + (s.ties || 0);
  if (m && games === m.g && (s.wins !== m.w || s.losses !== m.l)) {
    console.warn(`  ! record mismatch for roster ${r.roster_id}: computed ${m.w}-${m.l}, Sleeper ${s.wins}-${s.losses}`);
  }
}

/* The week in progress, if there is one: my score, the opponent's, and who is left to play on
   each side. Nothing derived from it (Q12) - it is shown, marked in progress, and that is all. */
let partial = null;
if (WEEK <= REG_WEEKS && started && !allDone) {
  const rows = await get(`https://api.sleeper.app/v1/league/${LEAGUE_ID}/matchups/${WEEK}`);
  const mine = rows.find((r) => r.roster_id === MY_ROSTER);
  const opp = mine && rows.find((r) => r.roster_id !== MY_ROSTER && r.matchup_id != null && r.matchup_id === mine.matchup_id);
  const left = (row) => (row?.starters || []).filter((id) => {
    if (!id || id === "0") return false;
    const g = gameFor(sched, teamOf(id), null);
    return g && !g.completed && g.status !== "bye" && g.status !== "canceled" && g.status !== "unknown";
  }).length;
  if (mine) partial = {
    week: WEEK,
    my_pts: r1(mine.custom_points ?? mine.points ?? 0), my_left: left(mine),
    opp_owner: opp ? (teams.find((t) => t.roster_id === opp.roster_id)?.owner ?? null) : null,
    opp_pts: opp ? r1(opp.custom_points ?? opp.points ?? 0) : null, opp_left: opp ? left(opp) : null,
  };
}

/* ------------------------------------------------ byes: rolling window + post-deadline pins
   Byes come from the season schedule, per team, not from the board's per-player field: a player
   off the draft board has no `bye` there, and a missing bye silently reads as "never idle". */
const seasonSched = await get(`https://api.sleeper.app/schedule/nfl/regular/${league.season}`);
const byesOf = PERF.teamByes(seasonSched);
const FIRST_OPEN = started ? WEEK + 1 : WEEK;
const WINDOW = [0, 1, 2].map((i) => FIRST_OPEN + i).filter((w) => w <= REG_WEEKS);
/* A bye after the trade deadline is pinned from now until the deadline passes (Q4): once it has,
   the wire is the only fix left, so the warning has to arrive while a trade is still possible. */
const PINNABLE = DEADLINE != null && WEEK <= DEADLINE && DEADLINE < REG_WEEKS
  ? Array.from({ length: REG_WEEKS - DEADLINE }, (_, i) => DEADLINE + 1 + i).filter((w) => w >= FIRST_OPEN)
  : [];
const PG = 17;   // season projections are 17-game totals; per game keeps the numbers readable
const rowFor = (id) => {
  const p = byId.get(id);
  const pts = ptsOf(p);
  return pts == null ? null : { id, pos: p.pos, pts: pts / PG, team: p.team ?? teamOf(id), name: p.name };
};
const ROSTERED = new Set(rosteredIds);
const FA = [];
for (const [id, sp] of Object.entries(allPlayers)) {
  if (ROSTERED.has(id)) continue;
  const pos = /^[A-Z]{2,3}$/.test(id) ? "DEF" : sp.position;
  if (!["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos) || !(sp.team || pos === "DEF")) continue;
  if (sp.injury_status && DESIGNATED_OUT.has(sp.injury_status)) continue;
  const pts = rescore(proj[id], pos);
  if (!pts || pts <= 0) continue;
  FA.push({ id, pos, pts: pts / PG, team: pos === "DEF" ? id : sp.team, name: pos === "DEF" ? `${sp.first_name ?? ""} ${sp.last_name ?? id}`.trim() : `${sp.first_name} ${sp.last_name}`.trim() });
}
const rosterRows = (ids) => ids.map(rowFor).filter(Boolean);

/* The trigger threshold comes from this league's own distribution (Q5): every team's
   replacement-aware loss in every remaining bye week, 75th percentile, floored at the same 1.5-point
   band below which this build already says a projection cannot separate two players. */
const lossPool = [];
for (const t of teams) {
  const rr = rosterRows(t.ids);
  for (let w = FIRST_OPEN; w <= REG_WEEKS; w++) {
    const x = PERF.byeLoss(rr, FA, byesOf, w);
    if (x.off.length) lossPool.push(x.loss);
  }
}
const BYE_THRESHOLD = Math.max(CLOSE_PTS, PERF.quantile(lossPool, 0.75) ?? CLOSE_PTS);
const myRows = rosterRows(me.ids);
const byeFlags = [], byeQuiet = [];
for (const w of [...new Set([...WINDOW, ...PINNABLE])].sort((a, b) => a - b)) {
  const x = PERF.byeLoss(myRows, FA, byesOf, w);
  if (!x.off.length) continue;
  const why = WINDOW.includes(w) ? "window" : "post_deadline";
  const entry = {
    week: w, why,
    off: x.off.map((p) => ({ name: p.name, pos: p.pos })),
    loss: r1(x.loss), bench_loss: r1(x.bench_loss),
    fix: x.fix ? { name: x.fix.name, pos: x.fix.pos, team: x.fix.team, gain: r1(x.fix.gain) } : null,
  };
  if (x.loss >= BYE_THRESHOLD) byeFlags.push(entry);
  else if (why === "window") byeQuiet.push(entry);
}

/* --------------------------------------------------------------- routed actions (Q6)
   Every action is lifted from a list that already exists: the published waiver board (this
   league's waivers.json) or the trade search above. A waiver target is re-checked against the live
   rosters by player id, because the board is written by a different job and can lag a claim. */
const WPATH = path.join(ROOT, ...L.out_dir.split("/"), "waivers.json");
let waiverBoard = null;
if (fs.existsSync(WPATH)) {
  try { waiverBoard = JSON.parse(fs.readFileSync(WPATH, "utf8")); } catch { waiverBoard = null; }
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const idByNameTeam = new Map();
for (const [id, sp] of Object.entries(allPlayers)) {
  if (!sp.full_name && !sp.last_name) continue;
  idByNameTeam.set(`${norm(sp.full_name || `${sp.first_name}${sp.last_name}`)}|${sp.team}`, id);
}
const boardIds = new Set((waiverBoard?.targets || []).map((x) => idByNameTeam.get(`${norm(x.player)}|${x.team}`)).filter(Boolean));
const waiverCands = (waiverBoard?.targets || [])
  .filter((x) => x.verdict === "pursue" || x.verdict === "watch")
  .map((x) => {
    const id = idByNameTeam.get(`${norm(x.player)}|${x.team}`) || null;
    const pts = id ? rescore(proj[id], x.pos) : null;
    return { ...x, id, row: id && pts ? { id, pos: x.pos, pts: pts / PG, team: x.team, name: x.player } : null };
  })
  .filter((x) => x.id && x.row && !ROSTERED.has(x.id));
const waiverAge = waiverBoard?.generated ? Math.floor((new Date(TODAY) - new Date(waiverBoard.generated)) / 864e5) : null;

const totalOf = (rows, w = null) => PERF.optimal(w == null ? rows : rows.filter((p) => !(byesOf.get(p.team) || new Set()).has(w))).total;
const baseSeason = totalOf(myRows);
const allProposals = teams.filter((t) => !t.is_me).flatMap((t) => (t.out.proposals || []).map((p) => ({ ...p, owner: t.owner })));
const afterTrade = (p) => rosterRows([...me.ids.filter((id) => !p.give.some((g) => g.id === id)), ...p.get.map((g) => g.id)]);
const tradeOpen = DEADLINE == null || WEEK <= DEADLINE;

function bestFor(gain) {
  /* Pursue beats watch on the waiver side; the larger gain wins across the two sources, with a
     waiver preferred on a tie because it costs a claim rather than a player. */
  let best = null;
  const consider = (c) => { if (c.gain > 0.05 && (!best || c.gain > best.gain + 1e-9)) best = c; };
  for (const verdict of ["pursue", "watch"]) {
    for (const c of waiverCands.filter((x) => x.verdict === verdict)) consider({ kind: "waiver", gain: gain.waiver(c), c });
    if (best) break;
  }
  if (tradeOpen) for (const p of allProposals) consider({ kind: "trade", gain: gain.trade(p), c: p });
  return best;
}
const tradeText = (p) => `${p.give.map((g) => g.name).join(" + ")} to ${p.owner} for ${p.get.map((g) => g.name).join(" + ")}`;
const waiverText = (c) => `claim ${c.player} (${c.pos} ${c.team})${c.bid_amount != null ? `, ${c.bid_amount} dollars` : ""}${c.drop_player ? `, dropping ${c.drop_player}` : ""}`;

/* Waiver-board blind spots (Q15). The module routes only from the published board and the trade
   list, so a free agent /waivers never listed cannot become an action here - but it can be named.
   A blind spot is a free agent NOT on the board (any verdict: one the board looked at and rejected
   is a judgment, not a gap) who beats the best routed action for the same gap by at least the trade
   search's own noise bar. A diagnostic about the board, never a recommendation of its own.
   Positional gaps only: a flagged bye is already measured after the best free pickup and names
   him, so a blind spot there would repeat the bye line with a smaller number. */
const BLIND_MARGIN = GAIN_1 / PG;   // 5 season points, as a per-game gain
const blindSpots = [];
function blindSpot(gapLabel, faGain, routedGain) {
  let best = null;
  for (const f of FA) {
    if (boardIds.has(f.id)) continue;
    const g = faGain(f);
    if (g > 0.05 && (!best || g > best.gain)) best = { f, gain: g };
  }
  /* Logged either way, so a blind spot that did NOT fire is visible in the build output rather
     than inferred from its absence. */
  if (best) console.log(`  best unlisted free agent for ${gapLabel}: ${best.f.name} +${r1(best.gain * PG)} season pts vs routed +${r1((routedGain || 0) * PG)} -> ${best.gain >= (routedGain || 0) + BLIND_MARGIN ? "blind spot" : "no blind spot"}`);
  if (best && best.gain >= (routedGain || 0) + BLIND_MARGIN) {
    blindSpots.push({ gap: gapLabel, player: best.f.name, pos: best.f.pos, team: best.f.team, gain: best.gain, routed_gain: routedGain || 0 });
  }
}

const actions = [];
for (const b of byeFlags) {
  const base = totalOf(myRows, b.week);
  const pick = bestFor({
    waiver: (c) => totalOf([...myRows, c.row], b.week) - base,
    trade: (p) => totalOf(afterTrade(p), b.week) - base,
  });
  /* Short on purpose: the bye itself is described in full on the line above the actions, so the
     label only has to say which gap this action is for. */
  const gap = `Week ${b.week} bye (${b.loss} a game short)`;
  actions.push(pick
    ? { gap, kind: pick.kind, panel: pick.kind === "waiver" ? "waivers" : "rosters", gain: r1(pick.gain),
        text: `${pick.kind === "waiver" ? waiverText(pick.c) : tradeText(pick.c)} — worth ${r1(pick.gain)} a game in week ${b.week}.` }
    : { gap, kind: null, panel: null, gain: null,
        text: `Nothing on the waiver board or the trade list covers week ${b.week}.${b.why === "post_deadline" && tradeOpen ? " A trade has to happen by week " + DEADLINE + "; none of the current proposals does it." : ""}` });
}
for (const wk of me.out.weaknesses) {
  const pick = bestFor({
    waiver: (c) => c.pos === wk.pos ? totalOf([...myRows, c.row]) - baseSeason : 0,
    trade: (p) => p.get.some((g) => g.pos === wk.pos) ? totalOf(afterTrade(p)) - baseSeason : 0,
  });
  blindSpot(wk.pos, (f) => f.pos === wk.pos ? totalOf([...myRows, f]) - baseSeason : 0, pick ? pick.gain : 0);
  const gap = `${wk.pos} is ${ORD(wk.rank)} of ${TEAMS} in projected starting points.`;
  actions.push(pick
    ? { gap, kind: pick.kind, panel: pick.kind === "waiver" ? "waivers" : "rosters", gain: r1(pick.gain * PG),
        text: `${pick.kind === "waiver" ? waiverText(pick.c) : tradeText(pick.c)} — +${r1(pick.gain * PG)} projected season points.` }
    : { gap, kind: null, panel: null, gain: null, text: `Nothing on the waiver board or the trade list improves ${wk.pos}.` });
}
const myPerf = perTeam.get(MY_ROSTER);
const effRank = RK.eff.get(MY_ROSTER);
if (myPerf.g && effRank != null && isWeakness(effRank)) {
  const ch = me.out.week.changes;
  const gap = `${myPerf.lost_pg} points a game left on the bench, ${ORD(effRank)} of ${TEAMS}.`;
  actions.push(ch && ch.gain > 0
    ? { gap, kind: "lineup", panel: "myroster", gain: ch.gain,
        text: `Set the week-${WEEK} lineup the projection prefers: in ${ch.in.join(", ")}, out ${ch.out.join(", ")} (+${ch.gain}).` }
    : { gap, kind: null, panel: null, gain: null, text: `The week-${WEEK} lineup already matches the projection; the points left on the bench so far were not visible in advance.` });
}
/* Merge actions that route to the same move, so one waiver claim that fixes both a bye and a
   positional hole reads as one line closing two gaps rather than as two recommendations. */
const merged = [];
for (const a of actions) {
  const same = a.kind && merged.find((m) => m.kind === a.kind && m.text.split(" — ")[0] === a.text.split(" — ")[0]);
  if (same) same.gaps.push(a.gap); else merged.push({ ...a, gaps: [a.gap] });
}
const ROUTED = merged.slice(0, 3).map(({ gap, ...rest }) => rest);

/* ----------------------------------------------------------------------- the one sentence
   Standing against strength, and then the single largest measurable reason for any gap between
   them. Every clause is a restatement of a number above. */
function headline(m, seedRow) {
  if (!m.g) return `No week is final yet, so there is no standing to read. On paper: ${ORD(m.strength_rank)} of ${TEAMS} in projected starters.`;
  const seed = seedRow ? seedRow.seed : null;
  const s = [];
  const standing = seed != null ? `${ORD(seed)} in the standings` : `${m.w}-${m.l}${m.t ? `-${m.t}` : ""}`;
  const diff = seed != null ? seed - m.strength_rank : 0;   // positive = standing worse than roster
  if (Math.abs(diff) <= 1) s.push(`${standing[0].toUpperCase()}${standing.slice(1)} and ${ORD(m.strength_rank)} on paper: the results and the roster agree.`);
  else s.push(`${standing[0].toUpperCase()}${standing.slice(1)} but ${ORD(m.strength_rank)} on paper.`);
  /* Candidate reasons, each with a direction and a size. Schedule luck in wins; player luck and
     bench points in points per game, ranked against the league so a size means the same thing
     in a ten-team and a fourteen-team league. */
  const why = [];
  if (Math.abs(m.luck_wins) >= 0.75) why.push({ dir: Math.sign(m.luck_wins),
    cause: "the schedule", text: `a ${m.ap.w}-${m.ap.l} all-play record says that scoring earns ${m.exp_wins} wins, not ${m.w}`, size: Math.abs(m.luck_wins) });
  const gr = RK.gap.get(m.roster_id);
  if (m.gap_pg != null && gr != null && (isStrength(gr) || isWeakness(gr))) why.push({ dir: Math.sign(m.gap_pg),
    cause: "the players", text: `skill starters are running ${Math.abs(m.gap_pg)} a game ${m.gap_pg >= 0 ? "over" : "under"} projection (${ORD(gr)} of ${TEAMS})`, size: Math.abs(m.gap_pg) / 10 });
  const er = RK.eff.get(m.roster_id);
  if (er != null && isWeakness(er)) why.push({ dir: -1, cause: "the lineup", text: `${m.lost_pg} a game left on the bench (${ORD(er)} of ${TEAMS})`, size: m.lost_pg / 10 });
  const wanted = diff > 1 ? -1 : diff < -1 ? 1 : 0;
  const pick = why.filter((x) => !wanted || x.dir === wanted).sort((a, b) => b.size - a.size)[0];
  if (pick) s.push(wanted ? `Most of the gap is ${pick.cause}: ${pick.text}.` : `Worth knowing: ${pick.text}.`);
  else if (wanted) s.push("No single cause stands out.");
  if (m.g < 4) s.push(`${spell(m.g)[0].toUpperCase()}${spell(m.g).slice(1)} week${m.g === 1 ? "" : "s"} in: the standing counts for seeding, but it says almost nothing yet about the roster.`);
  return s.join(" ");
}
const mySeed = table.find((r) => r.roster_id === MY_ROSTER);
const perfK = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", "perf-k.json"), "utf8")); } catch { return null; } })();

const performance = {
  final_weeks: FINAL,
  regular_weeks: REG_WEEKS,
  playoff_teams: PLAYOFF_TEAMS,
  trade_deadline: DEADLINE != null && DEADLINE < REG_WEEKS ? DEADLINE : null,
  headline: headline(myPerf, mySeed),
  standing: mySeed && mySeed.seed ? {
    seed: mySeed.seed, of: TEAMS, w: myPerf.w, l: myPerf.l, t: myPerf.t,
    line: PLAYOFF_TEAMS ? {
      inside: mySeed.line.inside, games: mySeed.line.games, vs_seed: mySeed.line.vs_seed,
      vs_owner: mySeed.line.vs_roster != null ? perTeam.get(mySeed.line.vs_roster)?.owner ?? null : null,
    } : null,
  } : null,
  strength: { rank: myPerf.strength_rank, of: TEAMS, starter_pts: myPerf.starter_pts },
  metrics: {
    record: { w: myPerf.w, l: myPerf.l, t: myPerf.t },
    pf: { total: myPerf.pf, per_game: myPerf.pf_pg, rank: RK.pf.get(MY_ROSTER) },
    all_play: { ...myPerf.ap, rank: RK.ap.get(MY_ROSTER), exp_wins: myPerf.exp_wins, luck_wins: myPerf.luck_wins },
    proj_gap: { per_game: myPerf.gap_pg, rank: RK.gap.get(MY_ROSTER) },
    efficiency: { lost: myPerf.lost, per_game: myPerf.lost_pg, rank: effRank },
  },
  weeks: myPerf.weeks.map((x) => ({
    ...x, opp_owner: x.opp != null ? perTeam.get(x.opp)?.owner ?? null : null,
  })),
  partial,
  league: table.map((r) => ({
    roster_id: r.roster_id, owner: r.owner, is_me: r.is_me, seed: r.seed ?? null,
    w: r.w, l: r.l, t: r.t, pf: r.pf, all_play: r.ap, strength_rank: r.strength_rank,
    pf_rank: RK.pf.get(r.roster_id), ap_rank: RK.ap.get(r.roster_id),
    gap_pg: r.gap_pg, gap_rank: RK.gap.get(r.roster_id), lost_pg: r.lost_pg, eff_rank: RK.eff.get(r.roster_id),
  })),
  byes: {
    threshold: r1(BYE_THRESHOLD), window: WINDOW, pinned: PINNABLE,
    flagged: byeFlags, covered: byeQuiet,
  },
  actions: ROUTED,
  /* Worded per gap type, because the units differ: a positional hole is judged over the season, a
     bye over one week. */
  blind_spots: blindSpots.slice(0, 2).map((b) => {
    const week = b.gap.startsWith("week ");
    const size = week ? `+${r1(b.gain)} a game in ${b.gap}` : `+${r1(b.gain * PG)} projected season points at ${b.gap}`;
    return {
      gap: b.gap, player: b.player, pos: b.pos, team: b.team,
      gain: week ? r1(b.gain) : r1(b.gain * PG), unit: week ? "per_game" : "season",
      text: `Waiver board blind spot: ${b.player} (${b.pos} ${b.team}) is a free agent worth ${size}, more than anything the board or the trade list offers there, and the board does not list him.`,
    };
  }),
  sources: {
    waivers: waiverBoard ? { generated: waiverBoard.generated, age_days: waiverAge, stale: waiverAge != null && waiverAge > 7 } : null,
    trades: tradeOpen ? `${allProposals.length} proposal(s) from this build's trade search` : `trade deadline (week ${DEADLINE}) has passed`,
  },
  basis: {
    standing: `Results from ${L.name}'s own weekly matchup rows, final weeks only (every game marked complete by ESPN). Seeded by wins, then points for${PLAYOFF_TEAMS ? `; ${PLAYOFF_TEAMS} of ${TEAMS} make the playoffs` : ""}.`,
    strength: "Rank of the optimal starting lineup on season projections, the same number the roster room grades.",
    no_blend: perfK ? `Standing and strength are read separately, never blended. On HBGBs 2020-25, results added almost nothing to the projection as a predictor of rest-of-season scoring (leakage-free k = ${perfK.k_leakage_free}; see data/perf-k.json).` : "Standing and strength are read separately, never blended (see plans/roster-performance-module.md, Q14).",
    all_play: "Your record had you played every other team each week: the schedule-luck check.",
    proj_gap: "Skill starters' (QB/RB/WR/TE) scored points against their pre-week projections in this league's scoring. K and DEF are left out: DEF points-allowed tiers never project, so they would book a structural gap as luck.",
    efficiency: "Hindsight-optimal lineup from everyone rostered that week, scored by Sleeper, against what the started lineup scored.",
    byes: `Replacement-aware: the loss after the better of your bench and one free-agent pickup, per game on season projections. Flagged at or above ${r1(BYE_THRESHOLD)} a game, this league's 75th percentile. Window: the next ${WINDOW.length} unplayed week(s)${PINNABLE.length ? `, plus weeks ${PINNABLE[0]}-${PINNABLE[PINNABLE.length - 1]} pinned until the week-${DEADLINE} deadline` : ""}. Availability designations are not applied to future weeks.`,
    actions: "Routed, never generated: each one is lifted from this league's published waiver board or this build's trade search. When neither addresses a gap, the line says so.",
    blind_spots: `A free agent the waiver board does not list at all, beating the best routed action for the same gap by at least ${GAIN_1} season points (${r1(BLIND_MARGIN)} a game). Named as a gap in the board, not recommended.`,
  },
};
console.log(`  final weeks: ${FINAL.length ? FINAL.join(", ") : "none"}${partial ? ` · week ${WEEK} in progress (${partial.my_pts} to ${partial.opp_pts})` : ""}`);
console.log(`  ${performance.headline}`);
console.log(`  byes: threshold ${performance.byes.threshold}/g · flagged ${byeFlags.map((b) => `wk${b.week}(${b.loss})`).join(" ") || "none"} · ${FA.length} free agents priced`);
for (const a of ROUTED) console.log(`  action [${a.kind ?? "none"}] ${a.text}`);
for (const b of performance.blind_spots) console.log(`  ${b.text}`);

/* ------------------------------------------------------ usage risers (the waiver-side lens)
   §1.33. data/site/usage-recent.json is league-agnostic; who counts as a riser is not, because it
   depends on who is rostered HERE. A riser is an unrostered player whose recent usage clears the
   median rostered player at his position in this league, on EITHER his last completed week or his
   last-three-week window (a new role shows up in one, a steady one in the other), with the label
   saying which. The median is the league's own answer to "what does an owned player's role look
   like", so it moves with depth: the Clash's median owned WR is used less than the HBGBs'. */
const USAGE_PATH = path.join(ROOT, "data", "site", "usage-recent.json");
const RISER_CAP = 6;   // per position, ranked by margin over the median
const RISER_POS = ["RB", "WR", "TE"];
let usageRisers = null;
if (fs.existsSync(USAGE_PATH)) {
  const U = JSON.parse(fs.readFileSync(USAGE_PATH, "utf8"));
  const multiWeek = U.window_weeks.length > 1;
  const medians = {}, risers = [];
  /* No QBs. In a one-QB league about twenty NFL starters sit unrostered, so "used like an owned QB"
     is true of all of them and the list would be a pass-volume sort of known starters. Ben makes QB
     calls himself (§1.33); QBs keep their usage line on the waiver board. */
  for (const pos of RISER_POS) {
    const metric = U.metric_by_pos[pos];
    const inPos = U.players.filter((p) => p.pos === pos);
    const owned = inPos.filter((p) => ROSTERED.has(p.id));
    const vals = (k) => owned.map((p) => p[k] && p[k][metric]).filter((v) => v != null);
    const mLast = PERF.quantile(vals("last"), 0.5), mWin = PERF.quantile(vals("window"), 0.5);
    medians[pos] = { metric, last: mLast, window: mWin, rostered_with_usage: owned.length };
    const cands = [];
    for (const p of inPos) {
      if (ROSTERED.has(p.id) || (p.injury && DESIGNATED_OUT.has(p.injury))) continue;
      const l = p.last ? p.last[metric] : null, w = p.window[metric];
      const byLast = l != null && mLast != null && l >= mLast;
      const byWin = multiWeek && w != null && mWin != null && w >= mWin;
      if (!byLast && !byWin) continue;
      /* With one final week the two windows are the same week, so the label says so rather than
         claiming a "sustained" read off a single game. */
      const reason = !multiWeek ? "one_week" : byLast && byWin ? "both" : byLast ? "last_week" : "window";
      const margin = Math.max(byLast ? l - mLast : -Infinity, byWin ? w - mWin : -Infinity);
      cands.push({
        id: p.id, name: p.name, pos, team: p.team, injury: p.injury, metric,
        last: p.last ? { w: p.last.w, share: l, snap_share: p.last.snap_share, tgt: p.last.tgt_pg, touch: p.last.touch_pg } : null,
        window: { weeks: p.window.weeks, share: w, snap_share: p.window.snap_share },
        reason, margin: +margin.toFixed(3),
        jump: p.jump && p.jump.claimed ? { from: p.jump.from, to: p.jump.to } : null,
      });
    }
    cands.sort((a, b) => b.margin - a.margin || a.name.localeCompare(b.name));
    risers.push(...cands.slice(0, RISER_CAP));
  }
  usageRisers = {
    generated: U.generated, weeks: U.window_weeks, medians, risers,
    basis: `Unrostered in ${L.name}, not listed Out/IR, and at or above this league's median rostered player at his position (${RISER_POS.map((p) => `${p} ${U.metric_by_pos[p].replace("_", " ")}`).join(", ")}; QBs are left to judgment, since most starters go unrostered in a one-QB league) on his last completed week or his last-${U.window_weeks.length > 1 ? U.window_weeks.length : "N"}-week window. Top ${RISER_CAP} per position by margin over that median. ${multiWeek ? "" : "Only one final week so far, so every riser is a one-week read. "}Snap share stands in for routes, which Sleeper does not publish.`,
  };
  const byPos = {};
  for (const r of risers) byPos[r.pos] = (byPos[r.pos] || 0) + 1;
  console.log(`  usage risers (week${U.window_weeks.length === 1 ? "" : "s"} ${U.window_weeks.join(", ")}): ${Object.entries(byPos).map(([p, n]) => `${p} ${n}`).join(" · ") || "none"} · medians ${Object.entries(medians).map(([p, m]) => `${p} ${m.last}`).join(" ")}`);
} else {
  console.warn(`  ! ${path.relative(ROOT, USAGE_PATH)} not found — no usage risers. Run node scripts/build-usage-recent.mjs first.`);
}

/* ------------------------------------------------------------------------------- write */
const payload = {
  generated: TODAY,
  league: {
    id: LEAGUE_ID, name: league.name, season: league.season, status: league.status,
    week: state.display_week, season_type: state.season_type,
  },
  draft: draft ? {
    id: draft.draft_id, status: draft.status,
    rounds: draft.settings ? draft.settings.rounds : null, type: draft.type,
  } : null,
  basis: {
    projection: L.board_scored
      ? `Sleeper 2026 projected stat lines re-scored with the league's exact scoring_settings (${L.scoring_snapshot}) — the same numbers the draft board runs on.`
      : `Sleeper 2026 projected stat lines re-scored with ${L.name}'s exact scoring_settings (${L.scoring_snapshot}). NOT the draft board's numbers: the board is scored in the HBGBs' settings.`,
    market: REC_MATCHES
      ? "ADP and Boris Chen tiers come from the shared draft board, which is built in this league's reception value."
      : `Omitted. The shared draft board's ADP and Boris Chen tiers are half-PPR; ${L.name} scores receptions at ${scoring.rec}, so they are another format's market and are dropped rather than shown under this league's name.`,
    lineup: `Optimal lineup under ${SLOTS.join("/")}, five bench. Greedy is optimal here because slot eligibility nests.`,
    strength: `Per-slot and per-position rank against the other ${spell(TEAMS - 1)} teams. K and DEF are reported but never graded — they are streaming positions in this format.`,
    surplus: `A bench player's "starts on N" is measured by recomputing each of the other ${spell(TEAMS - 1)} optimal lineups with him inserted.`,
    trades: `Exhaustive 1-for-1 and 2-for-1 search. A proposal ships only if BOTH optimal lineups rise (>= ${GAIN_1} season points for a 1-for-1; >= ${GAIN_2_ME} to me and >= ${GAIN_2_THEM} to them for a 2-for-1, where the other side must also take on more raw projected points than it gives).`,
    tendencies: L.dossiers
      ? `Parsed from ${L.dossiers}; trade counts recomputed from data/raw/transactions-${L.trade_archive.from}..${L.trade_archive.to}.json.`
      : `${L.name} is in its first season, so there is no owner history to read. The league table reports completed moves this season instead — observed, and zero for everybody until somebody makes one.`,
    caveat: "A projection is a season-long point estimate. It cannot see a camp role change, it prices DEF poorly (points-allowed tiers do not project), and it says nothing about week-to-week ceiling. Every number here is the start of an argument, not the end of one.",
  },
  /* Everything the page needs to caption the two week-scoped columns honestly: which week, where
     the kickoff times came from, how many teams are actually playing, and what could not be read.
     A page that shows a time has to be able to say where the time came from. */
  week: {
    n: WEEK,
    display_week: +state.display_week || null,
    rolled_forward: WEEK !== Math.max(1, +state.display_week || +state.week || 1),
    teams_playing: sched.teams_playing,
    projected: weekPts.size,
    close_band: CLOSE_PTS,
    of_rostered: rosteredIds.length,
    schedule_source: sched.source,
    projection_source: wproj.error
      ? null
      : `Sleeper week-${WEEK} projected stat lines re-scored with ${L.name}'s exact scoring_settings — the same arithmetic as the season column, over a different stat line.`,
    /* Results are read, never computed. See the note on weekActuals in scripts/lib/nfl-week.mjs. */
    result_source: wact.error
      ? null
      : `${L.name}'s own week-${WEEK} matchup rows — Sleeper's scoring of each player in this league's settings, read as published rather than recomputed here.`,
    games_final: [...sched.byTeam.values()].filter((g) => g.completed).length,
    results: rosteredIds.filter((id) => weekOf(id).week_actual != null).length,
    canceled: sched.canceled,
    warnings: [...sched.warnings,
      ...(wproj.error ? [`week ${WEEK} projections unavailable: ${wproj.error}`] : []),
      ...(wact.error ? [`week ${WEEK} results unavailable: ${wact.error}`] : [])],
  },
  coverage: {
    rostered: rosteredIds.length,
    priced: rosteredIds.filter((id) => ptsOf(byId.get(id)) != null).length,
    off_board_priced: offBoard.length,
    league_median_starters: leagueMedianStarters,
  },
  slot_table: slotTable.map((s) => ({ slot: s.slot, index: s.index, median: s.median, best: s.best })),
  pos_table: Object.fromEntries(POSES.map((p) => [p, { median: posTable[p].median }])),
  trade_history: trades
    ? { total: trades.total, seasons: trades.seasons, by_year: trades.years, per_roster: trades.per }
    : null,
  season_moves: moves,
  /* HQ's roster performance module (plans/roster-performance-module.md). Mine only, but every
     rank inside it is against the whole league, and `league` carries the table it was ranked on. */
  performance,
  /* §1.33: unrostered players used like this league's rostered median. A third source for the
     /waivers pool; the waiver board's usage line reads the shared usage-recent.json directly. */
  usage_risers: usageRisers,
  teams: teams.map((t) => t.out),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));

const nProp = payload.teams.reduce((a, t) => a + t.proposals.length, 0);
console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
console.log(`  ${payload.teams.length} teams · ${payload.coverage.priced}/${payload.coverage.rostered} players priced · median starters ${leagueMedianStarters}`);
console.log(`  ${nProp} trade proposals across ${payload.teams.filter((t) => t.proposals.length).length} partners`);
for (const t of [...payload.teams].sort((a, b) => a.starter_rank - b.starter_rank)) {
  console.log(`  ${String(t.starter_rank).padStart(2)}. ${t.owner.padEnd(17)} ${String(t.starter_pts).padStart(7)}  ` +
    `${t.proposals.length} offers  [${t.tendencies ? t.tendencies.appetite.band : `${t.moves.n} moves`}]`);
}
