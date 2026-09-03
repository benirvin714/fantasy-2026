/* build-draft-aid.mjs — compact payload for the phone draft aid (draft.irvinfamily.com).
 *
 * Why a second file instead of reading draft-board.json directly: the board is ~800KB because it
 * carries scouting prose, injury history and usage splits per player. None of that renders on a
 * 393px screen, and draft day is exactly when you're on cell service in somebody's basement. This
 * strips it to the eight fields the aid actually paints — under 40KB, one round trip.
 *
 * Tiers are Boris Chen's (fftiers / FantasyPros consensus, GMM-clustered) in half-PPR, already
 * fetched and matched by build-draft-board.mjs. We re-use its output rather than re-fetching so the
 * phone board and the desktop board can never disagree about a tier.
 *
 * Run:  node scripts/build-draft-aid.mjs   (after build-draft-board.mjs)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "data", "site", "draft-board.json");
const OUT = path.join(ROOT, "data", "site", "draft-aid.json");

if (!fs.existsSync(SRC)) {
  console.error(`missing ${SRC} — run: node scripts/build-draft-board.mjs`);
  process.exit(1);
}
const board = JSON.parse(fs.readFileSync(SRC, "utf8"));

// A player earns a slot if he's either in Boris Chen's top 200 or carries an ADP. Everything else
// is board padding that would just be dead rows you have to scroll past.
const rows = [];
for (const p of board.players) {
  const rank = p.fftiers?.rank ?? null;
  const adp = p.adp?.half_ppr ?? null;
  if (rank == null && adp == null) continue;
  const id = p.ids?.sleeper ?? p.id;
  if (!id) continue;                                  // no Sleeper id = the live feed can't strike him
  rows.push({
    id: String(id),
    n: p.name,
    p: p.pos,
    t: p.team ?? null,
    b: p.bye ?? null,
    r: rank,
    tr: p.fftiers?.tier ?? null,
    a: adp,
  });
}

// Ranked players in consensus order; the ADP-only tail after them, cheapest ADP first. Sorting the
// tail by ADP rather than dropping it means late-round kickers and defenses are still findable.
rows.sort((x, y) => {
  if (x.r != null && y.r != null) return x.r - y.r;
  if (x.r != null) return -1;
  if (y.r != null) return 1;
  return (x.a ?? 999) - (y.a ?? 999);
});

const out = {
  generated: new Date().toISOString().slice(0, 10),
  board_generated: board.generated ?? null,
  tiers: {
    source: board.fftiers?.source ?? null,
    status: board.fftiers?.status ?? null,
    updated: board.fftiers?.updated ?? null,
  },
  adp: "Sleeper half-PPR ADP",
  counts: {
    total: rows.length,
    tiered: rows.filter((r) => r.tr != null).length,
  },
  players: rows,
};

fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`draft-aid.json: ${rows.length} players (${out.counts.tiered} tiered), ${kb} KB`);
console.log(`tiers: ${out.tiers.status} (updated ${out.tiers.updated})`);
