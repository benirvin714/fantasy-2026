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
// It also prints a BRIEF-SLOT line, because /brief wants a weekly cadence and the twice-daily
// routine is the only thing running on a schedule. Rather than a second command (and a second 4am
// permission prompt), the routine reads that line off the run it already makes here.
//
// Why Tuesday morning: waivers process Tuesday and Monday night is settled, so that is the run where
// a landscape read can still change a decision. Why weekly at all: the events routine already scans
// the same four lanes twice a day, so a twice-daily brief would re-research news written 20 minutes
// earlier and its diff - the one thing it uniquely produces - would collapse to the same 12-hour
// window the feed already covers item by item.
//
// Exit codes (for the caller; the printed verdict is what the routine reads):
//   0  IN-SEASON      regular season, week 1-18
//   3  OFF-SEASON     pre/post season, or outside the week range
//   1  UNKNOWN        state could not be fetched. Do NOT guess: skip the run and say so.
// The exit code is the SEASON gate only. BRIEF-SLOT never changes it.
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

/* Local clock, not UTC - the cron that calls this fires in local time, and a UTC hour would put the
   4:05am run on the wrong side of noon for half the year. The routine fires at 4:05am and 4:05pm, so
   hour<12 separates the two slots with hours to spare either side of the jitter. */
const now = new Date();
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = DAYS[now.getDay()];
const slot = now.getHours() < 12 ? "am" : "pm";
const briefSlot = inSeason && day === "Tue" && slot === "am";
console.log(`BRIEF-SLOT ${briefSlot ? "yes" : "no"}  day=${day} slot=${slot}`);
if (!briefSlot && inSeason) {
  console.log("  /brief runs on the Tuesday morning run only. Skip it this run; everything else proceeds.");
}

process.exitCode = inSeason ? 0 : 3;
}
