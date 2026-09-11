#!/usr/bin/env node
/* build-leagues.mjs — rebuild every league's published JSON, in one command.
 *
 * WHY THIS EXISTS, and it is not convenience. The twice-daily `nfl-daily-events` routine used to
 * name its leagues: steps 8 and 9 ran build-roster-room and build-player-news once for `hbgbs` and
 * once for `pit`. When Couples Clash arrived on 2026-09-09 nobody edited that routine, so for three
 * consecutive refreshes (68c54c9, c8d9277, 4921d73) the Clash was silently skipped - no error, no
 * warning, just data frozen at its last hand-run while the other two moved. The bug was not the
 * missing league. The bug was that a list of leagues lived somewhere a new league would not think
 * to look.
 *
 * So this file iterates `scripts/lib/leagues.mjs` instead, and the routine calls this. Adding a
 * fourth league becomes a registry entry and nothing else - the schedule never needs editing again,
 * which is the only version of this that stays true.
 *
 * ORDER MATTERS WITHIN A LEAGUE, not across them. build-player-news joins the roster room's output,
 * so it runs second for each league. Leagues are independent.
 *
 * A REFUSAL IS NOT A FAILURE. build-roster-room deliberately exits 1 with "Refusing to build:" when
 * a league's rosters are not full - it is a post-draft tool, so it refuses on every scheduled run
 * between a renewal and that season's draft. That is correct behaviour and must not fail the whole
 * run or the other leagues never get built. This runner distinguishes the two: a refusal is
 * reported and skipped, anything else is a real failure and sets the exit code.
 *
 *   node scripts/build-leagues.mjs                  every league in the registry
 *   node scripts/build-leagues.mjs --only=clash     one or more, comma-separated
 *   node scripts/build-leagues.mjs --dry-run        print what would run, run nothing
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAGUES } from "./lib/leagues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit === undefined ? null : (hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true);
};

const only = arg("only");
const dryRun = arg("dry-run") === true;
const keys = only && only !== true
  ? String(only).split(",").map((s) => s.trim()).filter(Boolean)
  : Object.keys(LEAGUES);

const unknown = keys.filter((k) => !LEAGUES[k]);
if (unknown.length) {
  console.error(`Unknown league(s): ${unknown.join(", ")}. Known: ${Object.keys(LEAGUES).join(", ")}.`);
  process.exit(1);
}

/* Each league's two builds, in dependency order. Kept as data rather than a hardcoded pair so the
   day a third per-league build appears it is one line here and not a new loop. */
const STEPS = [
  { script: "build-roster-room.mjs", label: "roster room" },
  { script: "build-player-news.mjs", label: "player news" },
];

const run = (script, key) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), `--league=${key}`], {
  cwd: ROOT,
  stdio: ["ignore", "inherit", "pipe"],   // stderr captured so a refusal can be told from a crash
  encoding: "utf8",
});

const results = [];
for (const key of keys) {
  const L = LEAGUES[key];
  console.log(`\n=== ${L.name} (${key}) ===`);
  if (dryRun) {
    for (const s of STEPS) console.log(`  would run: node scripts/${s.script} --league=${key}`);
    results.push({ key, name: L.name, status: "dry-run" });
    continue;
  }

  let status = "built", note = "";
  for (const s of STEPS) {
    const r = run(s.script, key);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.status === 0) continue;

    /* The one expected non-zero: the post-draft guard. Skip the rest of THIS league and carry on
       with the others, exactly as the routine was previously told to do by hand. */
    if (/Refusing to build:/.test(r.stderr ?? "")) {
      status = "skipped";
      note = (r.stderr.match(/Refusing to build: ([^\n]*)/) ?? [])[1] ?? "refused by a build guard";
    } else {
      status = "FAILED";
      note = `${s.script} exited ${r.status ?? "on a signal"}`;
    }
    break;   // player news joins the roster room; there is nothing to build on a refusal or a crash
  }
  results.push({ key, name: L.name, status, note });
}

console.log("\n---------------------------------------------------------------");
for (const r of results) {
  console.log(`  ${r.status.padEnd(8)} ${r.name}${r.note ? `  — ${r.note}` : ""}`);
}
const failed = results.filter((r) => r.status === "FAILED");
const skipped = results.filter((r) => r.status === "skipped");
if (skipped.length) {
  console.log(`\n${skipped.length} league(s) skipped by a build guard. That is expected before a draft, not an error.`);
}
if (failed.length) {
  console.error(`\n${failed.length} league(s) FAILED. The rest were still built; fix these and re-run.`);
  process.exit(1);
}
const built = results.filter((r) => r.status === "built").length;
console.log(dryRun
  ? `\nDry run: ${results.length} league(s) would be rebuilt, nothing was run.`
  : `\n${built} of ${results.length} league(s) rebuilt.`);
