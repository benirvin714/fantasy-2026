#!/usr/bin/env node
// Merge deep-scout agent JSON into data/draft-research.json. ONE writer.
//
// Parallel agents must never each read-modify-write the research file; five
// concurrent writes silently keep one and drop four. Agents return JSON, the
// caller saves each response to a file, and this script is the only thing that
// touches draft-research.json.
//
// Usage:
//   node scripts/deep-scout-merge.mjs <dir-or-file...> [--dry-run] [--force]
//
// Validates schema, enums, dates, source shape, house style (no em-dashes) and
// the beat-first bar; cross-checks ids against data/raw/deep-scout-batches.json;
// flags position groups where two players on the same team are both "locked".
// Invalid briefs are reported and SKIPPED, valid ones are applied.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESEARCH = path.join(ROOT, "data", "draft-research.json");
const MANIFEST = path.join(ROOT, "data", "raw", "deep-scout-batches.json");
const EM_DASH = String.fromCharCode(0x2014); // no literal, so this file stays clean itself

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const inputs = argv.filter((a) => !a.startsWith("--"));
if (!inputs.length) {
  console.error("usage: node scripts/deep-scout-merge.mjs <dir-or-file...> [--dry-run] [--force]");
  process.exitCode = 2;
} else {
  const files = inputs.flatMap((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) { console.error(`missing input: ${p}`); return []; }
    return fs.statSync(abs).isDirectory()
      ? fs.readdirSync(abs).filter((f) => f.endsWith(".json") || f.endsWith(".txt")).map((f) => path.join(abs, f))
      : [abs];
  });

  const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8"));
  const board = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "site", "draft-board.json"), "utf8"));
  const byId = new Map(board.players.map((p) => [String(p.id), p]));
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : null;
  const assigned = new Set((manifest?.batches || []).flatMap((b) => b.ids.map(String)));

  const ROLE = new Set(["locked", "committee", "in_flux"]);
  const FIT = new Set(["plus", "neutral", "minus"]);
  const STYPE = new Set(["coach", "beat", "analyst", "player"]);
  const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const today = new Date();
  const dayDiff = (d) => Math.round((today - new Date(d + "T12:00:00Z")) / 86400000);

  // ---- parse ---------------------------------------------------------------
  const parsed = [];
  const skips = [];
  const teamFacts = [];
  for (const f of files) {
    let raw = fs.readFileSync(f, "utf8").trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    let obj;
    try { obj = JSON.parse(raw); }
    catch (e) { console.error(`PARSE FAIL ${path.basename(f)}: ${e.message}`); continue; }
    if (obj.team_facts) teamFacts.push({ file: path.basename(f), facts: obj.team_facts });
    for (const b of obj.briefs || []) {
      if (b.action === "skip") { skips.push({ file: path.basename(f), id: String(b.id), reason: b.reason || "(none given)" }); continue; }
      parsed.push({ file: path.basename(f), id: String(b.id), brief: b.scouting_brief });
    }
  }

  // ---- validate ------------------------------------------------------------
  const ok = [];
  const bad = [];
  const warn = [];
  for (const p of parsed) {
    const errs = [];
    const b = p.brief;
    const meta = byId.get(p.id);
    const who = `${meta?.name || "?"} (${p.id})`;

    if (!b || typeof b !== "object") errs.push("scouting_brief missing");
    else {
      if (typeof b.prose !== "string" || b.prose.trim().length < 40) errs.push("prose missing or too short");
      if (!ROLE.has(b.role_stability)) errs.push(`role_stability "${b.role_stability}" not in locked|committee|in_flux`);
      if (!FIT.has(b.scheme_fit)) errs.push(`scheme_fit "${b.scheme_fit}" not in plus|neutral|minus`);
      if (typeof b.override_flag !== "boolean") errs.push("override_flag not boolean");
      if (typeof b.rationale !== "string" || !b.rationale.trim()) errs.push("rationale missing");
      if (!isDate(b.as_of)) errs.push(`as_of "${b.as_of}" not YYYY-MM-DD`);
      else if (dayDiff(b.as_of) > 2 || dayDiff(b.as_of) < -1) warn.push(`${who}: as_of ${b.as_of} is ${dayDiff(b.as_of)}d off today`);
      if (!Array.isArray(b.sources) || !b.sources.length) errs.push("sources empty");
      else {
        b.sources.forEach((s, i) => {
          if (!s || typeof s !== "object") return errs.push(`sources[${i}] not an object`);
          if (!s.label) errs.push(`sources[${i}].label missing`);
          if (!/^https?:\/\/\S+$/.test(s.url || "")) errs.push(`sources[${i}].url not a url`);
          if (!isDate(s.date)) errs.push(`sources[${i}].date "${s.date}" not YYYY-MM-DD`);
          if (!STYPE.has(s.type)) errs.push(`sources[${i}].type "${s.type}" invalid`);
        });
        if (!b.sources.some((s) => s.type === "coach" || s.type === "beat")) {
          warn.push(`${who}: analyst/player sources only, no coach or beat (beat-first bar)`);
        }
      }
      for (const field of ["prose", "rationale"]) {
        if (typeof b[field] === "string" && b[field].includes(EM_DASH)) errs.push(`${field} contains an em-dash (house style)`);
      }
    }
    if (!research.players[p.id]) warn.push(`${who}: no existing entry in draft-research.json, will be created`);
    if (assigned.size && !assigned.has(p.id)) warn.push(`${who}: not in the batch manifest, agent went off-assignment`);

    (errs.length ? bad : ok).push({ ...p, errs, name: meta?.name, team: meta?.team, pos: meta?.pos });
  }

  // ---- group coherence -----------------------------------------------------
  const groups = new Map();
  for (const p of ok) {
    if (!p.team || !p.pos) continue;
    const k = `${p.team} ${p.pos}`;
    groups.set(k, [...(groups.get(k) || []), p]);
  }
  const conflicts = [];
  for (const [k, list] of groups) {
    const locked = list.filter((p) => p.brief.role_stability === "locked");
    if (list.length >= 2 && locked.length >= 2) {
      conflicts.push(`${k}: ${locked.map((p) => p.name).join(" and ")} both "locked". One group, one pecking order.`);
    }
  }

  // ---- report --------------------------------------------------------------
  console.log(`files=${files.length}  briefs=${parsed.length}  valid=${ok.length}  rejected=${bad.length}  skipped-by-agent=${skips.length}`);
  if (teamFacts.length) {
    console.log(`\nTEAM FACTS reported:`);
    for (const t of teamFacts) {
      for (const [team, f] of Object.entries(t.facts)) console.log(`  ${team.padEnd(4)} HC ${f.hc || "?"} / OC ${f.oc || "?"}`);
    }
  }
  if (bad.length) {
    console.log(`\nREJECTED (not written):`);
    for (const p of bad) console.log(`  ${p.name || p.id} [${p.file}]\n    - ${p.errs.join("\n    - ")}`);
  }
  if (skips.length) {
    console.log(`\nAGENT SKIPS (thin sourcing, brief left as-is):`);
    for (const s of skips) console.log(`  ${byId.get(s.id)?.name || s.id}: ${s.reason}`);
  }
  if (warn.length) {
    console.log(`\nWARNINGS:`);
    for (const w of warn) console.log(`  - ${w}`);
  }
  if (conflicts.length) {
    console.log(`\nGROUP CONFLICTS:`);
    for (const c of conflicts) console.log(`  - ${c}`);
  }

  // ---- write ---------------------------------------------------------------
  if (conflicts.length && !FORCE) {
    console.log(`\nREFUSING TO WRITE: ${conflicts.length} position group(s) contradict each other.`);
    console.log(`Re-run the owning agent for that group, or pass --force to write anyway.`);
    process.exitCode = 1;
  } else if (DRY) {
    console.log(`\n--dry-run: would write ${ok.length} briefs. Nothing changed.`);
  } else if (!ok.length) {
    console.log(`\nNothing valid to write.`);
  } else {
    for (const p of ok) {
      if (!research.players[p.id]) research.players[p.id] = {};
      research.players[p.id].scouting_brief = p.brief; // only this layer
    }
    fs.writeFileSync(RESEARCH, JSON.stringify(research, null, 2) + "\n");
    console.log(`\nwrote ${ok.length} briefs to data/draft-research.json`);
    console.log(`next: node scripts/validate-scouting.mjs   then   node scripts/build-draft-board.mjs`);
  }
}
