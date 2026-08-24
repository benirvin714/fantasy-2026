/* Roster room — every team in the league as a scouting object.
 *
 * Reads the ten post-draft rosters, prices every rostered player with the same league-scored
 * projection the draft board uses, then answers four questions per team:
 *   1. how good is it        -> optimal starting lineup under this league's slot shape
 *   2. where is it strong    -> per-slot and per-position rank against the other nine teams
 *   3. who owns it           -> the six-season dossier in league-tendencies.md, keyed by roster id
 *   4. what can I get        -> trades that raise BOTH lineups, searched exhaustively, not guessed
 *
 * Nothing here is a judgment call the script invented. Every number traces to a projection, a
 * lineup recomputation, or a count over raw Sleeper transactions; every sentence of prose is
 * assembled from those numbers. Where a player can't be priced he is named and excluded rather
 * than assumed, because a missing projection silently read as 0 would fake a weakness.
 *
 * Output: data/site/roster-room.json   Page: site/rosters.html
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEAGUE_ID = "1386608052991447040";
const OUT = path.join(ROOT, "data", "site", "roster-room.json");
const MY_ROSTER = 10;

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
  fs.readFileSync(path.join(ROOT, "data", "raw", "league-2026.json"), "utf8")).scoring_settings;
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
  if (pos === "K" && p.fgm_50p != null) pts += p.fgm_50p * (scoring.fgm_50_59 ?? 5);
  return +pts.toFixed(1);
}

const rosteredIds = [...new Set(rosters.flatMap((r) => r.players))];
const offBoard = rosteredIds.filter((id) => !byId.has(id));
if (offBoard.length) {
  console.log(`${offBoard.length} rostered player(s) outside the board pool — pricing from Sleeper directly.`);
  const [allPlayers, proj] = await Promise.all([
    get("https://api.sleeper.app/v1/players/nfl"),
    get("https://api.sleeper.app/v1/projections/nfl/regular/2026"),
  ]);
  for (const id of offBoard) {
    const sp = allPlayers[id];
    if (!sp) { console.warn(`  ${id}: unknown to Sleeper — listed as unpriced`); continue; }
    const pos = sp.position;
    const pts = rescore(proj[id], pos);
    byId.set(id, {
      id, name: `${sp.first_name} ${sp.last_name}`.trim(), pos, team: sp.team, age: sp.age,
      years_exp: sp.years_exp, bye: null, rookie: sp.years_exp === 0, off_board: true,
      projection: { pts, method: "Sleeper projected stat line re-scored with exact league settings" },
      availability: { current_injury_status: sp.injury_status || null },
      adp: {}, risk_flags: {},
    });
    console.log(`  ${id}: ${sp.first_name} ${sp.last_name} (${pos} ${sp.team}) = ${pts} pts`);
  }
}

/* ------------------------------------------- owner dossiers, parsed from league-tendencies.md
   Parsed rather than copied into JSON: the markdown is the one home for these facts, and a copy
   would rot the first time a dossier is revised. The parser is strict on purpose — if the file's
   shape changes it fails the build instead of shipping nine owners out of ten. */
function parseDossiers() {
  const md = fs.readFileSync(path.join(ROOT, "league-tendencies.md"), "utf8");
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
const dossiers = parseDossiers();
if (dossiers.size !== rosters.length) {
  console.error(`Refusing to build: parsed ${dossiers.size} dossiers from league-tendencies.md, ` +
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
  for (let y = 2020; y <= 2025; y++) {
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
  return { per, channel, total, years, seasons: "2020-2025" };
}
const trades = tradeHistory();

/* --------------------------------------------------------------------- the lineup model
   QB / RB / RB / WR / WR / TE / FLEX / FLEX / K / DEF, five bench, one IR. Greedy is provably
   optimal here because slot eligibility nests: the dedicated slots take the best at each position
   (any legal lineup must carry two RBs, so it can only lose by carrying worse ones), then the two
   FLEX take the best of everything left. That property is what makes the marginal-gain search
   below trustworthy — it compares true optima, not two greedy approximations. */
const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
const FLEX_OK = new Set(["RB", "WR", "TE"]);
const ptsOf = (p) => (p && p.projection && p.projection.pts != null ? p.projection.pts : null);

function assignLineup(ids) {
  const pool = ids.map((id) => byId.get(id)).filter((p) => p && ptsOf(p) != null);
  const byPos = {};
  for (const p of pool) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  for (const k in byPos) byPos[k].sort((a, b) => ptsOf(b) - ptsOf(a));
  const used = new Set(), lineup = [];
  const take = (arr) => {
    const p = (arr || []).find((x) => !used.has(x.id));
    if (p) used.add(p.id);
    return p || null;
  };
  for (const slot of SLOTS) {
    if (slot === "FLEX") {
      const cands = pool.filter((p) => FLEX_OK.has(p.pos) && !used.has(p.id))
        .sort((a, b) => ptsOf(b) - ptsOf(a));
      lineup.push({ slot, player: take(cands) });
    } else lineup.push({ slot, player: take(byPos[slot]) });
  }
  const bench = pool.filter((p) => !used.has(p.id)).sort((a, b) => ptsOf(b) - ptsOf(a));
  const unpriced = ids.filter((id) => ptsOf(byId.get(id)) == null);
  const total = +lineup.reduce((a, s) => a + (ptsOf(s.player) || 0), 0).toFixed(1);
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

/* Rank each team at every slot against the other nine. Slot rank is the honest read of a
   weakness: "your RB2 is 9th of 10 at that slot" is actionable in a way "7th in RB points" is not. */
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
   other nine optimal lineups with him inserted, not by comparing ranks. */
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
const ORD = (n) => ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"][n] || `${n}th`;
const signed = (x, d = 0) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

function summarize(t, strengths, weaknesses, r) {
  const s = [];
  s.push(`${ORD(t.starter_rank)} of 10 in projected starting points (${t.total.toFixed(0)}), ` +
    `${signed(t.total - leagueMedianStarters)} against the league median.`);
  if (strengths.length) {
    const a = strengths[0];
    s.push(`Built on ${a.pos}: ${a.pts.toFixed(0)} starting points, ${ORD(a.rank)} in the league, ${signed(a.vs_median)} on the median.`);
  }
  if (weaknesses.length) {
    const w = weaknesses[0];
    s.push(`${w.pos} is the hole — ${w.pts.toFixed(0)} points, ${ORD(w.rank)}, ${w.vs_median.toFixed(0)} behind.`);
  } else {
    s.push("Nothing sits in the bottom three, which is its own problem: no deficit to fix and no surplus to sell.");
  }
  const dep = t.bench.filter((p) => p._surplus.starts_on >= 4);
  if (dep.length) {
    s.push(`${dep.length} bench player${dep.length === 1 ? "" : "s"} would start on four or more other teams ` +
      `(${dep.slice(0, 3).map((p) => p.name).join(", ")}) — that is the tradeable surplus.`);
  } else {
    s.push("No bench player would start on four other teams, so there is little here to trade from.");
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
  const strengths = gradable.filter((p) => p.rank <= 3).sort((a, b) => a.rank - b.rank);
  const weaknesses = gradable.filter((p) => p.rank >= 8).sort((a, b) => b.rank - a.rank);

  const r = risks(t);
  const d = dossiers.get(t.roster_id) || {};

  t.out = {
    roster_id: t.roster_id, owner: t.owner, user_id: t.user_id, is_me: t.is_me,
    draft_slot: t.draft_slot,
    starter_pts: t.total, starter_rank: t.starter_rank,
    vs_league_median: +(t.total - leagueMedianStarters).toFixed(1),
    bench_pts: +t.bench.reduce((a, p) => a + ptsOf(p), 0).toFixed(1),
    summary: summarize(t, strengths, weaknesses, r),
    slots, by_pos: posRows, strengths, weaknesses, risks: r,
    bench: t.bench.map((p) => ({ ...label(p.id), bye: p.bye != null ? p.bye : null, ...p._surplus })),
    unpriced: t.unpriced.map((id) => ({
      id, name: byId.get(id) ? byId.get(id).name : id,
      note: "no 2026 projection — excluded from every total on this page",
    })),
    tendencies: {
      draft: d.draft || null, faab: d.faab || null, trades: d.trades || null,
      exploit: d.exploit || null, history: d.history || null,
      appetite: appetite(t.roster_id),
      channel_with_me: (trades.channel[MY_ROSTER] || {})[t.roster_id] || 0,
    },
    proposals: t.is_me ? [] : proposalsFor(t),
    fit: t.is_me ? null : fitWith(t),
  };
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
    projection: "Sleeper 2026 projected stat lines re-scored with the league's exact scoring_settings (data/raw/league-2026.json) — the same numbers the draft board runs on.",
    lineup: `Optimal lineup under ${SLOTS.join("/")}, five bench. Greedy is optimal here because slot eligibility nests.`,
    strength: "Per-slot and per-position rank against the other nine teams. K and DEF are reported but never graded — they are streaming positions in this format.",
    surplus: "A bench player's \"starts on N\" is measured by recomputing each of the other nine optimal lineups with him inserted.",
    trades: `Exhaustive 1-for-1 and 2-for-1 search. A proposal ships only if BOTH optimal lineups rise (>= ${GAIN_1} season points for a 1-for-1; >= ${GAIN_2_ME} to me and >= ${GAIN_2_THEM} to them for a 2-for-1, where the other side must also take on more raw projected points than it gives).`,
    tendencies: "Parsed from league-tendencies.md; trade counts recomputed from data/raw/transactions-2020..2025.json.",
    caveat: "A projection is a season-long point estimate. It cannot see a camp role change, it prices DEF poorly (points-allowed tiers do not project), and it says nothing about week-to-week ceiling. Every number here is the start of an argument, not the end of one.",
  },
  coverage: {
    rostered: rosteredIds.length,
    priced: rosteredIds.filter((id) => ptsOf(byId.get(id)) != null).length,
    off_board_priced: offBoard.length,
    league_median_starters: leagueMedianStarters,
  },
  slot_table: slotTable.map((s) => ({ slot: s.slot, index: s.index, median: s.median, best: s.best })),
  pos_table: Object.fromEntries(POSES.map((p) => [p, { median: posTable[p].median }])),
  trade_history: { total: trades.total, seasons: trades.seasons, by_year: trades.years, per_roster: trades.per },
  teams: teams.map((t) => t.out),
};

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));

const nProp = payload.teams.reduce((a, t) => a + t.proposals.length, 0);
console.log(`\nWrote ${path.relative(ROOT, OUT)}`);
console.log(`  ${payload.teams.length} teams · ${payload.coverage.priced}/${payload.coverage.rostered} players priced · median starters ${leagueMedianStarters}`);
console.log(`  ${nProp} trade proposals across ${payload.teams.filter((t) => t.proposals.length).length} partners`);
for (const t of [...payload.teams].sort((a, b) => a.starter_rank - b.starter_rank)) {
  console.log(`  ${String(t.starter_rank).padStart(2)}. ${t.owner.padEnd(17)} ${String(t.starter_pts).padStart(7)}  ` +
    `${t.proposals.length} offers  [${t.tendencies.appetite.band}]`);
}
