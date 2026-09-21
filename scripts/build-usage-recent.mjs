/* Recent usage — the waiver-side lens (plans/valuation-and-scouting.md §1.33).
 *
 * The draft board's historical-usage panel reads 2023-25 for the top-200 pool, which is exactly
 * where waiver candidates are not. This reads THIS season's final weeks for every skill player who
 * took a snap, and publishes, per player, each week's usage, his last completed week, his last
 * three completed weeks, and a jump flag once there is enough history to claim one.
 *
 * League-agnostic by construction: snaps and targets do not depend on scoring, so one file serves
 * every league. What IS per-league - who is rostered, what a rostered player's usage looks like,
 * and therefore who counts as a riser - is computed by build-roster-room.mjs against this file.
 *
 * Definitions match the draft board's usage panel exactly, so "target share" means one thing on
 * every page:
 *   snap share   off_snp / tm_off_snp
 *   target share rec_tgt / team targets
 *   touch share  (rush_att + rec_tgt) / (team targets + team rush attempts)
 * Team totals come from the per-week (tm_off_snp, tm_def_snp, tm_st_snp) fingerprint every player
 * on a team shares, which keeps a mid-season trade on the right team for each week without any
 * roster history. A cluster this large is two teams merged and is dropped from the denominators.
 *
 * No routes: Sleeper does not publish route participation. Snap share is the stand-in and is
 * labelled as snaps, never as routes.
 *
 * Only FINAL weeks count (every game in the week marked complete by ESPN), the same rule as the
 * performance panel: a Sunday-afternoon build would otherwise read half a week as a role change.
 *
 *   node scripts/build-usage-recent.mjs      ->  data/site/usage-recent.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { weekSchedule } from "./lib/nfl-week.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "site", "usage-recent.json");
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();
const get = async (url) => {
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}${Math.random()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return r.json();
};

const POS = ["QB", "RB", "WR", "TE"];
const MERGED_CLUSTER = 70;     // same guard as build-draft-board.mjs
const WINDOW = 3;              // "last 3-4 weeks" in /waivers step 6; three keeps week 4 honest
/* The one measure per position the level test and the jump read, the draft board's choice
   (DIR_METRIC) except QB, where the board reads rushing volume for a direction and the waiver
   question is simply "is he the starter", which snap share answers. */
export const METRIC = { WR: "target_share", TE: "target_share", RB: "touch_share", QB: "snap_share" };
/* A jump is last week against the mean of the weeks before it in the window, and it needs two
   weeks before it to mean anything. The size is twice the board's multi-year direction threshold
   for the same measure: a one-week move has to be larger than a season-over-season one to count.
   A chosen tunable, not a measured one, and secondary by design - the level test decides who is
   a riser; this only labels why. */
const JUMP = { target_share: 0.06, touch_share: 0.08, snap_share: 0.25 };
const JUMP_MIN_PRIOR = 2;

const state = await get("https://api.sleeper.app/v1/state/nfl");
const season = state.season;
console.log(`Recent usage, ${season}: finding final weeks...`);

/* Final weeks: walk forward from week 1 and stop at the first week that is not fully complete. */
const FINAL = [];
for (let w = 1; w <= 18; w++) {
  const s = await weekSchedule(season, w);
  if (!s.teams_playing || ![...s.byTeam.values()].every((g) => g.completed)) break;
  FINAL.push(w);
}
console.log(`  final weeks: ${FINAL.length ? FINAL.join(", ") : "none yet"}`);

const players = await get("https://api.sleeper.app/v1/players/nfl");
const weekly = {};
for (const w of FINAL) weekly[w] = await get(`https://api.sleeper.app/v1/stats/nfl/regular/${season}/${w}`);

const r3 = (x) => +x.toFixed(3);
const fp = (l) => `${l.tm_off_snp}|${l.tm_def_snp}|${l.tm_st_snp}`;
const byId = new Map();          // id -> [week line]
const warn = [];

for (const w of FINAL) {
  const wk = weekly[w];
  const teams = new Map();
  for (const l of Object.values(wk)) {
    if (l.tm_off_snp == null) continue;
    const t = teams.get(fp(l)) ?? { tgt: 0, ru: 0, n: 0 };
    t.tgt += l.rec_tgt ?? 0; t.ru += l.rush_att ?? 0; t.n++;
    teams.set(fp(l), t);
  }
  const merged = [...teams.values()].filter((t) => t.n >= MERGED_CLUSTER).length;
  if (merged) warn.push(`week ${w}: ${merged} collided team cluster(s) dropped from share denominators`);
  for (const [id, l] of Object.entries(wk)) {
    const pos = players[id]?.position;
    if (!POS.includes(pos) || !(l.gp >= 1) || !(l.off_snp > 0)) continue;
    const t0 = l.tm_off_snp != null ? teams.get(fp(l)) : null;
    const t = t0 && t0.n < MERGED_CLUSTER ? t0 : null;
    const tgt = l.rec_tgt ?? 0, ru = l.rush_att ?? 0;
    const line = {
      w,
      snp: l.off_snp, tm_snp: l.tm_off_snp ?? null,
      tgt, ru, rz: (l.rec_rz_tgt ?? 0) + (l.rush_rz_att ?? 0), air: l.rec_air_yd ?? 0, pa: l.pass_att ?? 0,
      t_tgt: t ? t.tgt : null, t_touch: t ? t.tgt + t.ru : null,
    };
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(line);
  }
}

/* Shares over a set of week lines, summed then divided (a 2-target week and a 12-target week are
   not averaged as equals). A share is null when no week in the set had a trustworthy denominator. */
function agg(lines) {
  const s = (k) => lines.reduce((a, l) => a + (l[k] ?? 0), 0);
  const valid = lines.filter((l) => l.tm_snp && l.t_tgt != null);
  const v = (k) => valid.reduce((a, l) => a + (l[k] ?? 0), 0);
  return {
    games: lines.length,
    snap_share: valid.length && v("tm_snp") ? r3(v("snp") / v("tm_snp")) : null,
    target_share: valid.length && v("t_tgt") ? r3(v("tgt") / v("t_tgt")) : null,
    touch_share: valid.length && v("t_touch") ? r3((v("tgt") + v("ru")) / v("t_touch")) : null,
    tgt_pg: +(s("tgt") / lines.length).toFixed(1),
    touch_pg: +((s("tgt") + s("ru")) / lines.length).toFixed(1),
    rz: s("rz"), air: s("air"), pa_pg: +(s("pa") / lines.length).toFixed(1),
  };
}

const out = [];
const recentWeeks = FINAL.slice(-WINDOW);
for (const [id, lines] of byId) {
  const p = players[id];
  const pos = p.position, metric = METRIC[pos];
  const inWin = lines.filter((l) => recentWeeks.includes(l.w));
  if (!inWin.length) continue;
  const lastW = FINAL[FINAL.length - 1];
  const lastLine = lines.find((l) => l.w === lastW) || null;
  const last = lastLine ? { w: lastW, ...agg([lastLine]) } : null;
  const win = { weeks: inWin.map((l) => l.w), ...agg(inWin) };

  let jump = null;
  const prior = inWin.filter((l) => l.w !== lastW);
  if (last && last[metric] != null && prior.length >= JUMP_MIN_PRIOR) {
    const before = agg(prior)[metric];
    if (before != null) {
      const d = r3(last[metric] - before);
      jump = { metric, from: before, to: last[metric], delta: d, claimed: d >= JUMP[metric] };
    }
  }
  out.push({
    id, name: p.full_name || `${p.first_name} ${p.last_name}`.trim(), pos, team: p.team ?? null,
    injury: p.injury_status || null, metric,
    // The window only: this is a recent-usage lens, and keeping every week would grow the file
    // roughly fivefold by week 14 for history the draft board already covers.
    weeks: inWin.map((l) => ({ w: l.w, ...agg([l]) })),
    last, window: win, jump,
  });
}
out.sort((a, b) => a.pos.localeCompare(b.pos) || (b.window[b.metric] ?? -1) - (a.window[a.metric] ?? -1));

const payload = {
  generated: TODAY,
  season,
  final_weeks: FINAL,
  window_weeks: recentWeeks,
  metric_by_pos: METRIC,
  jump_thresholds: JUMP,
  basis: {
    source: `Sleeper ${season} weekly stats, final weeks only (every game marked complete by ESPN).`,
    shares: "Same definitions as the draft board's usage panel: snap share off_snp/tm_off_snp; target share over team targets; touch share (rush att + targets) over team targets + rush att. Team totals from the per-week team-snap fingerprint, so a traded player is counted on the right team each week.",
    routes: "Not available: Sleeper publishes no route participation. Snap share is the stand-in and is labelled as snaps.",
    window: `Last completed week, and the last ${WINDOW} completed weeks summed then divided.`,
    jump: `Last week against the mean of the weeks before it in the window, claimed at ${Object.entries(JUMP).map(([k, v]) => `+${v} ${k.replace("_", " ")}`).join(", ")} with at least ${JUMP_MIN_PRIOR} prior weeks. A chosen tunable, secondary to the level test.`,
  },
  warnings: warn,
  players: out,
};
fs.writeFileSync(OUT, JSON.stringify(payload));
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${out.length} players over week(s) ${recentWeeks.join(", ") || "none"}, ${(JSON.stringify(payload).length / 1024).toFixed(0)}KB`);
for (const w of warn) console.warn(`  ! ${w}`);
const jumps = out.filter((p) => p.jump && p.jump.claimed);
console.log(`  ${jumps.length} jump(s) claimed${jumps.length ? ": " + jumps.slice(0, 8).map((p) => `${p.name} ${p.jump.metric} ${p.jump.from}->${p.jump.to}`).join("; ") : ""}`);
