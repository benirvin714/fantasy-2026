import fs from "node:fs";
const C = "./.cache-WIPE-ME/";
const players = JSON.parse(fs.readFileSync(C + "players-nfl.json", "utf8"));
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "").replace(/(jr|sr|iii|ii|iv)$/, "");
const byKey = new Map();
for (const [pid, p] of Object.entries(players)) {
  if (!p.position) continue;
  const nm = p.search_full_name ? norm(p.search_full_name) : norm(`${p.first_name}${p.last_name}`);
  if (!nm) continue;
  const k = `${nm}|${p.position}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(pid);
}
const bad = { age: [], adp: [], stdev: [], priorPpg: [], priorGp: [] };
let n = 0;
for (const y of [2018,2019,2020,2021,2022,2023,2024]) {
  const st = JSON.parse(fs.readFileSync(C + `stats-${y}.json`, "utf8"));
  const pr = JSON.parse(fs.readFileSync(C + `stats-${y-1}.json`, "utf8"));
  const a = JSON.parse(fs.readFileSync(C + `ffc-${y}.json`, "utf8"));
  for (const p of a.players) {
    const pos = p.position === "PK" ? "K" : p.position;
    if (!["QB","RB","WR","TE"].includes(pos)) continue;
    const cands = byKey.get(`${norm(p.name)}|${pos}`) ?? [];
    const pid = cands.find((c) => st[c]) ?? cands[0];
    if (!pid) continue;
    n++;
    const bd = players[pid]?.birth_date;
    const age = bd ? (y - Number(bd.slice(0,4))) + (8 - Number(bd.slice(5,7)))/12 : null;
    const prior = pr[pid];
    const ppg = prior && prior.gp > 0 ? prior.pts_half_ppr/prior.gp : null;
    if (age === null || !Number.isFinite(age)) bad.age.push(`${p.name} bd=${JSON.stringify(bd)} age=${age}`);
    if (!Number.isFinite(p.adp) || p.adp <= 0) bad.adp.push(`${p.name} adp=${p.adp}`);
    if (!Number.isFinite(p.stdev) || p.stdev <= 0) bad.stdev.push(`${y} ${p.name} stdev=${p.stdev}`);
    if (prior && !Number.isFinite(ppg ?? 0)) bad.priorPpg.push(`${p.name} ${prior.pts_half_ppr}/${prior.gp}`);
    if (prior && !Number.isFinite(prior.gp ?? 0)) bad.priorGp.push(`${p.name} gp=${prior.gp}`);
  }
}
console.log("skill rows:", n);
for (const [k, v] of Object.entries(bad)) console.log(`${k}: ${v.length} bad ->`, v.slice(0,6).join(" | "));
