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
  },
  DEFAULT_LEAGUE: "hbgbs",

  MY_USER_ID: "603035152494436352",
  MY_NAME: "ThatWasButtery",

  /* The other-league tab's starting league (site/league.html, §1.24). A DEFAULT, not a binding:
     the page still takes any league id you paste, `?league=<id>` beats this, a connected league is
     remembered per-browser, and disconnect sticks. It exists so the tab opens on the right league
     on a device you have never used it on. Set it to "" to have the tab start empty.
     Deliberately still pointed at the Pit even though the Pit now has real pages: that tab is for
     ANY league, and the Pit is simply the most likely one to want to glance at raw. */
  OTHER_LEAGUE_ID: "1401363352046825472",

  API: "https://api.sleeper.app/v1",

  /* Shared across every league — none of it depends on scoring or on who is rostered where. */
  EVENTS_JSON: "/data/site/nfl-events.json",
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

/* Back-compat for site/draft.js and site/league.js, which predate the switcher and read a single
   flat league. Both are HBGBs-only or league-agnostic, so they keep pointing at the HBGBs. */
window.HQ_CONFIG.LEAGUE_ID = window.HQ_CONFIG.LEAGUES.hbgbs.league_id;
window.HQ_CONFIG.MY_ROSTER_ID = window.HQ_CONFIG.LEAGUES.hbgbs.my_roster_id;
window.HQ_CONFIG.PLAYOFF_TEAMS = window.HQ_CONFIG.LEAGUES.hbgbs.playoff_teams;
