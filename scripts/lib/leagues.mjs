/* leagues.mjs — the one place that knows there is more than one league.
 *
 * Before this file the league id, my roster id and the output path were three constants at the top
 * of every build script, which is fine for one league and a copy-paste bug factory for two. Every
 * build now takes `--league=<key>` and reads its shape from here.
 *
 * The fields that are NULL are the point of the registry. A year-one league has no owner dossiers
 * and no transaction archive, and the honest way to express that is a null the build branches on,
 * not a missing file the build crashes over. `teams` is deliberately NOT here: it is read from the
 * live roster count at build time, because a hardcoded team count that disagrees with the league is
 * exactly the kind of quiet wrongness this project keeps out of the data.
 */
export const LEAGUES = {
  hbgbs: {
    key: "hbgbs",
    name: "The HBGBs",
    short: "HBGBs",
    league_id: "1386608052991447040",
    my_roster: 10,
    out_dir: "data/site",
    // A committed snapshot rather than a live fetch: the build must price identically on a rerun,
    // and a scoring change should show up as a reviewable diff rather than silently move every number.
    scoring_snapshot: "data/raw/league-2026.json",
    /* draft-board.json's projection.pts IS this league's scoring, so its numbers are taken as-is.
       Any other league has to re-score from the raw stat lines instead - see build-roster-room. */
    board_scored: true,
    dossiers: "league-tendencies.md",
    trade_archive: { from: 2020, to: 2025 },
    profile: "league-profile.md",
  },
  pit: {
    key: "pit",
    name: "The Panther Pit",
    short: "Panther Pit",
    league_id: "1401363352046825472",
    my_roster: 1,
    out_dir: "data/site/pit",
    scoring_snapshot: "data/raw/league-pit-2026.json",
    board_scored: false,
    /* Year one. No dossiers, no archive, and both consumers branch on the null rather than
       reading another league's history and calling it this league's. */
    dossiers: null,
    trade_archive: null,
    profile: "league-profile-pit.md",
  },
  clash: {
    key: "clash",
    name: "Couples Clash",
    short: "Couples Clash",
    league_id: "1403499370376179712",
    my_roster: 11,
    out_dir: "data/site/clash",
    scoring_snapshot: "data/raw/league-clash-2026.json",
    /* FULL PPR, which is why this flag matters more here than it did for the Pit. The board's
       projection.pts is half-PPR arithmetic; run it against this league and every pass-catcher is
       understated by half a point a reception - 40 to 50 points over a season on a target hog, or
       several rounds of draft value. Everything rostered here is re-priced from the raw stat lines. */
    board_scored: false,
    /* Year one, and eleven of the fourteen owners have never appeared in this repo. */
    dossiers: null,
    trade_archive: null,
    profile: "league-profile-clash.md",
  },
};

/* Resolve `--league=<key>` (or a bare `--league <key>`) out of argv. Defaults to hbgbs so every
   existing invocation, including the ones written into the scheduled task, keeps working unchanged. */
export function resolveLeague(argv = process.argv.slice(2)) {
  let key = "hbgbs";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--league=")) key = a.slice(9);
    else if (a === "--league" && argv[i + 1]) key = argv[++i];
  }
  const L = LEAGUES[key];
  if (!L) {
    console.error(`Unknown league "${key}". Known: ${Object.keys(LEAGUES).join(", ")}.`);
    process.exit(1);
  }
  return L;
}

/* Team-count-derived wording, so no string on a 12-team page says "the other nine". */
export const ordinal = (n) =>
  ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th",
   "13th", "14th"][n] ?? `${n}th`;
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen"];
export const spell = (n) => WORDS[n] ?? String(n);
