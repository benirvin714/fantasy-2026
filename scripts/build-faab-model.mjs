// Build data/faab-market.json — compact FAAB pricing model from 6 seasons of raw Sleeper data.
// Run on demand only (post-draft / when new-season transactions accumulate): node scripts/build-faab-model.mjs
//
// AGGREGATION PATH (deliberately different from verify-claims.mjs, which walked per-owner
// per-transaction): flatten every waiver bid (won AND failed) into one event list, derive
// contested groups by (season, week, player) from that list, then roll owner stats up from it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = path.join(ROOT, "data", "raw");
const OUT = path.join(ROOT, "data", "faab-market.json");
const SEASONS = ["2020", "2021", "2022", "2023", "2024", "2025"];

const J = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(1);
};

// ---- 1. Flatten: one event per waiver bid, one per FA add ------------------
const bidEvents = []; // {season, week, owner, playerId, amount, won}
const faAdds = [];    // {season, week, owner}
for (const season of SEASONS) {
  const nameOf = {};
  for (const u of arr(J(`users-${season}.json`))) nameOf[u.user_id] = u.display_name;
  const ownerOfRoster = {};
  for (const r of arr(J(`rosters-${season}.json`))) ownerOfRoster[r.roster_id] = nameOf[r.owner_id];

  for (const t of arr(J(`transactions-${season}.json`))) {
    if (!t) continue;
    const owner = ownerOfRoster[t.roster_ids?.[0]];
    const playerId = Object.keys(t.adds ?? {})[0] ?? null;
    if (t.type === "waiver" && t.settings?.waiver_bid != null) {
      bidEvents.push({ season, week: t.leg ?? 0, owner, playerId, amount: t.settings.waiver_bid, won: t.status === "complete" });
    } else if (t.type === "free_agent" && t.status === "complete" && playerId) {
      faAdds.push({ season, week: t.leg ?? 0, owner });
    }
  }
}

// ---- 2. Contested groups by (season, week, player) -------------------------
const groups = new Map();
for (const e of bidEvents) {
  if (!e.playerId) continue;
  const k = `${e.season}|${e.week}|${e.playerId}`;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(e);
}
for (const g of groups.values()) g.sort((a, b) => b.amount - a.amount);

const winningBids = bidEvents.filter((e) => e.won);
const contestedWins = []; // {winner event, runnerUpAmount, margin}
let uncontestedWins = 0;
for (const g of groups.values()) {
  const winner = g.find((e) => e.won);
  if (!winner) continue;
  const losers = g.filter((e) => !e.won);
  if (losers.length === 0) { uncontestedWins++; continue; }
  contestedWins.push({ winner, runnerUp: losers[0].amount, margin: winner.amount - losers[0].amount });
}

// ---- 3. League-level stats -------------------------------------------------
const winAmounts = winningBids.map((e) => e.amount).sort((a, b) => a - b);
const addsByWeek = {};
for (const e of [...winningBids, ...faAdds]) addsByWeek[e.week] = (addsByWeek[e.week] ?? 0) + 1;
const frenzies = {};
for (const e of winningBids.filter((e) => e.amount >= 30)) {
  (frenzies[e.season] ??= []).push(e.amount);
}
const lateAdds = [...winningBids, ...faAdds].filter((e) => e.week >= 15).length;

const league = {
  seasons_covered: SEASONS,
  winning_bids: winAmounts.length,
  median_winning_bid: quantile(winAmounts, 0.5),
  mean_winning_bid: +(winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length).toFixed(1),
  pct_uncontested_wins: +((uncontestedWins / (uncontestedWins + contestedWins.length)) * 100).toFixed(1),
  avg_contested_win_margin: +(contestedWins.reduce((a, c) => a + c.margin, 0) / contestedWins.length).toFixed(1),
  peak_add_weeks: Object.entries(addsByWeek).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => ({ week: +w, adds: n })),
  adds_weeks_15_17_total: lateAdds,
  frenzy_bids_30_plus: Object.fromEntries(SEASONS.map((s) => [s, { count: (frenzies[s] ?? []).length, max: Math.max(0, ...(frenzies[s] ?? [])) }])),
};

// ---- 4. Owner-level stats from the flat list --------------------------------
// Archetype tags are qualitative, sourced from league-tendencies.md dossiers (2020-25).
const TAGS = {
  mfkr: "early-burner", DiaperDutyDaddy: "late-frenzy", ENOTS: "volume-aggressor",
  pauldag: "hoarder-sniper", Stipe: "passive-low-ceiling", DadKing: "capped-25",
  bwalsh89: "rare-but-big", StoneBone69: "volume-sprayer", Sladsous: "hoard-then-burn",
  ThatWasButtery: "disciplined-mid",
};
const owners = {};
for (const owner of new Set(bidEvents.map((e) => e.owner))) {
  if (!owner) continue;
  const mine = bidEvents.filter((e) => e.owner === owner);
  const amounts = mine.map((e) => e.amount).sort((a, b) => a - b);
  const wins = mine.filter((e) => e.won);
  const myContestedBids = mine.filter((e) => { const k = `${e.season}|${e.week}|${e.playerId}`; return (groups.get(k)?.length ?? 0) > 1; });
  const myContestedWins = contestedWins.filter((c) => c.winner.owner === owner);
  const maxEv = mine.reduce((m, e) => (e.amount > (m?.amount ?? -1) ? e : m), null);
  const contestedAmounts = myContestedBids.map((e) => e.amount).sort((a, b) => a - b);
  const nContested = contestedAmounts.length;
  owners[owner] = {
    tag: TAGS[owner] ?? "untagged",
    n_bids: mine.length,
    n_wins: wins.length,
    n_failed: mine.length - wins.length,
    median_bid: quantile(amounts, 0.5),
    p90_bid: quantile(amounts, 0.9),
    // max_bid = highest bid ever PLACED (won or lost) — willingness-to-pay, not biggest win
    max_bid: maxEv ? { amount: maxEv.amount, season: maxEv.season, week: maxEv.week, won: maxEv.won } : null,
    n_contested: nContested,
    avg_contested_win_margin: myContestedWins.length ? +(myContestedWins.reduce((a, c) => a + c.margin, 0) / myContestedWins.length).toFixed(1) : null,
    // price_to_beat: p90 of their bids in contested situations, +1. Low n_contested (<8) => use league band instead.
    price_to_beat: nContested ? Math.round(quantile(contestedAmounts, 0.9)) + 1 : null,
    adds_per_season: +(([...wins, ...faAdds.filter((a) => a.owner === owner)].length) / SEASONS.length).toFixed(1),
  };
}

// ---- 5. Bands ---------------------------------------------------------------
const bands = {
  routine_uncontested: "1-3",
  contested_routine: "8-12",
  beat_capped_owner: 26,
  frenzy_floor: 60,
  note: "Frenzy = injury-replacement RB weeks; historical clearing 30-85. Money is near-dead after week 14.",
};

const model = {
  generated: new Date().toISOString().slice(0, 10),
  method: "flat bid-event list; contested groups keyed (season,week,player); see scripts/build-faab-model.mjs",
  small_sample_rule: "if an owner's n_contested < 8, ignore price_to_beat and use bands.contested_routine",
  league, owners, bands,
};
fs.writeFileSync(OUT, JSON.stringify(model, null, 1) + "\n");
console.log(`Wrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
console.log(`Anchors: DadKing max=${owners.DadKing?.max_bid?.amount}, ENOTS margin=+${owners.ENOTS?.avg_contested_win_margin}, uncontested=${league.pct_uncontested_wins}%`);
console.log(`pauldag bids by season:`, SEASONS.map((s) => `${s}:${bidEvents.filter((e) => e.owner === "pauldag" && e.season === s && e.won).reduce((a, e) => a + e.amount, 0)}`).join(" "));
console.log(`Low-sample owners (n_contested<8):`, Object.entries(owners).filter(([, o]) => o.n_contested < 8).map(([n]) => n).join(", ") || "none");
