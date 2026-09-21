// HBGBs HQ — dashboard config
// Update LEAGUES[*].league_id at each renewal (see CLAUDE.md maintenance notes).
window.HQ_CONFIG = {
  /* The leagues this dashboard renders. in-season HQ and the roster room read whichever one is
     active (see league-switch.js); everything else on this object is shared by both, because it is
     a fact about the NFL rather than about a league.

     `data` is the published-JSON directory, and it is the only thing that decides which league's
     numbers a panel shows. `pages` gates the parts one league has and the other does not: the Pit
     has no draft page (its draft is done and it never had a board) and no brief until /brief learns
     to write one per league. */
  LEAGUES: {
    hbgbs: {
      key: "hbgbs",
      name: "The HBGBs",
      short: "HBGBs",
      league_id: "1386608052991447040", // 2026 (renewed; verified 2026-07-22). Prior: 2025 = 1257432557251731456
      my_roster_id: 10,
      playoff_teams: 6,
      data: "/data/site",
      pages: { draft: true, brief: true },
    },
    pit: {
      key: "pit",
      name: "The Panther Pit",
      short: "Panther Pit",
      league_id: "1401363352046825472", // year one; 12 teams; drafted 2026-09-04
      my_roster_id: 1,
      playoff_teams: 6,
      data: "/data/site/pit",
      pages: { draft: false, brief: false },
    },
    clash: {
      key: "clash",
      name: "Couples Clash",
      short: "Couples Clash",
      league_id: "1403499370376179712", // year one; 14 teams; drafted 2026-09-08
      my_roster_id: 11,
      /* Verified 2026-09-21 against the live Sleeper league object and data/raw/league-clash-2026.json:
         7 of 14 make it. The 6 that sat here was a placeholder copied from the other two leagues, and
         it drew the roster room's cut line one seed short while the Performance panel read 7. */
      playoff_teams: 7,
      data: "/data/site/clash",
      pages: { draft: false, brief: false },
    },
  },
  DEFAULT_LEAGUE: "hbgbs",

  MY_USER_ID: "603035152494436352",
  MY_NAME: "ThatWasButtery",

  API: "https://api.sleeper.app/v1",

  /* Shared across every league — none of it depends on scoring or on who is rostered where. */
  EVENTS_JSON: "/data/site/nfl-events.json",
  // Shared by every league: recent snap/target usage, league-agnostic (§1.33). The waiver board's
  // usage line reads it; each league's risers are computed from it in that league's roster room.
  USAGE_JSON: "/data/site/usage-recent.json",
  DRAFT_BOARD_JSON: "/data/site/draft-board.json",
  TEAM_ENV_JSON: "/data/site/team-environment.json",

  /* Per-league paths are built from LEAGUES[key].data by league-switch.js and land on
     HQ_CONFIG.active. Nothing should read the four below directly; they are here so an older
     cached copy of a page still resolves rather than throwing. */
  ROSTER_ROOM_JSON: "/data/site/roster-room.json",
  PLAYER_NEWS_JSON: "/data/site/player-news.json",
  WAIVERS_JSON: "/data/site/waivers.json",
  BRIEF_JSON: "/data/site/latest-brief.json",
};

/* No back-compat aliases here any more. They existed for site/league.js, which was removed on
   2026-09-07; draft.js reads only API, DRAFT_BOARD_JSON, MY_USER_ID and TEAM_ENV_JSON, none of
   which is per-league. Every league fact now comes off LEAGUES via HQ_CONFIG.active. */
