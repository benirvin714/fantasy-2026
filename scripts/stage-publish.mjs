#!/usr/bin/env node
/* stage-publish.mjs — stage exactly the files a dashboard refresh publishes, derived from the registry.
 *
 * WHY. The twice-daily routine used to carry a hand-written list of paths to `git add`. That is the
 * same defect that made it skip Couples Clash for three refreshes: an enumeration living somewhere a
 * new league would not think to look. Worse here, because it fails one step later and even quieter -
 * the builds run, the files change on disk, and the commit simply does not include them. Nothing
 * errors; the dashboard just stops moving for that league.
 *
 * So the per-league half is derived from scripts/lib/leagues.mjs and only the genuinely shared,
 * genuinely fixed files are named. A fourth league needs no edit here or in the routine.
 *
 * WHAT IT DELIBERATELY DOES NOT STAGE:
 *   - <league>/waivers.json and <league>/latest-brief.json. /waivers and /brief each stage, commit
 *     and push their own output as their final step. Staging them here would sweep a half-written
 *     board into somebody else's commit.
 *   - Anything not on the list. Never `git add -A`: the flags and cache files are gitignored, and any
 *     other working-tree change belongs to a different workflow and is not this run's to commit.
 *
 * A path that does not exist yet is SKIPPED, not an error - a league added to the registry has no
 * published files until its first successful build, and `git add` on a missing path aborts the whole
 * command. Everything skipped is reported.
 *
 *   node scripts/stage-publish.mjs              stage them
 *   node scripts/stage-publish.mjs --dry-run    list what it would stage, touch nothing
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAGUES } from "./lib/leagues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.slice(2).includes("--dry-run");

/* Shared across every league, and genuinely fixed - each is written by one step of the routine. */
const SHARED = [
  "data/site/nfl-events.json",    // step 3, validated in step 5
  "data/site/draft-board.json",   // step 6
  "data/adp-history.json",        // step 6, appended
  "data/rescout-queue.json",      // step 6
  "data/draft-research.json",     // step 7, the drip's rewritten briefs
];
/* Per league, from its out_dir. Both are written by `npm run build:leagues` in step 8. */
const PER_LEAGUE = ["roster-room.json", "player-news.json"];

const wanted = [
  ...SHARED,
  ...Object.values(LEAGUES).flatMap((L) => PER_LEAGUE.map((f) => `${L.out_dir}/${f}`)),
];

const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

const present = [], missing = [];
for (const p of wanted) (fs.existsSync(path.join(ROOT, p)) ? present : missing).push(p);

/* Anything already staged that this run did not ask for belongs to another workflow. Surfacing it
   beats silently sweeping it into "Daily refresh". */
const before = (git("diff", "--cached", "--name-only").stdout ?? "").split("\n").filter(Boolean);
const foreign = before.filter((p) => !wanted.includes(p));

console.log(`Publishing ${Object.keys(LEAGUES).length} league(s): ${Object.keys(LEAGUES).join(", ")}`);
for (const p of present) console.log(`  ${dryRun ? "would stage" : "stage"}  ${p}`);
if (missing.length) {
  console.log(`\n${missing.length} path(s) not on disk yet, skipped (a league has none until its first build):`);
  for (const p of missing) console.log(`  skip   ${p}`);
}
if (foreign.length) {
  console.log(`\nWARNING: ${foreign.length} file(s) were ALREADY staged and are not this run's to publish.`);
  for (const p of foreign) console.log(`  foreign  ${p}`);
  console.log("  They will land in the next commit. Unstage them (git restore --staged <path>) unless you know they belong.");
}
if (dryRun) { console.log("\nDry run: nothing staged."); process.exit(0); }

if (present.length) {
  const r = git("add", "--", ...present);
  if (r.status !== 0) {
    console.error(`git add failed: ${(r.stderr ?? "").trim()}`);
    process.exit(1);
  }
}
const staged = (git("diff", "--cached", "--name-only").stdout ?? "").split("\n").filter(Boolean);
console.log(`\n${staged.length} file(s) staged with changes${staged.length ? ":" : "."}`);
for (const p of staged) console.log(`  ${p}`);
if (!staged.length) console.log("Nothing changed since the last commit - skip the commit rather than creating an empty one.");
