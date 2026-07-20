// HBGBs HQ — dashboard config
// UPDATE LEAGUE_ID when the 2026 league is created (see CLAUDE.md maintenance notes).
window.HQ_CONFIG = {
  LEAGUE_ID: "1257432557251731456", // 2025 season (2026 not yet renewed as of 2026-07-17)
  MY_ROSTER_ID: 10,
  MY_USER_ID: "603035152494436352",
  MY_NAME: "ThatWasButtery",
  PLAYOFF_TEAMS: 6, // top N in standings make the playoffs (drives the cut line)
  API: "https://api.sleeper.app/v1",
  // Local data published by the Claude commands (/waivers, /brief) and the daily events routine
  WAIVERS_JSON: "/data/site/waivers.json",
  BRIEF_JSON: "/data/site/latest-brief.json",
  EVENTS_JSON: "/data/site/nfl-events.json",
  DRAFT_BOARD_JSON: "/data/site/draft-board.json",
};
