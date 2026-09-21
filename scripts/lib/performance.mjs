/* performance.mjs — the arithmetic behind HQ's roster performance module.
 *
 * Pure functions only: no fetching, no league knowledge, no file access. build-roster-room.mjs
 * fetches and prices; this file turns those numbers into standing, luck and bye reads. Kept apart so
 * every rule the design fixed (plans/roster-performance-module.md) can be checked against small
 * hand-built inputs rather than only against a live league.
 *
 * Two readings, never blended (Q14). STANDING is what results decide outright: record, seed, games
 * from the playoff line. STRENGTH is the projection. scripts/calibrate-perf-k.mjs measured that
 * results add almost nothing to the projection as a predictor of future scoring in this league, so
 * a blended "verdict" would be a projection rank with noise stirred in. Results get the question
 * they own; the projection gets the one it predicts.
 */

export const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
const FLEX_OK = new Set(["RB", "WR", "TE"]);
export const SKILL = new Set(["QB", "RB", "WR", "TE"]);

/* Greedy optimal lineup over plain {id, pos, pts} rows. Same slot shape and the same nesting
   argument as assignLineup() in the build (every dedicated slot takes the best at its position,
   then FLEX takes the best RB/WR/TE left), repeated here over arbitrary players because the
   weeks this file scores include players who have since been dropped and are not on any board. */
export function optimal(players) {
  const pool = players.filter((p) => p && p.pos && p.pts != null).sort((a, b) => b.pts - a.pts);
  const used = new Set(), starters = [], empty = [];
  const take = (slot, ok) => {
    const p = pool.find((x) => !used.has(x.id) && ok(x.pos));
    if (p) { used.add(p.id); starters.push(p); } else empty.push(slot);
  };
  for (const s of SLOTS) if (s !== "FLEX") take(s, (pos) => pos === s);
  take("FLEX", (pos) => FLEX_OK.has(pos));
  take("FLEX", (pos) => FLEX_OK.has(pos));
  return { total: +starters.reduce((a, p) => a + p.pts, 0).toFixed(2), starters, empty };
}

/* Team -> set of bye weeks, from the season schedule's pairings. A bye is a week a team plays no
   game; a canceled game is NOT a bye (it is its own fact, see nfl-week.mjs), so canceled rows are
   dropped before the gap is measured and a team idled only by a cancellation shows up here as a bye
   week it did not really have. That case exists once in 2026 (DAL-SEA, week 6) and both teams have
   another game that week, so it does not bite; it is named rather than assumed away. */
export function teamByes(scheduleRows, weeks = 18) {
  const plays = new Map();
  for (const g of scheduleRows) {
    if (g.status === "canceled") continue;
    for (const t of [g.home, g.away]) {
      if (!plays.has(t)) plays.set(t, new Set());
      plays.get(t).add(g.week);
    }
  }
  const out = new Map();
  for (const [t, ws] of plays) {
    const off = new Set();
    for (let w = 1; w <= weeks; w++) if (!ws.has(w)) off.add(w);
    out.set(t, off);
  }
  return out;
}

/* ------------------------------------------------------------------ results, week by week
   `weeks` is [{ w, rows }] where rows are that league's Sleeper matchup rows for a FINAL week only
   (the caller gates on ESPN's completed flag, Q12). Each row: roster_id, matchup_id, points.
   Returns roster_id -> [{ w, pts, opp, opp_pts, result, ap: {w,l,t} }].

   ALL-PLAY is the schedule-luck control: your record if you had played every other team that week.
   Head-to-head decides who gets in; all-play says how much of that was the draw. */
export function weeklyResults(weeks) {
  const per = new Map();
  for (const { w, rows } of weeks) {
    const pts = new Map(rows.map((r) => [r.roster_id, r.pts]));
    for (const r of rows) {
      const opp = rows.find((o) => o.roster_id !== r.roster_id && o.matchup_id != null && o.matchup_id === r.matchup_id) || null;
      const ap = { w: 0, l: 0, t: 0 };
      for (const [rid, p] of pts) {
        if (rid === r.roster_id) continue;
        if (r.pts > p) ap.w++; else if (r.pts < p) ap.l++; else ap.t++;
      }
      const result = !opp ? null : r.pts > opp.pts ? "W" : r.pts < opp.pts ? "L" : "T";
      if (!per.has(r.roster_id)) per.set(r.roster_id, []);
      per.get(r.roster_id).push({ w, pts: r.pts, opp: opp ? opp.roster_id : null, opp_pts: opp ? opp.pts : null, result, ap });
    }
  }
  return per;
}

/* Games between two records, the way standings print it: half a game per win and half per loss.
   Positive means `a` is ahead of `b`. */
export const gamesBetween = (a, b) => ((a.w - b.w) + (b.l - a.l)) / 2;

/* Standings from results. Order is wins (ties worth half), then points for — Sleeper's default
   seeding tiebreak. `playoff_seed_type` in the league settings is about re-seeding the BRACKET,
   not about this order, so it is not read here. */
export function standings(records, playoffTeams) {
  const rows = [...records].sort((a, b) =>
    (b.w + b.t / 2) - (a.w + a.t / 2) || b.pf - a.pf);
  rows.forEach((r, i) => { r.seed = i + 1; });
  const lastIn = rows[playoffTeams - 1] || null, firstOut = rows[playoffTeams] || null;
  for (const r of rows) {
    if (r.seed <= playoffTeams) {
      r.line = firstOut ? { inside: true, games: gamesBetween(r, firstOut), vs_seed: firstOut.seed, vs_roster: firstOut.roster_id } : { inside: true, games: null };
    } else {
      r.line = lastIn ? { inside: false, games: gamesBetween(lastIn, r), vs_seed: lastIn.seed, vs_roster: lastIn.roster_id } : { inside: false, games: null };
    }
  }
  return rows;
}

/* Rank a metric across teams, 1 = best. `higherBetter` false for things like points lost. Ties
   share a rank, so two teams at 0.0 points lost are both 1st, not 1st and 2nd. */
export function rankBy(rows, key, higherBetter = true) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null);
  const sorted = [...new Set(vals)].sort((a, b) => higherBetter ? b - a : a - b);
  const out = new Map();
  for (const r of rows) {
    if (r[key] == null) { out.set(r.roster_id, null); continue; }
    out.set(r.roster_id, 1 + vals.filter((v) => higherBetter ? v > r[key] : v < r[key]).length);
  }
  return out;
}

export const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(s[lo] + (s[hi] - s[lo]) * (pos - lo)).toFixed(2);
};

/* ------------------------------------------------------------------ bye weeks, replacement-aware
   The loss a bye costs is NOT "full lineup minus the lineup without him". A kicker, a defense and
   usually a quarterback are free on the wire every Tuesday, so an empty K slot is not a hole.
   The cost that matters is what is left AFTER the best free fix: the better of your own bench and
   one free-agent pickup (Q5). One pickup, because that is what a bye-week move realistically is -
   an add and a drop, not a rebuilt roster.

   roster:     [{id, pos, pts, team}]  per-game season projection
   freeAgents: [{id, pos, pts, team, name}]
   byesOf:     team -> Set(weeks)
   Returns { off, full, bench_only, after_fix, loss, bench_loss, fix } for week w. */
export function byeLoss(roster, freeAgents, byesOf, w) {
  const onBye = (p) => !!p.team && (byesOf.get(p.team) || new Set()).has(w);
  const full = optimal(roster).total;
  const avail = roster.filter((p) => !onBye(p));
  const off = roster.filter(onBye);
  const benchOnly = optimal(avail).total;
  /* Best available free agent per position who is not on bye himself that week. */
  const bestFA = new Map();
  for (const f of freeAgents) {
    if (onBye(f)) continue;
    if (!bestFA.has(f.pos) || f.pts > bestFA.get(f.pos).pts) bestFA.set(f.pos, f);
  }
  let afterFix = benchOnly, fix = null;
  for (const f of bestFA.values()) {
    const t = optimal([...avail, f]).total;
    if (t > afterFix + 1e-9) { afterFix = t; fix = f; }
  }
  return {
    off, full,
    bench_only: benchOnly, after_fix: afterFix,
    bench_loss: +(full - benchOnly).toFixed(2),
    loss: +(full - afterFix).toFixed(2),
    fix: fix ? { ...fix, gain: +(afterFix - benchOnly).toFixed(2) } : null,
  };
}
