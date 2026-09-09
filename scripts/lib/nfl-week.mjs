/* nfl-week.mjs — the two facts a roster needs about the week in front of it: when each team plays,
 * and what each player is projected to do in that one week rather than across the season.
 *
 * Both are league-agnostic. A kickoff is a kickoff and a projected stat line is a projected stat
 * line; what varies by league is the scoring applied to that line, which is the caller's job (see
 * rescore() in build-roster-room.mjs). So this file fetches and validates, and prices nothing.
 *
 * WHY TWO SOURCES FOR ONE SCHEDULE. Sleeper's schedule endpoint carries the pairings and the week
 * but no kickoff time, only a date — and a date alone cannot answer "Sunday early or Sunday night",
 * which is the whole point of the column this feeds. ESPN's public scoreboard carries the full
 * kickoff instant. Measured across all 18 weeks of 2026 on 2026-09-09: 272 ESPN games, 273 Sleeper
 * games, and zero pairing disagreements once WSH is read as WAS. The one extra Sleeper game is
 * DAL-SEA in week 6, carrying status "canceled", which ESPN correctly omits. That single row is why
 * the merge exists rather than a straight ESPN read: a canceled game and a bye week are different
 * facts about an empty Sunday, and printing the same dash for both would be the kind of quiet
 * conflation the rest of this system is built to refuse.
 */

// Its own cache-buster rather than an injected fetcher. Sleeper sits behind Cloudflare with
// stale-while-revalidate and this is a fast-changing read; making that the caller's responsibility
// is how it eventually gets forgotten.
const get = async (url) => {
  const sep = url.includes("?") ? "&" : "?";
  const r = await fetch(`${url}${sep}cb=${Date.now()}${Math.random()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

/* ESPN spells Washington WSH; Sleeper spells it WAS. That is the entire delta between the two
   abbreviation sets, verified against all 32 teams. Anything else appearing here would mean a
   rename on one side, which is why unmapped codes are reported rather than silently dropped. */
const ESPN_TO_SLEEPER = { WSH: "WAS" };
const sl = (t) => ESPN_TO_SLEEPER[t] ?? t;
const pairKey = (a, b) => [a, b].sort().join("-");

/* ------------------------------------------------------------------ this week's games
   Returns a lookup from Sleeper team code to that team's week-N game, plus enough metadata for the
   caller to say out loud which parts of it are real. Never throws: a schedule this build cannot
   reach degrades to date-only, or to nothing, and says which. */
export async function weekSchedule(season, week) {
  const out = {
    season, week,
    byTeam: new Map(),          // team -> { opp, home, kickoff (ISO|null), date, status }
    source: null,
    degraded: null,
    teams_playing: 0,
    canceled: [],
    warnings: [],
  };

  /* Sleeper first: it is the pairing authority (the same feed the bye-week map and every other
     schedule fact in this repo comes from) and it is the source that still works when ESPN does not. */
  let slGames = null;
  try {
    const all = await get(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
    slGames = all.filter((g) => g.week === week);
    if (!slGames.length) throw new Error(`no week ${week} games in the ${season} schedule`);
  } catch (e) {
    out.degraded = `Sleeper's ${season} schedule was unreachable (${e.message})`;
    out.warnings.push(out.degraded);
    slGames = null;
  }

  let espnGames = null;
  try {
    const d = await get(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`);
    espnGames = (d.events ?? []).map((e) => {
      const c = e.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === "home")?.team?.abbreviation;
      const away = c.competitors.find((x) => x.homeAway === "away")?.team?.abbreviation;
      return { home: sl(home), away: sl(away), kickoff: e.date, status: e.status?.type?.name ?? null };
    }).filter((g) => g.home && g.away);
    if (!espnGames.length) throw new Error(`no events returned for week ${week}`);
  } catch (e) {
    out.warnings.push(`ESPN scoreboard unavailable (${e.message}) — kickoff times will be missing and only the day of the game is known.`);
    espnGames = null;
  }

  if (!slGames && !espnGames) {
    out.degraded = "neither Sleeper's schedule nor ESPN's scoreboard could be read";
    return out;
  }

  /* Cross-check before trusting either. A source that has moved a game into a different week is the
     failure mode that matters: it would print a real kickoff against the wrong opponent, which
     reads as fact. A mismatch does not abort the build, it drops that one game to date-only. */
  const trusted = new Map();   // pairKey -> espn game
  if (slGames && espnGames) {
    const slPairs = new Set(slGames.map((g) => pairKey(g.home, g.away)));
    for (const g of espnGames) {
      const k = pairKey(g.home, g.away);
      if (slPairs.has(k)) trusted.set(k, g);
      else out.warnings.push(`ESPN has ${g.away} at ${g.home} in week ${week}, Sleeper does not — kickoff dropped for that game rather than guessed.`);
    }
    const unmapped = [...new Set(espnGames.flatMap((g) => [g.home, g.away]))]
      .filter((t) => !slGames.some((s) => s.home === t || s.away === t));
    if (unmapped.length) out.warnings.push(`ESPN team code(s) ${unmapped.join(", ")} match no Sleeper team this week — check ESPN_TO_SLEEPER in scripts/lib/nfl-week.mjs.`);
  } else if (espnGames) {
    for (const g of espnGames) trusted.set(pairKey(g.home, g.away), g);
  }

  const put = (team, opp, home, kickoff, date, status) => {
    out.byTeam.set(team, { opp, home, kickoff: kickoff ?? null, date: date ?? null, status });
  };

  if (slGames) {
    /* Two passes, because a team can appear twice in one week: Sleeper's 2026 week 6 carries a
       canceled SEA-at-DAL alongside the real SEA-at-DEN and DAL-at-GB. A single pass would let
       whichever row came last win, so the real game is claimed first and a cancellation is only
       ever recorded for a team that has nothing else to play. */
    for (const g of slGames) {
      if (g.status === "canceled") continue;
      const e = trusted.get(pairKey(g.home, g.away));
      put(g.home, g.away, true, e?.kickoff, g.date, e?.status ?? g.status ?? "scheduled");
      put(g.away, g.home, false, e?.kickoff, g.date, e?.status ?? g.status ?? "scheduled");
    }
    for (const g of slGames) {
      if (g.status !== "canceled") continue;
      /* A canceled game is not a bye and not an unknown. A team left idle by one is idle for a
         stated reason, and the roster page says which, because "no game this week" and "game called
         off" lead to different decisions about who to start. */
      const idle = [g.home, g.away].filter((t) => !out.byTeam.has(t));
      if (!idle.length) continue;
      out.canceled.push(`${g.away} at ${g.home} (${idle.join(", ")} idle)`);
      if (idle.includes(g.home)) put(g.home, g.away, true, null, g.date, "canceled");
      if (idle.includes(g.away)) put(g.away, g.home, false, null, g.date, "canceled");
    }
    out.source = espnGames
      ? "pairings from Sleeper's regular-season schedule, kickoff times from ESPN's public scoreboard"
      : "pairings and dates from Sleeper's regular-season schedule; no kickoff times available";
  } else {
    // ESPN alone. Pairings unverified, so say that rather than presenting them as cross-checked.
    for (const g of espnGames) {
      put(g.home, g.away, true, g.kickoff, g.kickoff ? g.kickoff.slice(0, 10) : null, g.status);
      put(g.away, g.home, false, g.kickoff, g.kickoff ? g.kickoff.slice(0, 10) : null, g.status);
    }
    out.source = "ESPN's public scoreboard only (Sleeper's schedule was unreachable, so pairings are uncross-checked)";
  }

  out.teams_playing = out.byTeam.size;
  return out;
}

/* Resolve one player's week. `bye` is the player's bye week off the draft board, derived from the
   same Sleeper schedule, so the two cannot disagree about who is idle. Four outcomes, deliberately
   distinct: a real game, a canceled game, a bye, and "this team has no week-N row at all", which is
   a data problem and should look like one rather than like a quiet bye. */
export function gameFor(sched, team, bye) {
  if (!team) return null;
  const g = sched.byTeam.get(team);
  if (g) return { week: sched.week, opp: g.opp, home: g.home, kickoff: g.kickoff, date: g.date, status: g.status };
  if (bye != null && bye === sched.week) return { week: sched.week, opp: null, home: null, kickoff: null, date: null, status: "bye" };
  return { week: sched.week, opp: null, home: null, kickoff: null, date: null, status: "unknown" };
}

/* ------------------------------------------------------------------ this week's projections
   Same raw stat-line shape as the season endpoint, so the caller's own rescore() prices it in the
   caller's own league. Returns the raw rows; pricing stays with whoever knows the scoring. */
export async function weekProjections(season, week) {
  try {
    const rows = await get(`https://api.sleeper.app/v1/projections/nfl/regular/${season}/${week}`);
    return { rows, error: null, n: Object.keys(rows).length };
  } catch (e) {
    return { rows: {}, error: e.message, n: 0 };
  }
}

/* A player on a bye still has a row, holding nothing but an ADP field. Scoring that row returns
   0.0, which would read as "projected to score nothing" when the truth is "no projection was
   published". `gp` is present on every row carrying a real projected stat line and absent on every
   row that is not, so it is the gate. */
export const hasWeekLine = (row) => !!row && row.gp != null;
