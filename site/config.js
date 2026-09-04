// HBGBs HQ — dashboard config
// LEAGUE_ID is the active season; update it at each renewal (see CLAUDE.md maintenance notes).
window.HQ_CONFIG = {
  LEAGUE_ID: "1386608052991447040", // 2026 season (renewed; verified 2026-07-22). Prior: 2025 = 1257432557251731456
  MY_ROSTER_ID: 10,
  MY_USER_ID: "603035152494436352",
  MY_NAME: "ThatWasButtery",
  /* The other-league tab's starting league (site/league.html, §1.24). A DEFAULT, not a binding:
     the page still takes any league id you paste, `?league=<id>` beats this, a connected league is
     remembered per-browser, and disconnect sticks. It exists so the tab opens on the right league
     on a device you have never used it on. Set it to "" to have the tab start empty. */
  OTHER_LEAGUE_ID: "1401363352046825472",
  PLAYOFF_TEAMS: 6, // top N in standings make the playoffs (drives the cut line)
  API: "https://api.sleeper.app/v1",
  // Local data published by the Claude commands (/waivers, /brief) and the daily events routine
  WAIVERS_JSON: "/data/site/waivers.json",
  BRIEF_JSON: "/data/site/latest-brief.json",
  EVENTS_JSON: "/data/site/nfl-events.json",
  DRAFT_BOARD_JSON: "/data/site/draft-board.json",
  ROSTER_ROOM_JSON: "/data/site/roster-room.json",
  // Per-player dossiers, fetched lazily the first time somebody clicks a name (see player-news.js)
  PLAYER_NEWS_JSON: "/data/site/player-news.json",
  TEAM_ENV_JSON: "/data/site/team-environment.json",
};
