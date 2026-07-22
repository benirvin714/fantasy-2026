// Does the Stage 7 positional result survive a different replacement-level assumption?
import fs from "node:fs";
import { loess, mean, sd } from "./mispricing.mjs";
const C = "./.cache-WIPE-ME/";
const J = (f) => JSON.parse(fs.readFileSync(C + f, "utf8"));
const players = J("players-nfl.json");
const SEASONS = [2018,2019,2020,2021,2022,2023,2024], SKILL = ["QB","RB","WR","TE"];
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g,"").replace(/(jr|sr|iii|ii|iv|v)$/,"");
const byKey = new Map();
for (const [pid,p] of Object.entries(players)) {
  if (!p.position) continue;
  const nm = p.search_full_name ? norm(p.search_full_name) : norm(`${p.first_name}${p.last_name}`);
  if (!nm) continue;
  const k = `${nm}|${p.position}`;
  if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(pid);
}
const stats = {}; for (const y of SEASONS) stats[y] = J(`stats-${y}.json`);
const rows = [];
for (const y of SEASONS) for (const p of J(`ffc-${y}.json`).players) {
  const pos = p.position === "PK" ? "K" : p.position;
  if (!SKILL.includes(pos)) continue;
  const c = byKey.get(`${norm(p.name)}|${pos}`) ?? [];
  const pid = c.find((x) => stats[y][x]) ?? c[0]; if (!pid) continue;
  const s = stats[y][pid] ?? {};
  rows.push({ season: y, pos, adp: p.adp, points: Number.isFinite(s.pts_half_ppr) ? s.pts_half_ppr : 0 });
}
const CONFIGS = {
  "baseline QB12/RB30/WR42/TE12": { QB:1, RB:2.5, WR:3.5, TE:1 },
  "no-flex  QB12/RB24/WR36/TE12": { QB:1, RB:2, WR:3, TE:1 },
  "flex-RB  QB12/RB36/WR36/TE12": { QB:1, RB:3, WR:3, TE:1 },
  "2QB      QB24/RB30/WR42/TE12": { QB:2, RB:2.5, WR:3.5, TE:1 },
  "deep TE  QB12/RB30/WR42/TE18": { QB:1, RB:2.5, WR:3.5, TE:1.5 },
};
console.log("mean residual VORP by position, under different replacement assumptions");
console.log("(t-stat in parens; |t|>2 = distinguishable from fair pricing)\n");
console.log("config".padEnd(30) + SKILL.map((p) => p.padStart(16)).join(""));
for (const [label, ST] of Object.entries(CONFIGS)) {
  for (const y of SEASONS) {
    const repl = {};
    for (const pos of SKILL) {
      const r = Object.entries(stats[y])
        .filter(([pid, s]) => players[pid]?.position === pos && Number.isFinite(s.pts_half_ppr))
        .map(([, s]) => s.pts_half_ppr).sort((a, b) => b - a);
      repl[pos] = r[Math.round(12 * ST[pos]) - 1] ?? 0;
    }
    const yr = rows.filter((r) => r.season === y);
    const raw = yr.map((r) => r.points - repl[r.pos]);
    const s = sd(raw) || 1;
    yr.forEach((r, i) => { r.v = raw[i] / s; });
  }
  const f = loess(rows.map((r) => Math.log(r.adp)), rows.map((r) => r.v), { span: 0.4 });
  const cells = SKILL.map((pos) => {
    const sub = rows.filter((r) => r.pos === pos).map((r) => r.v - f(Math.log(r.adp)));
    const t = mean(sub) / (sd(sub) / Math.sqrt(sub.length));
    return `${mean(sub).toFixed(3).padStart(7)} (${t.toFixed(1).padStart(5)})`.padStart(16);
  });
  console.log(label.padEnd(30) + cells.join(""));
}
