#!/usr/bin/env node
// Assemble team-batched agent assignments from the live re-scout queue.
//
// Why team batching: a backfield is ONE question with N answers that have to
// agree. Splitting Arizona's four queued RBs across four agents pays for the
// same search four times and lets the briefs contradict each other. Teams stay
// intact in a batch; batches are balanced by player count.
//
// Usage:
//   node scripts/deep-scout-batches.mjs [--agents 5] [--max-rank 150]
//                                       [--reason news,adp_drift] [--quiet]
//
// Prints one ready-to-paste TEAM_BLOCK per agent and writes a manifest to
// data/raw/deep-scout-batches.json (gitignored) for deep-scout-merge.mjs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const AGENTS = Math.max(1, parseInt(flag("agents", "5"), 10));
const MAX_RANK = parseInt(flag("max-rank", "150"), 10);
const REASONS = flag("reason", "").split(",").map((s) => s.trim()).filter(Boolean);
const QUIET = argv.includes("--quiet");
const MANIFEST = path.join(ROOT, "data", "raw", "deep-scout-batches.json");

const board = rd("data/site/draft-board.json");
const queue = rd("data/rescout-queue.json");
const byId = new Map(board.players.map((p) => [String(p.id), p]));

// ---- select ---------------------------------------------------------------
const dropped = { rank: 0, reason: 0, unknown: 0 };
const rows = [];
for (const e of queue.entries || []) {
  const p = byId.get(String(e.id));
  if (!p) { dropped.unknown++; continue; }
  const rank = e.rank ?? 9999;
  if (rank > MAX_RANK) { dropped.rank++; continue; }
  if (REASONS.length && !REASONS.includes(e.reason)) { dropped.reason++; continue; }
  rows.push({
    id: String(e.id),
    name: p.name,
    pos: p.pos,
    team: p.team || "FA",
    rank,
    reason: e.reason,
    trigger_date: e.trigger_date || null,
    brief_as_of: p.scouting_brief?.as_of || null,
  });
}

if (!rows.length) {
  console.log(`No queued players at or above rank ${MAX_RANK}. Nothing to assign.`);
  console.log(`(queue holds ${(queue.entries || []).length}; dropped ${dropped.rank} over rank cap)`);
  fs.writeFileSync(MANIFEST, JSON.stringify({ generated: queue.updated || null, batches: [] }, null, 2) + "\n");
  process.exitCode = 0;
} else {
  // ---- group by team, pack into balanced batches (LPT) ---------------------
  const teams = new Map();
  for (const r of rows) teams.set(r.team, [...(teams.get(r.team) || []), r]);
  for (const list of teams.values()) list.sort((a, b) => a.rank - b.rank);

  const ordered = [...teams.entries()].sort(
    (a, b) => b[1].length - a[1].length || Math.min(...a[1].map((r) => r.rank)) - Math.min(...b[1].map((r) => r.rank))
  );
  const batches = Array.from({ length: Math.min(AGENTS, ordered.length) }, () => []);
  for (const [team, list] of ordered) {
    const target = batches.reduce((best, b, i) =>
      b.reduce((s, t) => s + t.players.length, 0) < best.n
        ? { i, n: b.reduce((s, t) => s + t.players.length, 0) }
        : best,
      { i: 0, n: Infinity }
    ).i;
    batches[target].push({ team, players: list });
  }
  for (const b of batches) b.sort((x, y) => Math.min(...x.players.map((p) => p.rank)) - Math.min(...y.players.map((p) => p.rank)));

  // ---- print ---------------------------------------------------------------
  const total = rows.length;
  if (!QUIET) {
    console.log(`DEEP-SCOUT BATCHES  queue=${(queue.entries || []).length} updated=${queue.updated || "?"}`);
    console.log(`selected ${total} players / ${teams.size} teams  (rank<=${MAX_RANK}${REASONS.length ? `, reason in ${REASONS.join("|")}` : ""})`);
    console.log(`dropped: ${dropped.rank} over rank cap, ${dropped.reason} by reason, ${dropped.unknown} not on board`);
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.team} ${r.pos}`;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    const contested = [...groups.entries()].filter(([, n]) => n >= 2);
    console.log(`position groups needing a single coherent read: ${contested.map(([k, n]) => `${k}x${n}`).join(", ") || "none"}\n`);
  }

  for (const [i, b] of batches.entries()) {
    const n = b.reduce((s, t) => s + t.players.length, 0);
    console.log(`===== AGENT ${i + 1} of ${batches.length}  (${b.length} teams, ${n} players) =====`);
    for (const { team, players } of b) {
      const line = players
        .map((p) => `${p.name} (${p.pos}, id ${p.id}, ADP #${p.rank}, trigger: ${p.reason}${p.brief_as_of ? `, brief ${p.brief_as_of}` : ""})`)
        .join("\n       ");
      console.log(`  ${team}: ${line}`);
    }
    console.log("");
  }

  fs.writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        generated: queue.updated || null,
        max_rank: MAX_RANK,
        reasons: REASONS.length ? REASONS : "all",
        selected: total,
        batches: batches.map((b, i) => ({
          agent: i + 1,
          teams: b.map((t) => t.team),
          ids: b.flatMap((t) => t.players.map((p) => p.id)),
        })),
      },
      null,
      2
    ) + "\n"
  );
  if (!QUIET) console.log(`manifest -> data/raw/deep-scout-batches.json`);
}
