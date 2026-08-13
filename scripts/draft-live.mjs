// Live draft state — check picks off data/site/draft-board.json and rebuild all 10 rosters.
// Run on demand:
//   node scripts/draft-live.mjs                    # the league mock (default)
//   node scripts/draft-live.mjs --real             # the real 2026 HBGBs draft
//   node scripts/draft-live.mjs <draft_id>         # any draft
//   ... --last 12 --avail 20 --since 40 --rosters --json
//
// Read-only GETs against Sleeper public REST. Deliberately NOT a daemon: one fetch, one compact
// snapshot. The raw pick feed for a finished 150-pick draft is ~64KB; this prints ~1-2KB, which is
// the whole point — it can be re-run every time a question comes up without burying the context.
// Measured round-trip for the full pick feed is ~60ms, so on-demand beats polling on freshness too.
//
// HONESTY CONTRACT (project ground rule): anything not derivable is printed as unknown WITH the
// reason, never guessed. Two places that bites, both real:
//   - my draft slot is unknown until Sleeper publishes draft_order at draft start;
//   - third-round-reversal drafts break the plain snake math, so we refuse rather than mis-report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOARD = path.join(ROOT, "data", "site", "draft-board.json");

const MOCK_DRAFT_ID = "1393628287921577984"; // league_mock off the 2026 HBGBs, created 2026-08-13
const REAL_DRAFT_ID = "1386608053004017664"; // league 1386608052991447040, status pre_draft
const MY_USER_ID = "603035152494436352"; // ThatWasButtery

// ---- args -------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const num = (name, dflt) => {
  const v = flag(name, null);
  return v === null || v === true ? dflt : Number(v);
};
const positional = argv.find((a) => /^\d{8,}$/.test(a));
const DRAFT_ID = positional ?? (flag("real", false) ? REAL_DRAFT_ID : MOCK_DRAFT_ID);
const N_LAST = num("last", 8);
const N_AVAIL = num("avail", 14);
const SINCE = num("since", 0);
const AS_JSON = flag("json", false) === true;
const SHOW_ROSTERS = flag("rosters", false) === true || !AS_JSON;

// ---- fetch ------------------------------------------------------------------------------------
// CACHE BUSTING IS NOT OPTIONAL HERE — measured live 2026-08-13 against the running mock:
// the plain URL returned 41 picks while a unique-query-param URL returned 65. A 24-pick gap.
// Sleeper fronts both endpoints with Cloudflare (picks: s-maxage=15, meta: s-maxage=30) plus
// stale-while-revalidate=300, so the CDN happily serves a response 80+ seconds old with
// cf-cache-status=UPDATING. During a live draft that is the difference between a usable board
// and one that recommends players who left two rounds ago. A unique param forces cf MISS at a
// cost of ~100ms. Every response's age is echoed below so staleness can never be silent again.
let cacheAge = null;
const get = async (url) => {
  const bust = `${url}${url.includes("?") ? "&" : "?"}_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const r = await fetch(bust, { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  const age = Number(r.headers.get("age") ?? 0);
  if (Number.isFinite(age)) cacheAge = Math.max(cacheAge ?? 0, age);
  return r.json();
};

let draft, picks;
try {
  [draft, picks] = await Promise.all([
    get(`https://api.sleeper.app/v1/draft/${DRAFT_ID}`),
    get(`https://api.sleeper.app/v1/draft/${DRAFT_ID}/picks`),
  ]);
} catch (e) {
  console.error(`FETCH FAILED: ${e.message}`);
  console.error("No snapshot printed. Sleeper is the only source for pick state — a partial board");
  console.error("would be worse than none, so nothing is shown rather than a stale half-answer.");
  process.exit(1);
}

if (!fs.existsSync(BOARD)) {
  console.error(`Missing ${path.relative(ROOT, BOARD)} — run: node scripts/build-draft-board.mjs`);
  process.exit(1);
}
const board = JSON.parse(fs.readFileSync(BOARD, "utf8"));

// ---- draft shape ------------------------------------------------------------------------------
const S = draft.settings ?? {};
const TEAMS = S.teams ?? 10;
const ROUNDS = S.rounds ?? 15;
const TOTAL = TEAMS * ROUNDS;
const REVERSAL = S.reversal_round ?? 0;

// Standard snake: odd rounds run 1..N, even rounds run N..1. Third-round reversal (reversal_round
// > 0) repeats a round's order instead of flipping it, which shifts every downstream slot. We do
// not model it — a wrong "on the clock" is worse than an admitted gap.
const slotForPick = (pickNo) => {
  const round = Math.ceil(pickNo / TEAMS);
  const idx = (pickNo - 1) % TEAMS;
  return round % 2 === 1 ? idx + 1 : TEAMS - idx;
};
const label = (pickNo) => {
  const round = Math.ceil(pickNo / TEAMS);
  const inRound = ((pickNo - 1) % TEAMS) + 1;
  return `R${String(round).padStart(2, "0")}.${String(inRound).padStart(2, "0")}`;
};

const made = picks.length;
const onClock = made < TOTAL ? made + 1 : null;

// draft_order is null until Sleeper publishes it at draft start. Never guess a slot from it.
const mySlot = draft.draft_order?.[MY_USER_ID] ?? null;
let myNext = null;
if (mySlot && onClock) {
  for (let p = onClock; p <= TOTAL; p++) {
    if (slotForPick(p) === mySlot) {
      myNext = p;
      break;
    }
  }
}

// ---- board join -------------------------------------------------------------------------------
const byId = new Map(board.players.map((p) => [p.id, p]));
const drafted = new Set(picks.map((p) => p.player_id));

const nameOf = (pick) =>
  byId.get(pick.player_id)?.name ??
  [pick.metadata?.first_name, pick.metadata?.last_name].filter(Boolean).join(" ") ??
  pick.player_id;
const posOf = (pick) => byId.get(pick.player_id)?.pos ?? pick.metadata?.position ?? "?";
const teamOf = (pick) => byId.get(pick.player_id)?.team ?? pick.metadata?.team ?? "";

const adp = (p) => p.adp?.half_ppr ?? Infinity; // the 1 board player without ADP sorts last
const available = board.players
  .filter((p) => !drafted.has(p.id))
  .sort((a, b) => adp(a) - adp(b));

// Positional pressure: of the board's top 24 at each position by ADP, how many are already gone.
// This is the number that actually drives a pivot in a 2-FLEX / 5-bench league.
const runs = {};
for (const pos of ["RB", "WR", "TE", "QB"]) {
  const top = board.players
    .filter((p) => p.pos === pos)
    .sort((a, b) => adp(a) - adp(b))
    .slice(0, 24);
  runs[pos] = { gone: top.filter((p) => drafted.has(p.id)).length, of: top.length };
}

// ---- rosters ----------------------------------------------------------------------------------
// Every team's roster is a pure function of the pick list, so it is rebuilt from scratch on each
// run. Nothing accumulates, which is precisely why no background process is needed.
const STARTERS = [
  ["QB", S.slots_qb ?? 1],
  ["RB", S.slots_rb ?? 2],
  ["WR", S.slots_wr ?? 2],
  ["TE", S.slots_te ?? 1],
  ["K", S.slots_k ?? 1],
  ["DEF", S.slots_def ?? 1],
];
const FLEX_N = S.slots_flex ?? 2;
const FLEX_OK = new Set(["RB", "WR", "TE"]);

const rosters = new Map();
for (let s = 1; s <= TEAMS; s++) rosters.set(s, []);
for (const pick of picks) {
  // draft_slot is authoritative and survives traded picks; picked_by is "" for CPU autopicks.
  const slot = pick.draft_slot ?? slotForPick(pick.pick_no);
  rosters.get(slot)?.push(pick);
}

// Greedy fill: dedicated starting slots first, then FLEX, remainder to bench. Good enough to read
// a rival's remaining needs, which is all this is for — it is not a lineup optimizer.
const needsFor = (roster) => {
  const pool = roster.map(posOf);
  const open = [];
  for (const [pos, n] of STARTERS) {
    const have = pool.filter((x) => x === pos).length;
    if (have < n) open.push(...Array(n - have).fill(pos));
  }
  const spare = ["RB", "WR", "TE"].reduce((acc, pos) => {
    const need = STARTERS.find(([p]) => p === pos)?.[1] ?? 0;
    return acc + Math.max(0, pool.filter((x) => x === pos).length - need);
  }, 0);
  const flexOpen = Math.max(0, FLEX_N - Math.min(spare, FLEX_N));
  return { open, flexOpen };
};

// ---- output -----------------------------------------------------------------------------------
if (AS_JSON) {
  console.log(
    JSON.stringify({
      draft_id: DRAFT_ID,
      status: draft.status,
      picks_made: made,
      total_picks: TOTAL,
      on_clock: onClock && { pick: onClock, slot: slotForPick(onClock), label: label(onClock) },
      my_slot: mySlot,
      my_next_pick: myNext,
      reversal_round: REVERSAL || null,
      runs,
      recent: picks.slice(-N_LAST).map((p) => ({
        pick: p.pick_no, slot: p.draft_slot, name: nameOf(p), pos: posOf(p), team: teamOf(p),
      })),
      available: available.slice(0, N_AVAIL).map((p) => ({
        id: p.id, name: p.name, pos: p.pos, team: p.team,
        adp: p.adp?.half_ppr ?? null, tier: p.fftiers?.tier ?? null, ppg: p.projection?.ppg ?? null,
      })),
      rosters: Object.fromEntries(
        [...rosters].map(([s, r]) => [s, r.map((p) => ({ name: nameOf(p), pos: posOf(p) }))])
      ),
    })
  );
  process.exit(0);
}

const kind = draft.metadata?.type === "league_mock" ? "MOCK" : "REAL";
console.log(`${kind} draft ${DRAFT_ID} — ${draft.status} — ${made}/${TOTAL} picks — ${TEAMS}tm/${ROUNDS}rd/${S.pick_timer ?? "?"}s`);
console.log(`board: data/site/draft-board.json generated ${board.generated} (${board.players.length} players)`);
if (cacheAge > 0) {
  console.log(`\n!! STALE: Cloudflare served a response ${cacheAge}s old despite cache-busting.`);
  console.log(`   Treat the pick count as a floor, not a fact. Re-run before acting on it.`);
}

if (REVERSAL) {
  console.log(`\n!! reversal_round=${REVERSAL}. Snake math is NOT valid for this draft; "on the clock"`);
  console.log(`   and "your next pick" are suppressed rather than reported wrong.`);
} else if (onClock) {
  console.log(`\non the clock: pick #${onClock} ${label(onClock)} slot ${slotForPick(onClock)}`);
  if (mySlot) {
    const away = myNext ? myNext - onClock : null;
    console.log(
      myNext
        ? `your slot ${mySlot} — next pick #${myNext} ${label(myNext)} (${away} pick${away === 1 ? "" : "s"} away)`
        : `your slot ${mySlot} — no picks remaining`
    );
  } else {
    console.log(`your slot: UNKNOWN — Sleeper publishes draft_order at draft start, not before.`);
  }
} else {
  console.log(`\ndraft complete.`);
}

const shown = picks.filter((p) => p.pick_no > SINCE).slice(-N_LAST);
if (shown.length) {
  console.log(`\nlast ${shown.length} pick${shown.length === 1 ? "" : "s"}${SINCE ? ` (since #${SINCE})` : ""}:`);
  for (const p of shown) {
    console.log(
      `  #${String(p.pick_no).padStart(3)} ${label(p.pick_no)} slot${String(p.draft_slot).padStart(2)}  ` +
        `${nameOf(p).padEnd(22)} ${posOf(p).padEnd(3)} ${teamOf(p)}`
    );
  }
}

console.log(`\nposition runs (top 24 by ADP gone):  ` +
  ["RB", "WR", "TE", "QB"].map((p) => `${p} ${runs[p].gone}/${runs[p].of}`).join("   "));

console.log(`\nbest available (board order by ADP, not a recommendation):`);
for (const p of available.slice(0, N_AVAIL)) {
  const a = p.adp?.half_ppr;
  console.log(
    `  ${p.name.padEnd(22)} ${p.pos.padEnd(3)} ${(p.team ?? "").padEnd(4)} ` +
      `adp ${a == null ? "  n/a" : a.toFixed(1).padStart(5)}  ` +
      `tier ${p.fftiers?.tier ?? "-"}  ${p.projection?.ppg != null ? p.projection.ppg.toFixed(1) + " ppg" : ""}`
  );
}

if (SHOW_ROSTERS && made > 0) {
  console.log(`\nrosters:`);
  for (let s = 1; s <= TEAMS; s++) {
    const r = rosters.get(s);
    const mine = s === mySlot ? " <-- you" : "";
    const { open, flexOpen } = needsFor(r);
    const need = [...open, ...Array(flexOpen).fill("FLEX")];
    console.log(`  slot ${String(s).padStart(2)}  n=${String(r.length).padStart(2)}  ` +
      `needs: ${need.length ? need.join(",") : "starters full"}${mine}`);
    if (r.length) {
      const grouped = ["QB", "RB", "WR", "TE", "K", "DEF"]
        .map((pos) => {
          const names = r.filter((p) => posOf(p) === pos).map((p) => nameOf(p).split(" ").slice(-1)[0]);
          return names.length ? `${pos} ${names.join(", ")}` : null;
        })
        .filter(Boolean);
      console.log(`        ${grouped.join("  |  ")}`);
    }
  }
}
