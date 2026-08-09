// Season gate for the in-season scheduled tasks.
//
// The gameday and final-designations routines only earn their keep during the regular
// season, but cron has no idea what month the NFL is in. Rather than hardcode dates (which
// drift every year) or rely on remembering to enable/disable tasks in September, each task
// runs this first and exits early when it prints OFF-SEASON.
//
// It is deliberately ONE stable command with no arguments to compose: the daily routine's
// history is that every ad-hoc `node -e` variant tripped a fresh 4am permission prompt.
//
// Source: Sleeper's public NFL state endpoint (read-only GET), the same clock the league runs on.
//
// Exit codes (for the caller; the printed verdict is what the routine reads):
//   0  IN-SEASON      regular season, week 1-18
//   3  OFF-SEASON     pre/post season, or outside the week range
//   1  UNKNOWN        state could not be fetched. Do NOT guess: skip the run and say so.
//
// Usage: node scripts/nfl-state.mjs

const URL = "https://api.sleeper.app/v1/state/nfl";

let st;
try {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  // connection: close so undici does not hold a keep-alive socket open past the last line;
  // combined with setting process.exitCode (never process.exit) this exits cleanly on Windows,
  // where exiting with a live handle trips a libuv assertion and returns 127 instead of our code.
  const res = await fetch(URL, { signal: ctrl.signal, headers: { connection: "close" } });
  clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  st = await res.json();
} catch (e) {
  console.log(`UNKNOWN  could not reach Sleeper NFL state (${e.message}). Skip this run rather than guessing.`);
  process.exitCode = 1;
}

if (!st) { /* fetch failed above; exitCode already 1 */ }
else {
const season = st.season ?? "?";
const type = st.season_type ?? "?";
const week = Number(st.week ?? 0);
const display = st.display_week != null ? Number(st.display_week) : week;
const inSeason = type === "regular" && week >= 1 && week <= 18;

console.log(`${inSeason ? "IN-SEASON" : "OFF-SEASON"}  season=${season} type=${type} week=${week} display_week=${display}`);
if (!inSeason) console.log("  This slot is regular-season only. Exit now without scanning, writing, or committing.");
process.exitCode = inSeason ? 0 : 3;
}
