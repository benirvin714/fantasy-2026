/* HBGBs Draft Day — 3-layer valuation board (Phase A: $-engine + edge).
   ① Asset value = (Sleeper proj ÷ 17 = healthy per-game rate) × median games, floored at 0 —
      "what he produces", position-agnostic, descriptive (not the sort).
   Scarcity → auction draft-$: marginal over the replacement-rank player, normalized to a budget,
      floored at $1 (no negatives). The replacement-basis knob sets the scarcity line.
   ③ Market edge = your draft-$ − the $ of his ADP slot → TARGET / FAIR / FADE.
   Uncertainty band + rec-confidence are Phase B (edges here are shown WITHOUT the confidence cap;
   a board-vs-Boris-Chen divergence note is the Phase-A stopgap). Ceiling (spike weeks) is a
   separate display attribute, never a value input. Reads data/site/draft-board.json; drafted +
   knob state in localStorage (this browser only). */
(() => {
  const C = window.HQ_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* Drafted players arrive from two sources that must never be conflated: marks YOU made by hand,
     and picks Sleeper reports for a connected draft. Keeping them in separate sets is what lets a
     resync avoid eating your manual corrections, and lets "reset draft" clear your marks without
     pretending it can delete what the league actually did. `taken` stays the union that every
     renderer already reads, and is rebuilt IN PLACE rather than reassigned so the existing closures
     over it stay valid. liveTaken is deliberately never persisted — it is refetched from Sleeper on
     every poll, so a stale localStorage can't carry last week's mock draft into the real one. */
  const LS_KEY = "hq-draft-2026-taken";
  const manualTaken = new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  const liveTaken = new Set();
  const livePickNo = new Map();   // player_id -> pick_no, so a row can say WHEN he went
  const taken = new Set(manualTaken);
  const saveTaken = () => localStorage.setItem(LS_KEY, JSON.stringify([...manualTaken]));
  const rebuildTaken = () => {
    taken.clear();
    for (const id of manualTaken) taken.add(id);
    for (const id of liveTaken) taken.add(id);
  };

  // Target list (the rail beside the board). Stored as the FULL starred set, including players who
  // have since been drafted — the rail then RENDERS only the ones still available. Filtering rather
  // than deleting is what makes "cleared when he's picked" survive a mis-click on the drafted button:
  // un-mark him and he's back on your list, exactly where he was.
  const TGT_KEY = "hq-draft-2026-targets";
  const targets = new Set(JSON.parse(localStorage.getItem(TGT_KEY) ?? "[]"));
  const saveTargets = () => localStorage.setItem(TGT_KEY, JSON.stringify([...targets]));

  const KNOB_KEY = "hq-draft-2026-knobs";
  const savedKnobs = JSON.parse(localStorage.getItem(KNOB_KEY) ?? "{}");
  const saveKnobs = () => localStorage.setItem(KNOB_KEY, JSON.stringify({ replBasis, draftSlot }));

  let board = null, rows = [];
  let pos = "ALL", view = "board", sort = "bc", hideDrafted = false, hideFlagged = false;
  let replBasis = savedKnobs.replBasis ?? 0;  // 0 = starter basis (default), 1 = rostered (best-FA)
  let draftSlot = savedKnobs.draftSlot ?? null;   // 1..10, or null = unset (rail then hides the snake reads)
  let expandedId = null; // single-row accordion
  // Which secondary sections of the drop-down are revealed. Keyed by SECTION, not by player, so the
  // choice is a board-wide preference that follows you player to player; resets compact on reload.
  const openSect = new Set();
  // Bye weeks covered by the targets still on your list, {week: [names]}. Recomputed once per paint
  // (paintTargets runs first, so the board render behind it always reads fresh data) and shared by
  // the rail and the board's bye column, so the two can never disagree about a stack.
  let tgtByes = {};
  let searchHits = [], searchIdx = -1;   // combobox: current matches and the keyboard-highlighted one

  /* ---------- the value engine (transparent, in one place) ---------- */
  // Replacement (scarcity) line per position; the knob slides between the STARTER line
  // (last weekly starter — default) and the ROSTERED line (last rostered / best free agent).
  // STARTER_RANK is MEASURED, not assumed: data/flex-split.json counts every FLEX slot this
  // league has ever started (1,640 slot-weeks, 2020-25) -> RB 40.1% / WR 57.7% / TE 2.2%,
  // giving effective starters per team of QB 1.00, RB 2.80, WR 3.15, TE 1.04.
  // Rank = round(effective_starters x 10 teams) + 1, the +1 being "the streamer you'd
  // actually start" — the first player past the weekly starter pool. Re-derive with
  // node scripts/measure-flex-split.mjs if the league size or FLEX count ever changes.
  // QB/TE/K/DEF were already correct at 11 (10 starters + 1); RB was 30 and WR 32.
  const STARTER_RANK = { QB: 11, RB: 29, WR: 33, TE: 11, K: 11, DEF: 11 };
  const ROSTERED_RANK = { QB: 13, RB: 46, WR: 47, TE: 13, K: 11, DEF: 11 };
  const replRankFor = (ps, t) => Math.max(1, Math.round(STARTER_RANK[ps] + (ROSTERED_RANK[ps] - STARTER_RANK[ps]) * t));
  // Light playing-time model (Q3): median stays near-full; only documented injury/age move it.
  // The uncertainty BAND (Phase B) carries the risk — this is deliberately gentle.
  const AGE_CLIFF = { RB: 28, WR: 31, TE: 31, QB: 37, K: 99, DEF: 99 };
  const BUDGET = 200, TEAMS = 10, ROSTER_SPOTS = 15;   // auction $ scale (relative; snake uses $ as linear currency)
  const EDGE_TARGET = 4, EDGE_FADE = -4;               // $ edge thresholds for TARGET / FADE (tunable)
  const FADE_ADP = 110, PICK_FADE = -25;               // sub-$1 FADE: market drafts a below-replacement player inside pick ~110 AND ≥25 picks earlier than the board ranks him
  const BC_OUT_SOME = 10, BC_OUT_STRONG = 18;          // us-vs-BC POSITIONAL divergence (calibrated to this board: median gap 7, p85≈18) — notable vs strong outlier
  let replAsset = {}, replRankUsed = {}, ceilAvg = {}, dollarAtRank = [];

  /* ---- snake-draft geometry (for the target rail's "will he last to MY pick?" read) ----
     MEASURED, not assumed: data/raw/draft-meta-2023..25.json are identical — 10 teams, 15 rounds,
     type "snake", reversal_round 0 (this league does NOT run a third-round reversal). Verified
     against data/raw/draft-picks-2025.json, where slot 3 held picks #3, #18, #23, #38, #43: odd
     rounds run slot 1→10, even rounds run 10→1. Re-check draft-meta at renewal if the league ever
     changes size, length, or turns reversal on — the reversal case is deliberately NOT implemented,
     because a silently-wrong pick number here is worse than no number at all. */
  const ROUNDS = 15;
  const pickNoFor = (rd, slot) => (rd - 1) * TEAMS + (rd % 2 ? slot : TEAMS + 1 - slot);
  // My remaining picks from `from` onward (inclusive), in order.
  const myPicksFrom = (from, slot) => {
    const out = [];
    for (let r = 1; r <= ROUNDS; r++) { const n = pickNoFor(r, slot); if (n >= from) out.push(n); }
    return out;
  };
  // How much slack to allow around a pick before calling a player gone or safe. Half a round is a
  // stated RULE OF THUMB about how noisy ADP is in a 10-team league, not a computed probability —
  // the board carries no ADP variance, and Boris Chen's expert rank spread is a different quantity
  // that must not be borrowed as one. The tooltips say so rather than implying precision.
  const ADP_SLACK = Math.round(TEAMS / 2);

  function medianGames(p) {
    if (p.pos === "K" || p.pos === "DEF") return 17;
    const gp = p.availability?.games_played ?? {};
    const yrs = ["2023", "2024", "2025"].map((y) => gp[y]).filter((v) => v != null);
    let g = 17;
    if (yrs.length) g -= (yrs.reduce((s, v) => s + Math.max(0, 17 - v), 0) / yrs.length) * 0.3; // light (old score used 0.6 as a multiplier)
    const st = p.availability?.current_injury_status;
    if (["Out", "IR", "PUP", "Sus", "COV"].includes(st)) g -= 3; else if (st === "Questionable") g -= 0.5;
    const cliff = AGE_CLIFF[p.pos] ?? 99;
    if (p.age && p.age >= cliff) g -= Math.min(2, (p.age - cliff + 1) * 0.5);
    return Math.max(9, Math.min(17, +g.toFixed(1)));
  }

  // ---- ② uncertainty + ③ rec-confidence (Phase B) ----
  // Asset confidence = min(playing-time risk, disagreement). Disagreement folds BOTH expert-internal
  // spread (BC std/range) AND board-vs-consensus outlier-ness (my rank vs BC, in the rec direction).
  // rec-confidence = min(edge strength, asset confidence) — the weaker link governs; a big edge on a
  // shaky read is capped, never trusted. Uses dollarAtRank (set in rank()) for the expert $ band.
  const SEV = { high: 0, some: 1, low: 2, none: 2 };
  const CONF_LABEL = ["Low", "Med", "High"], CONF_DOTS = ["●○○", "●●○", "●●●"];

  /* ---- role stability: the ONE place historical usage touches the model ----
     Usage is EVIDENCE, not value. Sleeper's projection already prices raw target share and age,
     so folding share back into the number would double-count it. What usage legitimately informs
     is how much to TRUST that number: a sustained, established, multi-year role is a safer read
     than a committee body or an unproven one. So it enters confidence() as a third severity
     beside playing-time risk and expert disagreement, folded worst-of — it can widen the band and
     cap a recommendation, but it can never move the asset value or the edge.
     Combined worst-of with the scouting session's qualitative role_stability when that exists;
     falls back to the usage read alone when it doesn't.
     Bars are calibrated to the board's own 2025 distribution (≈median share for WR/TE, ≈p60 touch
     share for RB) so they separate settled roles from unsettled ones instead of capping everyone.
     QB deliberately uses SNAP share, not pass attempts — the question is "is he the starter",
     and an attempts bar would wrongly flag run-first starters like Lamar Jackson (23.2 att/g). */
  const ESTABLISHED = { WR: ["target_share", 0.20, 0.65], TE: ["target_share", 0.17, 0.62], RB: ["touch_share", 0.28, 0.45], QB: [null, null, 0.80] };
  const SCOUT_ROLE = { locked: "none", committee: "some", in_flux: "high" };
  function roleStability(p) {
    const bar = ESTABLISHED[p.pos];
    const scoutRaw = p.scouting_brief?.role_stability;
    const scout = SCOUT_ROLE[scoutRaw] ?? null;
    if (!bar) return scout ? { sev: scout, why: `scouting: role ${scoutRaw}`, source: "scouting" } : null; // K/DEF: no usage, no role read
    const seasons = p.usage?.seasons ?? {};
    const qual = ["2023", "2024", "2025"].filter((y) => seasons[y] && seasons[y].g >= 8);
    let sev, why;
    if (!qual.length) {
      sev = "high"; why = p.rookie ? "no NFL usage yet (rookie) — role unproven" : "no season with 8+ games of usage — role unproven";
    } else {
      const y = qual[qual.length - 1], s = seasons[y];
      const [mk, mmin, smin] = bar;
      const mv = mk ? s[mk] : null, sv = s.snap_share;
      const metOk = mk ? mv != null && mv >= mmin : true;
      const snapOk = sv != null && sv >= smin;
      const fringe = (mk && mv != null && mv < mmin * 0.5) || (sv != null && sv < smin * 0.5);
      const label = mk ? `${mk.replace("_", " ")} ${(mv * 100).toFixed(0)}%` : `snap share ${(sv * 100).toFixed(0)}%`;
      const down = p.usage?.direction?.direction === "down" || p.usage?.trend?.direction === "down";
      if (fringe) { sev = "high"; why = `${y} ${label} — rotational/fringe usage, so the projected role is the shakiest part of the read`; }
      else if (y !== "2025") { sev = "some"; why = `most recent usage is ${y} (no 2025 sample) — role read is stale`; }
      else if (metOk && snapOk && !down) { sev = "none"; why = `established 2025 role (${label}, ${(sv * 100).toFixed(0)}% snaps), trending steady or up`; }
      else if (metOk && snapOk) { sev = "some"; why = `established 2025 role (${label}) but usage is trending DOWN`; }
      else { sev = "some"; why = `2025 ${label}, ${sv == null ? "no snap data" : (sv * 100).toFixed(0) + "% snaps"} — below the settled-role bar (committee / rotational)`; }
    }
    // worst-of with the scouting brief's qualitative read, when it exists
    if (scout && SEV[scout] < SEV[sev]) return { sev: scout, why: `scouting: role ${scoutRaw} (worse than the usage read: ${why})`, source: "scouting" };
    return { sev, why, source: "usage" };
  }

  /* ---- override hook: "revisit his number" ----
     A display flag, never an adjustment. Raised when the context-appropriate trend clearly
     contradicts the projection: this is the DRAFT view, so the multi-year direction leads and
     the within-season trajectory is the secondary lens. Compares the projection's per-game rate
     against last season's ACTUAL per-game production.

     Deliberately ONE-DIRECTIONAL, calibrated against this board (2026-07-22). Falling usage +
     a projection asking for MORE is rare (6 of 248) and genuinely contradictory — the projection
     makes a claim the recent evidence doesn't support. The mirror case (rising usage + a lower
     projection) fired on 35 players — McCaffrey 0.70x, Gibbs 0.84x, Taylor 0.75x, Achane 0.72x,
     McBride 0.76x all at once — because projections regress EVERY career year; that's not a
     contradiction, it's how projections work. Worse, its most extreme hits were backups
     (Charbonnet 0.34x) where the projection correctly prices a bench role and the raw usage read
     is the naive one. A flag that fires on a sixth of the board is wallpaper, so that side is
     off: the markdown usually encodes information the usage history lacks. */
  const REVISIT_UP = 1.15;
  function revisitFlag(p) {
    const ls = p.usage?.last_season, projPpg = p.projection?.ppg;
    if (!ls || ls.g < 8 || !projPpg || !(ls.ppg > 0)) return null;
    const ratio = +(projPpg / ls.ppg).toFixed(2);
    const dir = p.usage?.direction?.direction, tr = p.usage?.trend?.direction;
    if (!(dir === "down" || tr === "down") || ratio < REVISIT_UP) return null;
    const which = dir === "down" ? "multi-year DOWN" : `within-season DOWN (late ${ls.year})`;
    return { ratio, why: `usage is ${which}, yet the 2026 projection asks for ${Math.round((ratio - 1) * 100)}% MORE per game than he actually scored in ${ls.year} (${projPpg}/g projected vs ${ls.ppg}/g actual)` };
  }

  function confidence(p) {
    if (p.assetPts == null) return null;
    const mg = p.medianGames;
    const gp = p.availability?.games_played ?? {};
    const yrs = ["2023", "2024", "2025"].map((y) => gp[y]).filter((v) => v != null);
    const rookie = p.rookie || yrs.length === 0;
    const injuredNow = ["Out", "IR", "PUP", "Sus", "COV"].includes(p.availability?.current_injury_status);
    // playing-time band + risk tier
    let gLow = yrs.length ? Math.min(mg, Math.min(...yrs)) : mg;
    let gHigh = Math.min(17, mg + 1);
    if (injuredNow) gLow -= 3;
    if (rookie) { gLow = mg - 4; gHigh = 17; }
    gLow = Math.max(5, +gLow.toFixed(1));
    const ptRisk = (rookie || injuredNow || mg < 14) ? "high"
      : (mg < 16 || (yrs.length && Math.min(...yrs) < 14)) ? "some" : "none";
    // disagreement: experts among themselves + board-vs-consensus in the rec's direction
    const bc = p.fftiers;
    let dis = "some";
    if (bc) {
      const range = bc.worst_rank - bc.best_rank;
      let d = (bc.std_dev >= 8 || range >= 45) ? "high" : (bc.std_dev >= 4 || range >= 22) ? "some" : "low";
      const g = p.bcGap; // + = we're MORE BEARISH than the experts (POSITIONAL), − = more bullish
      if (g != null) {
        const contra = (p.rec === "FADE" && g >= BC_OUT_SOME) || (p.rec === "TARGET" && -g >= BC_OUT_SOME);
        if (contra) { const o = Math.abs(g) >= BC_OUT_STRONG ? "high" : "some"; if (SEV[o] < SEV[d]) d = o; }
      }
      dis = d;
    }
    // role stability from historical usage (worst-of with the scouting brief) — the third leg
    const role = roleStability(p);
    const assetSev = Math.min(SEV[ptRisk], SEV[dis], role ? SEV[role.sev] : 2);
    const assetConf = assetSev <= 0 ? "Low" : assetSev === 1 ? "Med" : "High";
    // illustrative $ band: PT swing (via games fraction) ⊕ expert-rank $ spread, in quadrature
    const ptHalf = mg > 0 ? (p.draftDollar ?? 0) * ((gHigh - gLow) / 2) / mg : 0;
    const bcHalf = bc ? Math.abs((dollarAtRank[Math.min(dollarAtRank.length, bc.best_rank) - 1] ?? p.draftDollar)
      - (dollarAtRank[Math.min(dollarAtRank.length, bc.worst_rank) - 1] ?? p.draftDollar)) / 2 : 0;
    const half = Math.round(Math.sqrt(ptHalf * ptHalf + bcHalf * bcHalf));
    const bandLow = Math.max(0.05, (p.draftDollar ?? 1) - half), bandHigh = (p.draftDollar ?? 1) + half;
    // rec-confidence (TARGET/FADE only): min(edge strength, asset confidence)
    let recConf = null, capped = null;
    if (p.rec === "TARGET" || p.rec === "FADE") {
      const edgeStrength = p.draftDollar >= 1 ? (Math.abs(p.edgeDollar) >= 10 ? 3 : 2)
        : (Math.abs(p.edgePicks ?? 0) >= 60 ? 3 : 2); // sub-$1 FADE strength from the pick-gap overpay
      const assetLevel = { Low: 1, Med: 2, High: 3 }[assetConf];
      recConf = Math.min(edgeStrength, assetLevel);
      // name the binding constraint — whichever leg actually set assetSev
      if (assetLevel < edgeStrength) {
        const worst = Math.min(SEV[ptRisk], SEV[dis], role ? SEV[role.sev] : 2);
        capped = SEV[ptRisk] === worst ? "playing-time / injury risk"
          : (role && SEV[role.sev] === worst) ? "role stability (usage)"
          : "you're the outlier vs consensus";
      }
    }
    return { assetConf, ptRisk, dis, role, gLow, gHigh, bandLow, bandHigh, recConf, capped, rookie, injuredNow };
  }

  function compute(p) {
    const flags = p.risk_flags ?? {};
    const flagged = ["suspension", "contract", "legal"].filter((k) => flags[k] === true);
    const unvetted = flags.researched === false;
    const mg = medianGames(p);
    const rate = p.projection?.pts != null ? +(p.projection.pts / 17).toFixed(2) : null;   // healthy per-game rate
    const assetPts = rate != null ? Math.max(0, +(rate * mg).toFixed(1)) : null;            // ① asset value, floored at 0
    return { ...p, flagged, unvetted, medianGames: mg, rate, assetPts };
  }

  function rank(list) {
    // ② scarcity: replacement level in ASSET points at the knob-selected rank, per position
    for (const ps of Object.keys(STARTER_RANK)) {
      const s = list.filter((p) => p.pos === ps && p.assetPts != null).sort((a, b) => b.assetPts - a.assetPts);
      const n = replRankFor(ps, replBasis);
      replRankUsed[ps] = n;
      replAsset[ps] = s[Math.min(n, s.length) - 1]?.assetPts ?? 0;
    }
    for (const p of list) p.marginal = p.assetPts == null ? null : Math.max(0, +(p.assetPts - (replAsset[p.pos] ?? 0)).toFixed(1));
    // auction $ normalization over the rosterable pool
    const rosterable = TEAMS * ROSTER_SPOTS;
    const marg = list.filter((p) => p.marginal != null).map((p) => p.marginal).sort((a, b) => b - a).slice(0, rosterable);
    const totalMarginal = marg.reduce((a, b) => a + b, 0) || 1;
    const dollarPerPt = (BUDGET * TEAMS - rosterable) / totalMarginal;
    // draft-$: integer auction PRICE ≥ $1 at/above replacement; a fractional PROXIMITY score
    // (asset ÷ position-replacement, $0.05–0.99) below — differentiates the bench, no $1 wall.
    for (const p of list) {
      if (p.assetPts == null) { p.draftDollar = null; continue; }
      const r = replAsset[p.pos] ?? 0;
      p.draftDollar = p.assetPts >= r
        ? Math.max(1, Math.round(1 + Math.max(0, p.assetPts - r) * dollarPerPt))
        : Math.max(0.05, r > 0 ? +(p.assetPts / r).toFixed(3) : 0.05);
    }
    // draft rank (by $) + per-position rank
    const byDollar = list.filter((p) => p.draftDollar != null).sort((a, b) => b.draftDollar - a.draftDollar);
    byDollar.forEach((p, i) => (p.draftRank = i + 1));
    dollarAtRank = byDollar.map((p) => p.draftDollar);
    const posCount = {};
    for (const p of byDollar) { posCount[p.pos] = (posCount[p.pos] ?? 0) + 1; p.posRank = posCount[p.pos]; }
    // us-vs-BC divergence on a like-for-like POSITIONAL scale. fftiers.rank is an OVERALL
    // cross-positional rank, so ranking WR38-vs-#36-overall is apples-to-oranges; instead compare
    // our $-rank among a position against BC's rank among the SAME position. bcGap = our posRank −
    // BC posRank: + = we're MORE BEARISH than the experts (rank him lower than they do), − = more
    // bullish. This is the "is our number corroborated by consensus, or are we the lone outlier" read.
    for (const ps of Object.keys(STARTER_RANK)) {
      list.filter((p) => p.pos === ps && p.fftiers?.rank != null)
        .sort((a, b) => a.fftiers.rank - b.fftiers.rank)
        .forEach((p, i) => (p.bcPosRank = i + 1));
    }
    for (const p of list) p.bcGap = (p.posRank != null && p.bcPosRank != null) ? p.posRank - p.bcPosRank : null;
    // ③ market edge: your $ vs the $ of the player's ADP slot
    for (const p of list) {
      const adp = p.adp?.half_ppr;
      p.marketDollar = adp != null ? (dollarAtRank[Math.min(dollarAtRank.length, Math.round(adp)) - 1] ?? 1) : null;
      p.edgeDollar = p.marketDollar != null && p.draftDollar != null ? p.draftDollar - p.marketDollar : null;
      p.edgePicks = adp != null && p.draftRank != null ? +(adp - p.draftRank).toFixed(1) : null;
      // BC−ADP: how far the market lets an expert-ranked player fall. +ve = ADP later than BC rank
      // (the market is passing on him relative to the expert consensus → value); −ve = drafted ahead
      // of consensus (a reach). Needs both a BC rank and an ADP; null otherwise.
      p.bcDiff = (p.fftiers?.rank != null && adp != null) ? Math.round(adp - p.fftiers.rank) : null;
      // rec driver switches at the $1 line. Above: $-edge (TARGET/FAIR/FADE). Below: the board is
      // structurally conservative on late-round upside, so NO TARGET — only FADE the real overpays
      // (a below-replacement projection the market spends an early pick on). Ceiling is the late lens.
      p.rec = p.draftDollar == null ? null
        : p.draftDollar >= 1 ? (p.edgeDollar == null ? null : p.edgeDollar >= EDGE_TARGET ? "TARGET" : p.edgeDollar <= EDGE_FADE ? "FADE" : "FAIR")
        : (adp != null && adp <= FADE_ADP && p.edgePicks != null && p.edgePicks <= PICK_FADE ? "FADE" : "FAIR");
      p.conf = confidence(p); // ② band + tier + ③ rec-confidence (needs draftRank + dollarAtRank, both set above)
    }
    // ceiling badge denominator (display only — ceiling is not a value input)
    for (const ps of Object.keys(STARTER_RANK)) {
      const r = list.filter((p) => p.pos === ps && p.ceiling).map((p) => p.ceiling.spike_week_rate);
      ceilAvg[ps] = r.length ? +(r.reduce((a, b) => a + b, 0) / r.length).toFixed(3) : null;
    }
    for (const p of list) p.ceilRatio = (p.ceiling && ceilAvg[p.pos]) ? +(p.ceiling.spike_week_rate / ceilAvg[p.pos]).toFixed(2) : null;
    return list;
  }

  /* ---------- tiers: natural breaks within position by draft $ ---------- */
  function tiersFor(list) {
    const sorted = [...list].filter((p) => p.draftDollar != null).sort((a, b) => b.draftDollar - a.draftDollar);
    const tiers = [];
    let cur = [];
    for (const p of sorted) {
      if (cur.length) {
        const drop = cur[cur.length - 1].draftDollar - p.draftDollar;
        const threshold = Math.max(3, Math.abs(cur[0].draftDollar) * 0.12);
        if (drop > threshold || cur.length >= 12) { tiers.push(cur); cur = []; }
      }
      cur.push(p);
    }
    if (cur.length) tiers.push(cur);
    return tiers;
  }

  /* ---------- render helpers ---------- */
  const noData = '<span class="nodata">no data</span>';
  const badge = (txt, cls, title) => `<span class="rbadge ${cls}" title="${esc(title)}">${esc(txt)}</span>`;
  // Per-tier color for Boris Chen's tiers (overall, 1..~23). It does three jobs: a full-row wash so
  // a tier reads as one block, a bold left band, and the pill in the BC cell.
  //
  // Hue steps by the GOLDEN ANGLE (137.5°), not a small fixed step. Consecutive tiers land on
  // opposite sides of the wheel, so neighbours can never be confused, and no two hues come close
  // again for many tiers. The old 47° step was the problem: neighbours sat a shade apart and the
  // sequence wrapped to a near-repeat every 8 tiers, which is what read as mush.
  //
  // Lightness does two jobs. It's compensated per hue — an HSL blue looks far darker than an HSL
  // yellow at the same L — so blue-ish tiers get pushed up and yellow-ish ones down; without it the
  // wash strength swings visibly tier to tier and the "same weight, different color" read breaks.
  // Then a period-3 step rides on top: 8 golden-angle turns land only ~20° from where they started,
  // so hue alone still near-repeats every 8 tiers, and a 3-cycle against that 8-cycle pushes a true
  // repeat out to 24 tiers — past the end of the board. It also gives every neighbour a second axis
  // of difference, which is what keeps the blocks apart for a red/green-colorblind reader.
  // Starts on green (tier 1 = best, on-brand).
  const tierColor = (t) => {
    const h = (150 + (t - 1) * 137.5) % 360;
    const l = 58 + 10 * Math.cos(((h - 240) * Math.PI) / 180)    // ~48% at yellow, ~68% at blue
      + [0, -9, 9][t % 3];
    return {
      wash: `hsl(${h} 46% ${l}% / 0.17)`,                        // whole-row background
      hover: `hsl(${h} 52% ${l}% / 0.28)`,
      stripe: `hsl(${h} 62% ${l}% / 0.95)`,                      // 5px left band
      edge: `hsl(${h} 62% ${l}% / 0.55)`,                        // rule capping a tier block
      text: `hsl(${h} 60% ${Math.min(l + 16, 80)}%)`,
      bg: `hsl(${h} 50% ${l}% / 0.26)`,                          // pill, sits on top of the wash
    };
  };
  const edgeStr = (e) => { if (e == null) return "–"; const r = Math.round(e); return r === 0 ? "$0" : (r > 0 ? "+$" : "−$") + Math.abs(r); }; // round: a boundary player's sub-dollar market gap reads $0 (fair), not "+$0.04"
  const fmtD = (d) => d == null ? "–" : d >= 1 ? `$${d}` : `$${d.toFixed(2)}`;   // ≥$1 = integer price; <$1 = proximity score

  // The full-row tier wash is a GROUPING device, so it only earns its place where the tiers are
  // contiguous: the BC sort on the value board. The tiers view groups by our own draft-$ tiers, so
  // Boris Chen's tiers interleave inside every block there too.
  const washOn = () => view === "board" && sort === "bc";

  // Which rows open a Boris Chen tier block. A capping rule only earns its keep where the tier
  // genuinely reads as a block, so a row qualifies on two local counts: it opens a run of 2+
  // consecutive rows in the same tier, AND that tier has not appeared earlier in the list.
  //
  // Both tests are local, which is what makes this survive the real data. Under the BC sort tiers
  // 1–19 come out perfectly contiguous and each gets its rule, while the tail interleaves (K and
  // DEF carry their own tier scales and land among the deep skill players) and correctly gets none
  // — a single global "is this list tier-ordered?" test would have thrown away all 19 clean rules
  // to punish that tail. Under a non-tier sort almost every run is length 1, so the rules vanish.
  function tierStarts(list) {
    const flags = new Array(list.length).fill(false);
    const tierOf = (p) => p?.fftiers?.tier ?? null;
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const t = tierOf(list[i]);
      if (t == null) continue;
      // i > 0: the first row already sits against the column header's own border.
      if (i > 0 && tierOf(list[i - 1]) !== t && tierOf(list[i + 1]) === t && !seen.has(t)) flags[i] = true;
      seen.add(t);
    }
    return flags;
  }

  function rowHTML(p, rankLabel, tierStart) {
    const isTaken = taken.has(p.id);
    const isLive = liveTaken.has(p.id);   // came from Sleeper, not from a click — button is inert
    const isTgt = targets.has(p.id);
    const isOpen = expandedId === p.id;
    const rec = p.rec, conf = p.conf, adp = p.adp?.half_ppr;
    const sub = p.draftDollar != null && p.draftDollar < 1;          // below the $1 line = proximity/bench tier
    const recCls = rec === "TARGET" ? "rec-target" : rec === "FADE" ? "rec-fade" : rec === "FAIR" ? "rec-fair" : "";
    // Name color = agreement between the experts (BC−ADP) and our model (edge): blue only when BOTH
    // are positive (undervalued by the market on both reads), red only when BOTH are negative,
    // white on any disagreement or missing value. Uses the SAME rounded signs the two columns show
    // (edge is $-edge above $1, the pick-gap below), so the name matches what those cells display.
    const edgeShown = sub ? (p.edgePicks == null ? null : Math.round(p.edgePicks))
                          : (p.edgeDollar == null ? null : Math.round(p.edgeDollar));
    const bcShown = p.bcDiff; // integer (ADP − BC rank) or null
    const nameCls = (bcShown > 0 && edgeShown > 0) ? "name-value"
      : (bcShown < 0 && edgeShown < 0) ? "name-reach" : "";
    const showRec = rec === "TARGET" || rec === "FADE" || (rec === "FAIR" && !sub); // suppress the FAIR badge in the bench tier
    const edgeCls = rec === "TARGET" ? "gap-value" : rec === "FADE" ? "gap-reach" : "gap-fair";
    // edge column: $-edge above $1; the board-vs-ADP pick-gap (disparity) below
    const edgeTxt = sub ? (p.edgePicks == null ? "–" : `${p.edgePicks > 0 ? "+" : ""}${Math.round(p.edgePicks)}p`) : edgeStr(p.edgeDollar);
    const edgeTitle = p.edgeDollar == null ? "no ADP to compare"
      : sub ? `Board ranks him #${p.draftRank}; market ADP ${adp} → the market is ${Math.abs(Math.round(p.edgePicks))} picks ${p.edgePicks < 0 ? "HIGHER" : "lower"} on him. A projection-based board is conservative on late-round upside — check ceiling before acting.${rec === "FADE" ? ` FADE: the market spends an early pick (≤${FADE_ADP}) on a below-replacement projection.` : ""}`
      : `You value him ${fmtD(p.draftDollar)}; the market's ADP slot (pick ${adp}) is worth ${fmtD(p.marketDollar)} → ${p.edgeDollar > 0 ? "UNDER" : p.edgeDollar < 0 ? "OVER" : "fairly"}valued by ${edgeStr(p.edgeDollar)} (${p.edgePicks > 0 ? "+" : ""}${Math.round(p.edgePicks)} picks)${conf?.recConf ? ` · rec-confidence ${CONF_LABEL[conf.recConf - 1]}${conf.capped ? ` (capped: ${conf.capped})` : ""}` : ""}`;
    const bc = p.fftiers;
    const tc = bc ? tierColor(bc.tier) : null;
    const bcTxt = bc ? `${bc.rank}<span class="bctier" style="color:${tc.text};background:${tc.bg}">T${bc.tier}</span>` : "–";
    const bcTitle = bc ? `Boris Chen half-PPR consensus (your primary board): overall #${bc.rank}, tier ${bc.tier} (avg ${bc.avg_rank}, range ${bc.best_rank}-${bc.worst_rank})` : "not in fftiers top-200";
    // BC vs ADP: where the experts rank him vs where the market drafts him
    const bcd = p.bcDiff;
    const bcdCls = bcd == null ? "" : bcd > 0 ? "name-value" : bcd < 0 ? "name-reach" : "gap-fair";
    const bcdTxt = bcd == null ? "–" : bcd > 0 ? `+${bcd}` : bcd < 0 ? `−${Math.abs(bcd)}` : "0";
    const bcdTitle = bcd == null ? "needs both a Boris Chen rank and an ADP"
      : `Experts (BC) rank him #${bc.rank}; the market drafts him at ADP ${adp}. ${bcd > 0 ? `The market lets him fall ${bcd} spots past the expert consensus — a value.` : bcd < 0 ? `He goes ${Math.abs(bcd)} picks ahead of where experts rank him — a reach vs consensus.` : "Right where experts rank him."}`;
    // us vs experts (BC), positional — corroborated or lone outlier
    const g = p.bcGap, ga = g == null ? null : Math.abs(g);
    const gCls = ga == null || ga < BC_OUT_SOME ? "" : ga >= BC_OUT_STRONG ? "bc-out-strong" : "bc-out";
    const gTxt = g == null ? "–" : ga <= 7 ? "≈" : (g > 0 ? "▼" : "▲") + ga;
    const gTitle = g == null ? "no Boris Chen rank — no consensus comparison"
      : `You rank him ${esc(p.pos)}${p.posRank}; Boris Chen consensus ${esc(p.pos)}${p.bcPosRank} → you're ${ga} spot${ga === 1 ? "" : "s"} ${g > 0 ? "LOWER (more bearish)" : g < 0 ? "HIGHER (more bullish)" : "even"} than the experts. ${ga < BC_OUT_SOME ? "In line with consensus." : g > 0 ? (rec === "FADE" ? "CONTRARIAN fade — the crowd rates him higher than your value does; trust it only if you back the cold projection over the consensus." : "Your board sits below consensus here.") : (rec === "TARGET" ? "CONTRARIAN target — you rate him higher than the experts do." : "Your board sits above consensus here.")}`;
    // bye: a roster-construction attribute, not a value read, so it sits at the tail of the cluster
    // rather than ahead of BC.
    //
    // It carries NO COLOR, unlike the rail's version, and that's measured rather than assumed. A
    // collision highlight was built and rejected: bye week is a property of the TEAM, so "two targets
    // already off this week" is true of every player on the 2-6 teams sharing it — with two week-11
    // targets starred it lit 44 of 248 rows. That's the same wallpaper bar the revisit flag was cut
    // against (see REVISIT_UP above). The rail keeps its amber because there it's 2 rows out of ~8,
    // where a shared week is genuinely the exception. Here the read lives in the tooltip, which
    // costs nothing on a row you aren't pointing at.
    const byeShare = p.bye == null ? [] : (tgtByes[p.bye] ?? []).filter((n) => n !== p.name);
    const byeTitle = p.bye == null ? "No bye week on file for this player."
      : byeShare.length === 0 ? `Week ${p.bye} bye. Nobody on your target list is off that week.`
      : byeShare.length === 1 ? `Week ${p.bye} bye, the same week as ${byeShare[0]} on your target list.`
      : `Week ${p.bye} bye, and ${byeShare.length} players already on your target list are off that week (${byeShare.join(", ")}). Adding him makes ${byeShare.length + 1} holes to cover at once.`;
    const cl = p.ceiling, clr = p.ceilRatio;
    const clCls = clr == null ? "" : clr >= 1.5 ? "ceil-boom" : clr <= 0.6 ? "ceil-steady" : "";
    const clArrow = clr == null ? "" : clr >= 1.5 ? "▲" : clr <= 0.6 ? "▾" : "";
    const clTxt = cl ? `${Math.round(cl.spike_week_rate * 100)}%${clArrow}` : "–";
    const clTitle = cl ? `Spike-week rate: ${Math.round(cl.spike_week_rate * 100)}% of ${cl.sample_weeks} games at/above the ${p.pos} top-5 weekly line (${cl.boom_line} pts). Boom ~${cl.boom_pts}, floor ~${cl.floor_pts}${clr != null ? `; ${clr}× the board's ${p.pos} average` : ""}. Separate attribute — not in value.` : "no weekly ceiling data (rookie / <10 career games)";
    const badges = [
      showRec ? `<span class="recbadge ${recCls}" title="${esc(edgeTitle)}">${rec}${conf?.recConf ? ` <span class="confdots" title="rec-confidence ${CONF_LABEL[conf.recConf - 1]}">${CONF_DOTS[conf.recConf - 1]}</span>` : ""}</span>` : "",
      ...p.flagged.map((f) => badge(f.slice(0, 3).toUpperCase(), "rbadge-risk", `${f} risk — see detail`)),
      p.unvetted ? badge("unvetted", "rbadge-unvetted", "Risk flags not yet researched — null, not clean") : "",
      p.scouting_brief?.prose ? `<span class="rbadge rbadge-scout${p.scouting_brief.override_flag ? " scout-override" : ""}" title="${esc((p.scouting_brief.override_flag ? "⚑ role/scheme delta — revisit projection. " : "") + firstSentence(p.scouting_brief.prose))}">${p.scouting_brief.override_flag ? "⚑ scout" : "scout"}</span>` : "",
    ].join("");
    // Tier identity rides on custom properties so the CSS owns where each one lands (row wash,
    // left band, hover, block rule) and a player with no fftiers rank simply falls back transparent.
    // The full-row wash is emitted ONLY where the tiers are actually contiguous — the BC sort on the
    // value board. Everywhere else the tiers interleave, and a wash there is confetti rather than
    // grouping; the left band and the T-pill still carry each row's tier in every sort and view.
    const tierStyle = tc
      ? ` style="${washOn() ? `--tier-wash:${tc.wash};--tier-hover:${tc.hover};` : ""}--tier-stripe:${tc.stripe};--tier-edge:${tc.edge}"`
      : "";
    return `
    <div class="drow ${isTaken ? "taken" : ""}${tierStart ? " tier-start" : ""}" data-id="${p.id}"${tierStyle}>
      <button class="take${isLive ? " take-live" : ""}" data-act="take" aria-pressed="${isTaken}" ${isLive ? 'aria-disabled="true" ' : ""}title="${isLive ? `Drafted at pick #${esc(livePickNo.get(p.id) ?? "?")} — from the live Sleeper feed, so this can't be un-marked here` : isTaken ? "Mark available" : "Mark drafted"}">${isTaken ? "✓" : ""}</button>
      <button class="star${isTgt ? " on" : ""}" data-act="star" aria-pressed="${isTgt}" title="${isTgt ? "Remove from target list" : "Add to target list"}">${isTgt ? "★" : "☆"}</button>
      <button class="dmain" data-act="expand" aria-expanded="${isOpen}">
        <span class="dr">${rankLabel}</span>
        <span class="dname ${nameCls}">${esc(p.name)}</span>
        <span class="dpos">${esc(p.pos)}${p.posRank ? p.posRank : ""} · ${esc(p.team)}</span>
        ${badges}
        <span class="dbc mono" title="${esc(bcTitle)}">${bcTxt}</span>
        <span class="dbcdiff mono ${bcdCls}" title="${esc(bcdTitle)}">${bcdTxt}</span>
        <span class="dadp mono" title="ADP (half-PPR)">${p.adp?.half_ppr ?? "–"}</span>
        <span class="dval mono" title="${sub ? "proximity-to-rosterable score (below the $1 startable line — a differentiation score, not a price)" : "league-contextualized draft value — scarcity-aware auction $ in this league's format"}">${fmtD(p.draftDollar)}</span>
        <span class="dgap mono ${edgeCls}" title="${esc(edgeTitle)}">${edgeTxt}</span>
        <span class="dbcgap mono ${gCls}" title="${esc(gTitle)}">${gTxt}</span>
        <span class="dceil mono ${clCls}" title="${esc(clTitle)}">${clTxt}</span>
        <span class="dbye mono" title="${esc(byeTitle)}">${p.bye ?? "–"}</span>
      </button>
      ${isOpen ? detailHTML(p) : ""}
    </div>`;
  }

  // Full, transparent decomposition — asset → scarcity → draft-$ → market-$ → edge → rec. No black box.
  function edgeExplainer(p) {
    if (p.assetPts == null) return `<div class="gapexp"><b>No value:</b> no projection for this player (shows ${noData}).</div>`;
    const replRank = replRankUsed[p.pos], repl = replAsset[p.pos], adp = p.adp?.half_ppr, rec = p.rec, cf = p.conf;
    const sub = p.draftDollar != null && p.draftDollar < 1;
    const ceilTxt = p.ceiling ? `${Math.round(p.ceiling.spike_week_rate * 100)}% spike rate` : "no ceiling data";
    let verdict, chain;
    if (sub) {
      // below the $1 line: proximity score + the board-vs-ADP disparity as info; ceiling is the lens.
      chain = `<div class="gapchain">
        <span>rate <b>${p.rate}</b>/g × <b>${p.medianGames}</b> median games = <b>${p.assetPts}</b> asset pts</span>
        <span>÷ free ${esc(p.pos)}${replRank} @ ${repl} = <b>${fmtD(p.draftDollar)}</b> <span class="faint">(proximity to the startable line — a differentiation score below $1, not a price)</span></span>
        <span>disparity: <b>board #${p.draftRank}</b> vs <b>ADP ${adp ?? "–"}</b>${p.edgePicks != null ? ` → market ${Math.abs(Math.round(p.edgePicks))} picks ${p.edgePicks < 0 ? "higher" : "lower"}` : ""}</span>
      </div>`;
      if (adp == null) verdict = `<b>Undrafted flier:</b> no ADP — a pure dart. Lean on ceiling (<b>${ceilTxt}</b>) for the upside read.`;
      else if (rec === "FADE") verdict = `<b class="name-reach">FADE:</b> the market spends an early pick (ADP ${adp}, ≤${FADE_ADP}) on a player your projection has below replacement. Unless you're buying upside the projection can't see (ceiling <b>${ceilTxt}</b>), let it go.`;
      else verdict = `<b>Bench tier:</b> a differentiated late dart. A projection-based board is conservative on late-round upside, so there's no "TARGET" here — <b>ceiling is your lens</b> (${ceilTxt}).`;
    } else {
      chain = `<div class="gapchain">
        <span>rate <b>${p.rate}</b>/g × <b>${p.medianGames}</b> median games = <b>${p.assetPts}</b> asset pts <span class="faint">(what he produces, ≥ 0)</span></span>
        <span>− free ${esc(p.pos)}${replRank} @ ${repl} asset pts = <b>${p.marginal}</b> over replacement <span class="faint">(scarcity)</span></span>
        <span>→ <b>${fmtD(p.draftDollar)}</b> draft value <span class="faint">(auction $)</span></span>
        <span>vs market <b>${fmtD(p.marketDollar)}</b> at ADP ${adp ?? "–"} → edge <b>${edgeStr(p.edgeDollar)}</b></span>
      </div>`;
      if (p.edgeDollar == null) verdict = `<b>No market comparison:</b> no ADP for this player.`;
      else if (rec === "TARGET") verdict = `<b class="name-value">TARGET (${edgeStr(p.edgeDollar)}):</b> you value him <b>${fmtD(p.draftDollar)}</b>, but his ADP slot (pick <b>${adp}</b>) costs only <b>${fmtD(p.marketDollar)}</b> — undervalued by <b>${edgeStr(p.edgeDollar)}</b> (~${Math.round(p.edgePicks)} picks late). Good value at cost.`;
      else if (rec === "FADE") verdict = `<b class="name-reach">FADE (${edgeStr(p.edgeDollar)}):</b> the market pays <b>${fmtD(p.marketDollar)}</b> at his ADP (pick <b>${adp}</b>), but you value him only <b>${fmtD(p.draftDollar)}</b> — overvalued. Let someone else pay up.`;
      else verdict = `<b>FAIR:</b> your value <b>${fmtD(p.draftDollar)}</b> ≈ his ADP-slot cost <b>${fmtD(p.marketDollar)}</b> (pick ${adp}) — priced about right.`;
    }
    const caution = cf?.recConf
      ? `<div class="gapdriver"><b>Rec-confidence: ${CONF_LABEL[cf.recConf - 1]}</b> <span class="confdots">${CONF_DOTS[cf.recConf - 1]}</span> = min(edge, asset trust) — asset confidence <b>${cf.assetConf}</b>${cf.capped ? ` <b>(capped by ${cf.capped})</b>` : ""}. Value band <b>${fmtD(cf.bandLow)}–${fmtD(cf.bandHigh)}</b>; drivers: playing-time risk <b>${cf.ptRisk}</b> (${cf.gLow}–${cf.gHigh} games), disagreement <b>${cf.dis}</b>.</div>`
      : cf ? `<div class="gapdriver faint">${sub ? "Bench dart" : "FAIR"} — asset confidence ${cf.assetConf}, band ${fmtD(cf.bandLow)}–${fmtD(cf.bandHigh)}.</div>` : "";
    return `<div class="gapexp">
      <b>How this value is built:</b>
      ${chain}
      <div class="gapverdict">${verdict}</div>
      ${caution}
    </div>`;
  }

  // Scouting brief (evidence layer): what the world says + scheme fit. Descriptive only — NEVER
  // moves value/edge. role_stability feeds the valuation side's confidence band (via the data);
  // scheme_fit + override_flag are the human "revisit his number" trigger.
  const firstSentence = (s) => String(s ?? "").split(/(?<=[.!?])\s/)[0];
  function scoutHTML(p) {
    const s = p.scouting_brief;
    if (!s || !s.prose) return `<div class="dscout dscout-null"><b>Scouting</b> <span class="nodata">not scouted yet</span> <span class="faint">— evidence layer (analyst/coach/player sentiment + scheme fit) pending</span></div>`;
    const stale = s.as_of && (p.situation?.facts ?? []).some((f) => f.date > s.as_of);
    const fitCls = s.scheme_fit === "plus" ? "fit-plus" : s.scheme_fit === "minus" ? "fit-minus" : "";
    const chips = [
      s.role_stability ? `<span class="scout-chip role-${esc(s.role_stability)}">role: ${esc(s.role_stability.replace("_", " "))}</span>` : "",
      s.scheme_fit ? `<span class="scout-chip ${fitCls}">scheme fit: ${esc(s.scheme_fit)}</span>` : "",
    ].join(" ");
    const flags = [
      s.override_flag ? `<span class="scout-flag override" title="Scouting flags a role/scheme delta the projection likely hasn't caught — revisit his number">⚑ revisit projection</span>` : "",
      stale ? `<span class="scout-flag stale" title="nfl-events carries news dated after this brief — re-scout">⚠ fresh news since brief</span>` : "",
    ].join("");
    const srcs = (s.sources ?? []).map((src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener" title="${esc([src.type, src.date].filter(Boolean).join(" · "))}">${esc(src.label)}</a>`).join(" · ");
    return `<div class="dscout">
      <div class="scout-head"><b>Scouting</b> <span class="faint">— what the world says · as of ${esc(s.as_of ?? "?")}</span> ${flags}</div>
      <div class="scout-prose">${esc(s.prose)}</div>
      <div class="scout-meta">${chips}${srcs ? ` · <span class="faint">sources:</span> ${srcs}` : ""}</div>
    </div>`;
  }

  /* ---- historical usage panel (replaces the old placeholder context strip) ----
     Three time-scales, per the design: the recent season's share/efficiency, the multi-year
     DIRECTION, and last season's within-season trajectory. The draft view leads with the
     multi-year read (you're betting a whole season); the within-season lens sits below it
     (a strong finish is the sophomore-breakout signal). Waivers invert that in-season.
     Every arrow is sample-gated upstream — where a trend isn't earned, the build emits a
     reason and this renders "steady" or an honest no-data, never a fabricated arrow. */
  const ARROW = { up: "▲", down: "▾", steady: "→" };
  const pctS = (v) => v == null ? "–" : `${(v * 100).toFixed(0)}%`;
  const dirClass = (d) => d === "up" ? "trend-up" : d === "down" ? "trend-down" : "trend-flat";
  const STAT_ROWS = {
    WR: [["target_share", "target share", pctS], ["snap_share", "snap share", pctS], ["catch_rate", "catch rate", pctS],
         ["rz_tgt_share", "RZ tgt share", pctS], ["adot", "aDOT", (v) => v == null ? "–" : `${v} yd`], ["tgt_pg", "targets/g", (v) => v ?? "–"]],
    RB: [["touch_share", "touch share", pctS], ["snap_share", "snap share", pctS], ["touch_pg", "touches/g", (v) => v ?? "–"],
         ["rush_att_pg", "rush att/g", (v) => v ?? "–"], ["tgt_pg", "targets/g", (v) => v ?? "–"], ["rush_rz_att", "RZ carries", (v) => v ?? "–"]],
    QB: [["snap_share", "snap share", pctS], ["pass_att_pg", "pass att/g", (v) => v ?? "–"],
         ["rush_att_pg", "rush att/g", (v) => v ?? "–"], ["rush_yd", "rush yds", (v) => v ?? "–"]],
  };
  STAT_ROWS.TE = STAT_ROWS.WR;

  function statsHTML(p) {
    const u = p.usage;
    // No usage → no trends column to render. The remaining block spans the vacated track so the
    // row doesn't sit with an empty third (dstats-wide, guarded to wide viewports only).
    if (!STAT_ROWS[p.pos]) return `<div class="dcol dstats dstats-wide"><span class="ctxlabel">Historical usage</span>
      <div class="statnone">${noData} — ${esc(p.pos)} has no usage profile (this position is scored on team/kicking events, not snaps or targets).</div></div>`;
    if (!u || !Object.keys(u.seasons ?? {}).length) return `<div class="dcol dstats dstats-wide"><span class="ctxlabel">Historical usage</span>
      <div class="statnone">${noData} — ${p.rookie ? "rookie: no NFL usage history exists yet" : "no NFL usage on file for 2023–25"}. Role stability is treated as <b>unproven</b>, which widens the confidence band.</div></div>`;
    const yrs = ["2023", "2024", "2025"].filter((y) => u.seasons[y]);
    const rows = STAT_ROWS[p.pos];
    const head = `<tr><th>metric</th>${yrs.map((y) => `<th>${y}</th>`).join("")}</tr>`;
    const body = rows.map(([k, lab, fmt]) => {
      if (yrs.every((y) => u.seasons[y][k] == null)) return "";
      return `<tr><td class="statlab">${lab}</td>${yrs.map((y) => `<td class="mono">${u.seasons[y][k] == null ? '<span class="nodata">–</span>' : fmt(u.seasons[y][k])}</td>`).join("")}</tr>`;
    }).join("");
    const sample = `<tr class="statsample"><td class="statlab">games <span class="faint">(share sample)</span></td>${yrs.map((y) => `<td class="mono">${u.seasons[y].g}${u.seasons[y].share_g !== u.seasons[y].g ? ` <span class="faint">(${u.seasons[y].share_g})</span>` : ""}</td>`).join("")}</tr>`;

    const d = u.direction;
    const dirTxt = !d ? `<span class="nodata">no direction metric for this position</span>`
      : d.direction == null ? `<span class="nodata">not claimed</span> <span class="faint">— ${esc(d.reason ?? "")}</span>`
      : `<span class="${dirClass(d.direction)}">${ARROW[d.direction]} ${d.direction}</span> <span class="faint">— ${esc(d.metric.replace("_", " "))} ${d.metric.includes("share") ? pctS(d.from.value) + " → " + pctS(d.to.value) : d.from.value + " → " + d.to.value} (${d.from.year} → ${d.to.year}, ${d.from.g}/${d.to.g} games)${p.age ? `, age ${p.age}` : ""}</span>`;

    const t = u.trend;
    const trTxt = !t ? `<span class="nodata">no trend metric for this position</span>`
      : t.direction == null ? `<span class="nodata">not claimed</span> <span class="faint">— ${esc(t.reason ?? "")}</span>`
      : `<span class="${dirClass(t.direction)}">${ARROW[t.direction]} ${t.direction}</span> <span class="faint">— ${esc(t.metric.replace("_pg", "/g").replace("_", " "))} ${t.first.per_game} (wks ${esc(t.first.weeks)}) → ${t.last.per_game} (wks ${esc(t.last.weeks)}), Δ${t.delta > 0 ? "+" : ""}${t.delta}; gate ${esc(t.gate)}</span>`;
    const cr = t?.catch_rate;
    const crTxt = !cr ? "" : cr.direction == null
      ? `<div class="statline faint">catch rate: <span class="nodata">not claimed</span> — ${esc(cr.reason ?? "")}</div>`
      : `<div class="statline">catch rate: <span class="${dirClass(cr.direction)}">${ARROW[cr.direction]} ${cr.direction}</span> <span class="faint">${pctS(cr.first)} → ${pctS(cr.last)}</span></div>`;

    const rv = revisitFlag(p);
    const ls = u.last_season;
    const role = p.conf?.role;
    // TWO sibling columns: the season table, then the trend reads beside it. The full
    // "never moves value" reasoning moves to the label's tooltip — it's identical boilerplate on
    // every player, and spelling it out cost ~5 lines of height in a now-narrower column.
    const why = "Evidence + a role-stability input to confidence. Never moves the value or the edge: the projection already prices raw share and age, so counting it twice would be double-dipping.";
    return `<div class="dcol dstats">
      <span class="ctxlabel" title="${esc(why)}">Historical usage <span class="faint">— evidence only</span></span>
      <table class="stattable">${head}${body}${sample}</table>
    </div>
    <div class="dcol dstats dtrends">
      <span class="ctxlabel" title="${esc(why)}">Trends <span class="faint">— sample-gated</span></span>
      ${rv ? `<div class="statrevisit" title="A flag for you, not an adjustment — nothing in the value changed">⚑ revisit his number — ${esc(rv.why)}</div>` : ""}
      <div class="statline"><b>Multi-year</b> <span class="faint">(the season bet — leads on draft day)</span>: ${dirTxt}</div>
      <div class="statline"><b>Within-season ${ls?.year ?? "2025"}</b> <span class="faint">(last 4 games vs first 4)</span>: ${trTxt}</div>
      ${crTxt}
      ${ls ? `<div class="statline faint">${ls.year} actual, this league's scoring: <b>${ls.pts}</b> pts in ${ls.g} games = <b>${ls.ppg}</b>/g · 2026 projection <b>${p.projection?.ppg ?? "–"}</b>/g</div>` : ""}
      ${role ? `<div class="statline faint">Role stability → <b>${esc(role.sev === "none" ? "stable" : role.sev === "some" ? "some risk" : "high risk")}</b> (${esc(role.source)}): ${esc(role.why)}</div>` : ""}
    </div>`;
  }

  // Boris Chen block — a PRIORITY section (the board's primary source), so it stands on its own
  // column rather than sharing one with the $-engine internals.
  function bcHTML(p) {
    if (!p.fftiers) return `<div class="dcol">
      <h4>Boris Chen (fftiers)</h4>
      <div>${noData} — not in Boris Chen's top-200 (free agent or deep)</div>
    </div>`;
    const g = p.bcGap, ga = g == null ? null : Math.abs(g);
    const vs = g == null ? "–" : g === 0 ? "even with consensus"
      : `you're <b class="${ga >= BC_OUT_SOME ? "bc-out" : ""}">${ga} ${g > 0 ? "LOWER (more bearish)" : "HIGHER (more bullish)"}</b>`;
    const note = g != null && ga >= BC_OUT_SOME
      ? ` <span class="faint">— ${g > 0 ? (p.rec === "FADE" ? "contrarian fade, not corroborated by consensus — back it only if you trust the projection over the crowd" : "your board is below the crowd here") : (p.rec === "TARGET" ? "contrarian target — you're ahead of consensus" : "your board is above the crowd here")}</span>` : "";
    return `<div class="dcol">
      <h4>Boris Chen (fftiers) <span class="faint">— your primary board</span></h4>
      <div><b>consensus rank:</b> #${p.fftiers.rank} · tier ${p.fftiers.tier}</div>
      <div><b>expert avg:</b> ${p.fftiers.avg_rank} <span class="faint">(range ${p.fftiers.best_rank}–${p.fftiers.worst_rank}, std ${p.fftiers.std_dev})</span></div>
      <div><b>vs your board:</b> experts ${esc(p.pos)}${p.bcPosRank ?? "–"} · you ${esc(p.pos)}${p.posRank ?? "–"} → ${vs}${note}</div>
      <div class="faint">FantasyPros consensus, GMM tiers, half-PPR · as of ${esc(board.fftiers?.updated ?? "?")}</div>
    </div>`;
  }

  // Disclosure wrapper for the SECONDARY sections. Collapsed buttons sit in one compact row; the
  // opened one spans full width beneath them. State lives in openSect (board-wide, see above), so a
  // repaint — take, sort, filter — never snaps a section you opened back shut.
  function section(key, label, bodyHTML) {
    const isOpen = openSect.has(key);
    return `<div class="dsect${isOpen ? " open" : ""}">
      <button class="dsect-btn" data-act="sect" data-sect="${key}" aria-expanded="${isOpen}">
        <span class="dsect-caret" aria-hidden="true">${isOpen ? "▾" : "▸"}</span>${esc(label)}
      </button>
      ${isOpen ? `<div class="dsect-body">${bodyHTML}</div>` : ""}
    </div>`;
  }

  function detailHTML(p) {
    const a = p.availability ?? {};
    const gp = a.games_played ?? {};
    const facts = p.situation?.facts ?? [];
    const notes = p.risk_flags?.notes ?? [];
    // PRIORITY (always visible): why-here → scouting → historical usage w/ trends → Boris Chen.
    // Everything else is one click away; the drop-down opens scannable instead of overwhelming.
    return `<div class="ddetail">
      ${p.adp_commentary ? `<div class="dcommentary"><b>Why here at ${esc(p.pos)}:</b> ${esc(p.adp_commentary)}</div>` : ""}
      ${scoutHTML(p)}
      ${statsHTML(p)}
      ${bcHTML(p)}
      <div class="dsects">
        ${section("value", "Value & $ engine", `
          <div><b>Sleeper proj:</b> ${p.projection?.pts ?? "–"} pts <span class="faint">(full-health season)</span></div>
          <div><b>asset:</b> ${p.rate ?? "–"}/g rate × ${p.medianGames} median games = <b>${p.assetPts ?? "–"}</b> pts</div>
          <div><b>draft value:</b> <b>${fmtD(p.draftDollar)}</b> <span class="faint">${p.draftDollar != null && p.draftDollar < 1 ? "(proximity score — below the $1 startable line)" : `(${p.marginal ?? "–"} over free ${esc(p.pos)}${replRankUsed[p.pos] ?? "?"} @ ${replAsset[p.pos] ?? "?"})`}</span></div>
          <div><b>market:</b> ${fmtD(p.marketDollar)} at ADP ${p.adp?.half_ppr ?? "–"} → <b>edge ${p.draftDollar != null && p.draftDollar < 1 ? (p.edgePicks == null ? "–" : (p.edgePicks > 0 ? "+" : "") + Math.round(p.edgePicks) + "p") : edgeStr(p.edgeDollar)}</b> (${p.edgePicks == null ? "–" : (p.edgePicks > 0 ? "+" : "") + Math.round(p.edgePicks) + " picks"})</div>
          <div><b>recommendation:</b> <b class="${p.rec === "TARGET" ? "name-value" : p.rec === "FADE" ? "name-reach" : ""}">${p.rec ?? "–"}</b>${p.conf?.recConf ? ` · confidence ${CONF_LABEL[p.conf.recConf - 1]} <span class="confdots">${CONF_DOTS[p.conf.recConf - 1]}</span>${p.conf.capped ? ` <span class="faint">(capped: ${p.conf.capped})</span>` : ""}` : ""}</div>
          <div><b>asset confidence:</b> ${p.conf?.assetConf ?? "–"} <span class="faint">= worst of three legs · playing-time risk <b>${p.conf?.ptRisk ?? "–"}</b> (${p.conf?.gLow ?? "–"}–${p.conf?.gHigh ?? "–"} games) · disagreement <b>${p.conf?.dis ?? "–"}</b> · role stability <b>${p.conf?.role?.sev ?? "n/a"}</b> · band ${fmtD(p.conf?.bandLow)}–${fmtD(p.conf?.bandHigh)}</span></div>`)}
        ${section("ceiling", "Ceiling (spike weeks)", p.ceiling
          ? `<div><b>spike-week rate:</b> ${Math.round(p.ceiling.spike_week_rate * 100)}% <span class="faint">of ${p.ceiling.sample_weeks} games${p.ceilRatio != null ? ` · ${p.ceilRatio}× ${esc(p.pos)} avg` : ""}</span></div>
          <div><b>boom / floor week:</b> ${p.ceiling.boom_pts} / ${p.ceiling.floor_pts} pts <span class="faint">(${esc(p.pos)} top-5 line ${p.ceiling.boom_line})</span></div>
          <div class="faint">Separate display attribute — never an input to value.</div>`
          : `<div>${noData} — rookie / &lt;10 career games</div>`)}
        ${section("avail", "Availability & injury", `
          <div><b>median games used:</b> ${p.medianGames} <span class="faint">of 17</span></div>
          <div><b>games played:</b> ${["2023", "2024", "2025"].map((y) => `${y}: ${gp[y] ?? "–"}`).join(" · ")}</div>
          <div><b>age:</b> ${a.age ?? p.age ?? "–"} · <b>status:</b> ${esc(a.current_injury_status ?? "healthy/none")}</div>
          <div><b>injury history:</b> ${a.injury_history == null ? noData + ' <span class="faint">(research pending)</span>' : esc(a.injury_history)}</div>`)}
        ${section("situation", `Situation & risk flags${p.flagged.length ? ` (${p.flagged.length})` : ""}`, `
          <div><b>Situation</b> ${p.situation?.modifier == null ? noData : `×${p.situation.modifier}`}</div>
          ${facts.length ? facts.map((f) => `<div class="fact">${esc(f.date)} <span class="ftype">${esc(f.type)}</span> ${esc(f.fact)}${f.source ? ` <a href="${esc(f.source)}" target="_blank" rel="noopener">src</a>` : ""}</div>`).join("") : `<div>${noData} — no curated facts touch this player yet</div>`}
          <div class="dsect-sub"><b>Risk flags:</b> ${p.risk_flags.researched === false ? `${noData} — not yet researched (null ≠ clean)` :
            p.flagged.length ? `<b class="flagged-txt">${p.flagged.map(esc).join(", ")}</b>` : "researched: clean"}</div>
          ${notes.map((n) => `<div class="fact faint">• ${esc(n)}</div>`).join("")}`)}
        ${section("build", "How this value is built", edgeExplainer(p))}
      </div>
    </div>`;
  }

  const headerHTML = `
    <div class="drow dhead" aria-hidden="true">
      <span></span>
      <span></span>
      <span class="dmain-head"><span class="dr">#</span><span class="dname">player</span><span class="dpos">pos</span>
      <span class="dbc">BC</span><span class="dbcdiff">BC−adp</span><span class="dadp">adp</span><span class="dval">$val</span><span class="dgap">edge</span><span class="dbcgap">vs BC</span><span class="dceil">ceil</span><span class="dbye">bye</span></span>
    </div>`;

  /* ---------- views ---------- */
  function visible() {
    let list = rows;
    if (pos !== "ALL") list = list.filter((p) => p.pos === pos);
    if (hideDrafted) list = list.filter((p) => !taken.has(p.id));
    if (hideFlagged) list = list.filter((p) => !p.flagged.length);
    return list;
  }

  /* ---- "will he last to MY pick?" — the snake read ----
     Only rendered once you've set a draft slot; with no slot the rail makes no claim at all rather
     than guessing a seat. The question it answers shifts by one turn when you're the one on the
     clock: at that moment "does he survive to my next pick" is moot (you can just take him), and the
     live decision is the WHEEL — if I spend this pick elsewhere, is he back at my following one.
     Precision is deliberately capped at three buckets around a stated half-round of slack. The board
     carries no ADP variance, so anything finer would be invented. */
  function survivalHTML(adp, nextPick, myNext, mine) {
    if (adp == null || !myNext) return "";
    const onMe = myNext === nextPick;
    const at = onMe ? mine[1] : myNext;
    const chip = (cls, txt, why) => `<span class="tgt-hold ${cls}" title="${esc(why)}">${txt}</span>`;
    if (!at) return chip("tgt-hold-flip", "your last pick", "This is the final pick you hold in the draft, so there's no later turn to wait for. It's now or not at all.");
    const a = Math.round(adp);
    if (a < nextPick) return chip("tgt-hold-flip", `${at - nextPick} to #${at}`,
      `He has already outlasted his ADP of ${a}, so ADP can't price whether he survives the ${at - nextPick} picks between now and your #${at}. That one's a live judgment call, not a number.`);
    const d = a - at;
    const rule = `Bucketed with ${ADP_SLACK} picks of slack either side of your pick — a rule of thumb about how noisy ADP is in a ${TEAMS}-team league, not a computed probability. The board carries no ADP variance to derive one from.`;
    if (d >= ADP_SLACK) return chip("tgt-hold-safe", `${onMe ? "back at" : "lasts to"} #${at}`,
      `His ADP of ${a} sits ${d} picks past your #${at}${onMe ? ", the pick you come back on if you spend this one elsewhere" : ""}, so he should still be there. ${rule}`);
    if (d > -ADP_SLACK) return chip("tgt-hold-flip", `coin flip #${at}`,
      `His ADP of ${a} lands within ${ADP_SLACK} picks of your #${at}${onMe ? " (your next turn after this one)" : ""}. Genuinely could go either way. ${rule}`);
    return chip("tgt-hold-gone", onMe ? "now or never" : `gone by #${at}`,
      `His ADP of ${a} is ${-d} picks before your #${at}${onMe ? ", so passing here almost certainly costs him" : ", so waiting almost certainly costs him"}. ${rule}`);
  }

  /* ---------- target list (the rail beside the board) ----------
     Answers one question on the clock: of the players I actually want, who goes next, and do I have
     time? "Away" is measured from the LIVE pick number, which is just the count of drafted marks + 1
     — the take button is already the thing you press on every pick, so the counter costs no extra
     bookkeeping. It is only as accurate as those marks, which is why the rail states the pick number
     it's counting from rather than hiding the assumption behind a number.
     Sorted by ADP ascending: the top of the rail is the target the market takes first. */
  function paintTargets() {
    const body = $("#targets-body");
    if (!body) return;
    const byId = new Map(rows.map((p) => [p.id, p]));
    const all = [...targets].map((id) => byId.get(id)).filter(Boolean);
    const gone = all.filter((p) => taken.has(p.id));
    const live = all.filter((p) => !taken.has(p.id))
      .sort((a, b) => (a.adp?.half_ppr ?? Infinity) - (b.adp?.half_ppr ?? Infinity));

    // Pick number: Sleeper's actual count when connected, otherwise the old count-your-marks
    // fallback. The fallback is only as good as your clicking, which is exactly why the live feed
    // exists — but it stays, because an unconnected board should still work.
    const nextPick = sync.connected && sync.picksMade != null ? sync.picksMade + 1 : manualTaken.size + 1;
    const nextRd = Math.floor((nextPick - 1) / TEAMS) + 1;
    const over = nextPick > ROUNDS * TEAMS;
    // your seat in the snake: the picks you still hold, soonest first. A connected draft publishes
    // draft_order, so the seat is read rather than set by hand; the dropdown remains the fallback.
    // Null on both = the rail simply doesn't make the claim, rather than guessing a seat.
    const slot = sync.mySlot ?? draftSlot;
    const mine = slot ? myPicksFrom(nextPick, slot) : [];
    const myNext = mine[0] ?? null;
    const onMe = myNext === nextPick;

    $("#tgt-count").textContent = live.length ? `${live.length}` : "";
    const srcTxt = sync.connected
      ? `<span class="tgt-livedot" title="Live from Sleeper">●</span> ${liveTaken.size} from Sleeper${manualTaken.size ? ` · ${manualTaken.size} manual` : ""}`
      : `${manualTaken.size} drafted mark${manualTaken.size === 1 ? "" : "s"}`;
    const clockTxt = over ? `<b class="mono">draft complete</b> <span class="faint">· all ${ROUNDS * TEAMS} picks in</span>`
      : `<b class="mono">pick #${nextPick}</b> <span class="faint">· rd ${nextRd} · ${srcTxt}</span>`;
    const mineTxt = !slot
      ? `<span class="faint">set your draft slot for "will he last to my pick?"</span>`
      : mine.length
        ? `<span class="tgt-mine${onMe ? " on-me" : ""}">${onMe ? "YOU'RE UP" : "you"}:</span> <span class="mono">${mine.slice(0, 4).map((n) => `#${n}`).join(" · ")}${mine.length > 4 ? " …" : ""}</span>`
        : `<span class="faint">no picks left from slot ${slot}</span>`;
    $("#tgt-clockline").innerHTML = `${clockTxt}<br>${mineTxt}`;
    $("#tgt-clockline").title = (sync.connected
      ? `Pick number comes from Sleeper's live pick count for draft ${sync.draftId}, not from your clicking, so it stays right even if you never touch a row.`
      : `The pick number is derived from the ${manualTaken.size} players you've marked drafted, so mark every pick as it happens; skip some and the distances read long. Connect a draft ID up top to have Sleeper keep this count for you.`)
      + (slot ? ` Your picks come from slot ${slot}${sync.mySlot ? " (read from Sleeper's draft order)" : " (set by hand)"} of a ${TEAMS}-team, ${ROUNDS}-round snake with no reversal round, which is how this league has drafted every year on record.` : "");

    if (!live.length && !gone.length) {
      body.innerHTML = `<div class="tgt-empty">No targets yet. Hit <span class="tgt-mark">☆</span> on any row to put a player here, and he'll drop off this list the moment you mark him drafted.</div>`;
      return;
    }
    // Bye collisions among the players still on the list. A bye column on a shortlist earns its keep
    // by answering "am I stacking holes in one week?", so a shared week is called out rather than
    // left for you to spot. Counted over LIVE targets only — a drafted one is somebody else's problem.
    tgtByes = {};
    for (const p of live) if (p.bye != null) (tgtByes[p.bye] ??= []).push(p.name);

    const items = live.map((p) => {
      const tc = p.fftiers ? tierColor(p.fftiers.tier) : null;
      const adp = p.adp?.half_ppr;
      const away = adp == null ? null : Math.round(adp) - nextPick;
      const adpTxt = adp == null ? `<span class="nodata">no ADP</span>` : `ADP ${adp} <span class="faint">· rd ${Math.ceil(adp / TEAMS)}</span>`;
      let awayTxt, awayCls, awayTitle;
      if (away == null) {
        awayTxt = "–"; awayCls = "tgt-away-none";
        awayTitle = "No ADP on file for this player, so there's no market expectation to measure against. He's a pure read.";
      } else if (away > 0) {
        awayTxt = `${away} pick${away === 1 ? "" : "s"} · ${(away / TEAMS).toFixed(1)} rd`;
        awayCls = away <= TEAMS ? "tgt-away-soon" : "";
        awayTitle = `The market takes him around pick ${Math.round(adp)}; you're at pick ${nextPick}. That leaves ${away} picks of room, or ${(away / TEAMS).toFixed(1)} rounds${away <= TEAMS ? ". That's inside the next round, so he may not survive your next turn." : "."}`;
      } else if (away === 0) {
        awayTxt = "on the clock"; awayCls = "tgt-away-now";
        awayTitle = `Pick #${nextPick} is exactly his ADP. This is where the market takes him.`;
      } else {
        awayTxt = `${-away} past ADP`; awayCls = "tgt-away-past";
        awayTitle = `He's lasted ${-away} picks beyond his ADP of ${Math.round(adp)} and is still on the board. The market is letting him fall.`;
      }
      const rec = p.rec === "TARGET" || p.rec === "FADE" ? `<span class="tgt-rec ${p.rec === "TARGET" ? "name-value" : "name-reach"}">${p.rec}</span>` : "";
      const shared = p.bye == null ? [] : (tgtByes[p.bye] ?? []).filter((n) => n !== p.name);
      const byeTitle = p.bye == null
        ? "No bye week on file for this player. Either he has no NFL team, or the schedule wasn't reachable when the board was built."
        : shared.length
          ? `Week ${p.bye} bye, shared with ${shared.join(", ")} on this list. Take ${shared.length === 1 ? "both" : `all ${shared.length + 1}`} and that's ${shared.length + 1} holes to cover in the same week.`
          : `Week ${p.bye} bye. No other live target here is off that week.`;
      const byeHTML = `<span class="tgt-bye mono${shared.length ? " clash" : ""}" title="${esc(byeTitle)}">${p.bye == null ? '<span class="nodata">bye –</span>' : `bye ${p.bye}`}</span>`;
      return `<div class="tgt" data-id="${p.id}"${tc ? ` style="--tier-stripe:${tc.stripe}"` : ""}>
        <div class="tgt-main">
          <div class="tgt-l1"><span class="tgt-name">${esc(p.name)}</span><span class="tgt-adp mono">${adpTxt}</span></div>
          <div class="tgt-l2"><span class="tgt-pos mono">${esc(p.pos)}${p.posRank ?? ""} · ${esc(p.team)}${p.fftiers ? ` · BC ${p.fftiers.rank}` : ""} · ${fmtD(p.draftDollar)}</span><span class="tgt-r2">${rec}${byeHTML}</span></div>
          <div class="tgt-l3"><span class="tgt-away mono ${awayCls}" title="${esc(awayTitle)}">${awayTxt}</span>${survivalHTML(adp, nextPick, myNext, mine)}</div>
        </div>
        <button class="tgt-x" data-act="untarget" title="Remove ${esc(p.name)} from the target list">×</button>
      </div>`;
    }).join("");
    // Drafted targets aren't silently swallowed — during a draft "who sniped my guy" is information.
    // They're filtered, not deleted, so un-marking one puts him straight back in the list above.
    const goneHTML = gone.length ? `<div class="tgt-gone" title="Filtered out because they're marked drafted, not deleted. Un-mark one and he returns to the list above.">
      <b>${gone.length} gone:</b> ${gone.map((p) => `<s>${esc(p.name)}</s>`).join(", ")}</div>` : "";
    body.innerHTML = (live.length ? items : `<div class="tgt-empty">Every target you set is off the board.</div>`) + goneHTML;
  }

  function paint() {
    paintSyncStatus();
    paintPrep();
    paintTargets();
    const list = visible();
    if (view === "board") {
      const sortLabel = { bc: "by Boris Chen", bcdiff: "by BC−ADP value", adp: "by ADP", draftval: "by draft $", edge: "by edge", bcgap: "by us-vs-consensus" }[sort] ?? "by Boris Chen";
      $("#board-title").textContent = (pos === "ALL" ? "Value board" : `Value board — ${pos}`) + " · " + sortLabel;
      const sortFns = {
        bc: (a, b) => (a.fftiers?.rank ?? Infinity) - (b.fftiers?.rank ?? Infinity),
        bcdiff: (a, b) => (b.bcDiff ?? -Infinity) - (a.bcDiff ?? -Infinity),   // biggest value (falls furthest past consensus) first
        adp: (a, b) => (a.adp?.half_ppr ?? Infinity) - (b.adp?.half_ppr ?? Infinity),
        draftval: (a, b) => (b.draftDollar ?? -1) - (a.draftDollar ?? -1),
        edge: (a, b) => (b.edgeDollar ?? -Infinity) - (a.edgeDollar ?? -Infinity),
        bcgap: (a, b) => (b.bcGap ?? -Infinity) - (a.bcGap ?? -Infinity),   // most bearish-vs-consensus (our value most below the crowd) first
      };
      const sorted = [...list].sort(sortFns[sort] ?? sortFns.bc);
      const starts = tierStarts(sorted);
      $("#board-body").innerHTML = headerHTML +
        sorted.map((p, i) => rowHTML(p, p.draftRank ?? "–", starts[i])).join("") +
        `<div class="boardfoot">${washOn() ? "<b>Row color + left band</b> = Boris Chen tier (a block of one color is one tier)" : "<b>Left band</b> = Boris Chen tier (the full-row wash is on the BC sort only, where tiers run contiguous)"} · <b>BC</b> = Boris Chen consensus rank (your primary board) · <b>BC−adp</b> = spots the market lets him fall past that consensus (<span class="name-value">+ = value</span> / <span class="name-reach">− = reach</span>) · <b>$val</b>: ≥$1 = auction price, &lt;$1 = proximity-to-rosterable score · <b>edge</b>: $-gap above $1, board-vs-ADP pick-gap (Np) below · <span class="name-value">TARGET</span>/<span class="name-reach">FADE</span> + confidence dots ●●●. Bench tier gets no TARGET — lean on <b>ceil</b> for upside · hover <b>bye</b> to see who on your target list shares that week. # = draft-value rank.</div>`;
    } else {
      $("#board-title").textContent = "Tiers — cliff edges (by draft $)";
      const posList = pos === "ALL" ? ["RB", "WR", "QB", "TE", "K", "DEF"] : [pos];
      $("#board-body").innerHTML = posList.map((ps) => {
        const tiers = tiersFor(list.filter((p) => p.pos === ps));
        // Note these are OUR draft-$ tiers; the row wash is still Boris Chen's tier, so within a
        // block the colors show how cleanly the two tierings agree. tierStarts() runs per block and
        // self-disables where the BC tiers interleave, which is the usual case here.
        return tiers.map((tier, i) => {
          const st = tierStarts(tier);
          return `
          <div class="tierhead"><span>${ps} · Tier ${i + 1}</span><span class="faint">${tier.length} players</span></div>
          ${headerHTML}
          ${tier.map((p, j) => rowHTML(p, `${ps}${p.posRank}`, st[j]) + (j === tier.length - 1 ? '<div class="cliff">▼ value cliff</div>' : "")).join("")}`;
        }).join("");
      }).join("");
    }
  }

  /* ---------- events (delegated; state survives reloads) ---------- */
  $("#board-body").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const id = act.closest(".drow")?.dataset.id;
    if (!id) return;
    if (act.dataset.act === "take") {
      // Sleeper is authoritative for a connected draft: a player the league actually picked cannot
      // be un-drafted here, so the button is inert on him rather than silently disagreeing with the
      // feed for the ten seconds until the next poll puts him back. Manual marks stay reversible.
      if (liveTaken.has(id)) return;
      manualTaken.has(id) ? manualTaken.delete(id) : manualTaken.add(id);
      saveTaken(); rebuildTaken();
    } else if (act.dataset.act === "star") {
      targets.has(id) ? targets.delete(id) : targets.add(id);
      saveTargets();
    } else if (act.dataset.act === "expand") {
      expandedId = expandedId === id ? null : id;
    } else if (act.dataset.act === "sect") {
      const k = act.dataset.sect;
      openSect.has(k) ? openSect.delete(k) : openSect.add(k);
    }
    paint();
  });

  // rail: remove a target. Full repaint so the row's own star un-fills in the same tick.
  $("#targets-body").addEventListener("click", (e) => {
    const act = e.target.closest('[data-act="untarget"]');
    const id = act?.closest(".tgt")?.dataset.id;
    if (!id) return;
    targets.delete(id); saveTargets(); paint();
  });
  $("#draft-slot").addEventListener("change", (e) => {
    draftSlot = e.target.value ? +e.target.value : null;
    saveKnobs(); paintTargets();
  });
  $("#clear-targets").addEventListener("click", () => {
    if (targets.size && confirm(`Clear all ${targets.size} targets?`)) { targets.clear(); saveTargets(); paint(); }
  });

  document.querySelectorAll("#toolbar [data-pos]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#toolbar [data-pos]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true"); pos = b.dataset.pos; paint();
  }));
  document.querySelectorAll("#toolbar [data-view]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#toolbar [data-view]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true"); view = b.dataset.view; paint();
  }));
  document.querySelectorAll("#toolbar [data-sort]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#toolbar [data-sort]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true"); sort = b.dataset.sort; paint();
  }));
  $("#hide-drafted").addEventListener("click", (e) => {
    hideDrafted = !hideDrafted; e.target.setAttribute("aria-pressed", String(hideDrafted)); paint();
  });
  $("#hide-flagged").addEventListener("click", (e) => {
    hideFlagged = !hideFlagged; e.target.setAttribute("aria-pressed", String(hideFlagged)); paint();
  });
  $("#reset-draft").addEventListener("click", () => {
    // Only your own marks are yours to clear. Sleeper's picks are re-fetched on the next poll
    // regardless, so offering to "clear" them would be a button that visibly undoes itself.
    if (!manualTaken.size) {
      alert(sync.connected
        ? `No manual marks to clear. The ${liveTaken.size} drafted players come from Sleeper's live feed — disconnect to drop them.`
        : "No drafted marks to clear.");
      return;
    }
    if (confirm(`Clear ${manualTaken.size} manual mark${manualTaken.size === 1 ? "" : "s"}?${sync.connected ? ` The ${liveTaken.size} from Sleeper stay.` : ""}`)) {
      manualTaken.clear(); saveTaken(); rebuildTaken(); paint();
    }
  });

  /* ---------- player search (combobox in the toolbar) ----------
     Type a name, pick a match, land on that player with his drop-down already open. Each match also
     carries a star, so the common draft-day move — "someone just mentioned a name, is he worth
     wanting?" — is two keystrokes and one click without ever leaving your place on the board. */

  // Normalize for matching but KEEP word boundaries: "Ja'Marr Chase" -> "jamarr chase". That's what
  // lets a bare surname rank above a mid-word hit, which is how people actually search.
  const normS = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const SEARCH_MAX = 8;

  function searchFor(q) {
    const n = normS(q);
    if (n.length < 2) return [];          // 1 letter matches half the league; not worth rendering
    const out = [];
    for (const p of rows) {
      const nm = normS(p.name);
      if (!nm.includes(n)) continue;
      // Any word starting with the query counts the same, then board value breaks the tie. Ranking
      // first-name matches above surname matches instead put Chase Brown and Chase McLaughlin over
      // Ja'Marr Chase on "chase" — technically consistent, obviously not what you meant. Mid-word
      // hits fall to the bottom, which is where "marr" belongs.
      const tier = nm.split(" ").some((w) => w.startsWith(n)) ? 0 : 1;
      out.push({ p, tier });
    }
    out.sort((a, b) => a.tier - b.tier || (a.p.draftRank ?? 1e9) - (b.p.draftRank ?? 1e9));
    return out.slice(0, SEARCH_MAX).map((o) => o.p);
  }

  // Shut the list and reset its ARIA. Kept separate from renderSearch's no-match branch on purpose:
  // after you pick someone the input holds his full name, so a shared "empty means no match" path
  // would pop the list straight back open reading "No player matches that" about the name you just
  // chose. Closing is a state, not the absence of results.
  function closeSearch() {
    searchHits = []; searchIdx = -1;
    const list = $("#search-list"), input = $("#search");
    list.hidden = true; list.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    $("#search-clear").hidden = !input.value;
  }

  function renderSearch() {
    const list = $("#search-list"), input = $("#search");
    $("#search-clear").hidden = !input.value;
    if (!searchHits.length) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      const noMatch = normS(input.value).length >= 2;
      list.hidden = !noMatch;
      list.innerHTML = noMatch ? `<div class="srch-empty">No player matches that.</div>` : "";
      return;
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    // The star is a sibling of the option, not a child: role="option" owning a button is malformed,
    // and the wrapper carries role="presentation" so the listbox still owns its options directly.
    list.innerHTML = searchHits.map((p, i) => {
      const isTgt = targets.has(p.id), isTaken = taken.has(p.id);
      const tc = p.fftiers ? tierColor(p.fftiers.tier) : null;
      return `<div class="srch-row" role="presentation"${tc ? ` style="--tier-stripe:${tc.stripe}"` : ""}>
        <div class="srch-opt${i === searchIdx ? " on" : ""}" role="option" id="srch-opt-${i}" data-id="${p.id}" aria-selected="${i === searchIdx}">
          <span class="srch-name${isTaken ? " gone" : ""}">${esc(p.name)}</span>
          <span class="srch-meta mono">${esc(p.pos)}${p.posRank ?? ""} · ${esc(p.team)}${p.fftiers ? ` · BC ${p.fftiers.rank}` : ""} · ${fmtD(p.draftDollar)}${p.bye != null ? ` · bye ${p.bye}` : ""}${isTaken ? " · drafted" : ""}</span>
        </div>
        <button class="srch-star${isTgt ? " on" : ""}" data-act="srch-star" data-id="${p.id}" aria-pressed="${isTgt}" title="${isTgt ? `Remove ${esc(p.name)} from the target list` : `Add ${esc(p.name)} to the target list`}">${isTgt ? "★" : "☆"}</button>
      </div>`;
    }).join("");
    if (searchIdx >= 0) input.setAttribute("aria-activedescendant", `srch-opt-${searchIdx}`);
    else input.removeAttribute("aria-activedescendant");
  }

  /* Jump to a player. "Take me to him" is a promise, so anything currently hiding him gets relaxed
     rather than leaving you staring at a board he isn't on — and the note says which control moved,
     because a filter silently resetting itself is worse than the filter being on. */
  function gotoPlayer(id) {
    const p = rows.find((x) => x.id === id);
    if (!p) return;
    const moved = [];
    if (pos !== "ALL" && p.pos !== pos) { setGroup("data-pos", "ALL"); pos = "ALL"; moved.push("position filter"); }
    if (hideDrafted && taken.has(id)) { hideDrafted = false; $("#hide-drafted").setAttribute("aria-pressed", "false"); moved.push("hide-drafted"); }
    if (hideFlagged && p.flagged.length) { hideFlagged = false; $("#hide-flagged").setAttribute("aria-pressed", "false"); moved.push("hide-risk-flagged"); }
    expandedId = id;
    paint();
    // the tiers view drops players with no draft-$ entirely, so if he still isn't on the page after
    // the filters were relaxed, fall back to the board rather than scrolling to nothing
    if (!document.querySelector(`.drow[data-id="${id}"]`) && view !== "board") {
      setGroup("data-view", "board"); view = "board"; moved.push("view → value board");
      paint();
    }
    const el = document.querySelector(`.drow[data-id="${id}"]`);
    if (!el) { $("#search-note").textContent = `${p.name} isn't on the board right now.`; return; }
    // Smooth only for short hops, where the animation tells you which way the board moved. A jump
    // across the tiers view is 10,000px and takes ~2s smooth, which on the clock is just a delay
    // with a blur in it — and long enough that the landing outline can expire before you arrive.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const far = Math.abs(el.getBoundingClientRect().top) > window.innerHeight * 2;
    el.scrollIntoView({ block: "start", behavior: (reduced || far) ? "auto" : "smooth" });
    el.classList.add("found");
    setTimeout(() => el.classList.remove("found"), 2600);
    $("#search").value = p.name;
    $("#search-note").textContent = moved.length ? `Cleared ${moved.join(" + ")} to show him.` : "";
    closeSearch();
  }

  // set a toolbar toggle group to one value, keeping aria-pressed truthful across the group
  function setGroup(attr, val) {
    document.querySelectorAll(`#toolbar [${attr}]`).forEach((b) =>
      b.setAttribute("aria-pressed", String(b.getAttribute(attr) === val)));
  }

  const searchInput = $("#search");
  searchInput.addEventListener("input", () => {
    searchHits = searchFor(searchInput.value);
    searchIdx = searchHits.length ? 0 : -1;
    $("#search-note").textContent = "";
    renderSearch();
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { searchInput.value = ""; $("#search-note").textContent = ""; closeSearch(); return; }
    if (!searchHits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      searchIdx = (searchIdx + (e.key === "ArrowDown" ? 1 : -1) + searchHits.length) % searchHits.length;
      renderSearch();
      $(`#srch-opt-${searchIdx}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      gotoPlayer(searchHits[Math.max(0, searchIdx)].id);
    }
  });
  searchInput.addEventListener("focus", () => { if (searchInput.value) { searchHits = searchFor(searchInput.value); renderSearch(); } });
  $("#search-clear").addEventListener("click", () => {
    searchInput.value = ""; $("#search-note").textContent = ""; closeSearch(); searchInput.focus();
  });
  $("#search-list").addEventListener("click", (e) => {
    const star = e.target.closest('[data-act="srch-star"]');
    if (star) {
      // Starring must NOT navigate or close: you're often adding two or three off one search.
      // stopPropagation is load-bearing, not defensive. Re-rendering the list detaches the button
      // that was clicked, so by the time this event reaches the document's outside-click handler
      // e.target.closest(".srchwrap") walks an orphaned node and returns null — the list would read
      // that as a click outside itself and shut.
      e.stopPropagation();
      const id = star.dataset.id;
      targets.has(id) ? targets.delete(id) : targets.add(id);
      saveTargets(); paint(); renderSearch();
      return;
    }
    const opt = e.target.closest(".srch-opt");
    if (opt) gotoPlayer(opt.dataset.id);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".srchwrap")) closeSearch(); });

  /* ---------- replacement (scarcity) knob ---------- */
  function updateKnobReadouts() {
    const rb = $("#repl-basis-val");
    if (rb) rb.textContent = replBasis <= 0 ? `starters (RB${replRankFor("RB", 0)}·WR${replRankFor("WR", 0)})`
      : replBasis >= 1 ? `rostered (RB${replRankFor("RB", 1)}·WR${replRankFor("WR", 1)})`
      : `RB${replRankFor("RB", replBasis)}·WR${replRankFor("WR", replBasis)}`;
  }
  const replInput = $("#repl-basis");
  if (replInput) replInput.addEventListener("input", (e) => {
    replBasis = +e.target.value; saveKnobs(); rank(rows); updateKnobReadouts(); paint();
  });

  /* ---------- sticky column header offset ----------
     The toolbar above is sticky at top:0 with a wrapping (variable-height) row of controls, so the
     locked column header must park at exactly the toolbar's current height. Measure it and expose it
     as --toolbar-h; keep it live on resize (ResizeObserver catches wrap-height changes too). */
  const toolbarEl = document.getElementById("toolbar");
  const syncToolbarH = () => {
    // Skip measuring in a degenerate 0-width layout (e.g. a not-yet-displayed / non-composited pane):
    // the toolbar wraps every control onto its own line and reports a garbage height that would push
    // the sticky header off-screen. Keep the last good value; a real display always has width > 0.
    if (!toolbarEl || document.documentElement.clientWidth === 0) return;
    document.documentElement.style.setProperty("--toolbar-h", `${toolbarEl.offsetHeight}px`);
  };
  syncToolbarH();
  if (toolbarEl && "ResizeObserver" in window) new ResizeObserver(syncToolbarH).observe(toolbarEl);
  window.addEventListener("resize", syncToolbarH);
  // fonts settle after first paint (the toolbar reflows taller), so re-measure on load too
  window.addEventListener("load", syncToolbarH);

  /* ---------- on-deck prep (deterministic; Phase 1 of the N-3 module) ----------
     Fires when your pick is PREP_WINDOW picks out or closer, so the thinking happens inside somebody
     else's clock and your own 60 seconds are spent reading, not waiting.

     Everything here is arithmetic over data the page already holds — no LLM, no network, no session
     required. That is deliberate: it works on the deployed dashboard with nothing else running, and
     a later Claude layer can enrich it without this half ever going dark.

     It deliberately does NOT name one player. Two reasons, and they point the same way: a single name
     dies the moment someone drafts him while you're reading, and a shortlist is the opposite of how
     this board is meant to be used — the whole point is breadth across the pool, freshly ranked, not
     a pre-committed list. So the output is ranked candidates per position of need, plus the tier
     cliff behind them, which is what actually decides whether you can wait a round. */
  const PREP_WINDOW = 3;
  const RUN_LOOKBACK = 10;   // picks of history for "is this position running?"
  const STARTERS = [["QB",1],["RB",2],["WR",2],["TE",1],["K",1],["DEF",1]];
  const FLEX_N = 2, FLEX_OK = new Set(["RB","WR","TE"]);

  // Which starting slots this roster still has open. Greedy: dedicated slots first, spares to FLEX.
  // Good enough to read "what do I still need", which is the only question it's asked.
  function openSlots(posList) {
    const open = [];
    for (const [ps, n] of STARTERS) {
      const have = posList.filter((x) => x === ps).length;
      if (have < n) open.push(...Array(n - have).fill(ps));
    }
    const spare = [...FLEX_OK].reduce((acc, ps) => {
      const need = STARTERS.find(([p]) => p === ps)[1];
      return acc + Math.max(0, posList.filter((x) => x === ps).length - need);
    }, 0);
    return { open, flexOpen: Math.max(0, FLEX_N - Math.min(spare, FLEX_N)) };
  }

  function paintPrep() {
    const el = $("#prep");
    if (!el) return;
    const nextPick = sync.connected && sync.picksMade != null ? sync.picksMade + 1 : null;
    const slot = sync.mySlot ?? draftSlot;
    if (!sync.connected || !nextPick || !slot || sync.reversal) { el.hidden = true; return; }

    const mine = myPicksFrom(nextPick, slot);
    const myNext = mine[0];
    if (!myNext) { el.hidden = true; return; }
    const away = myNext - nextPick;
    if (away > PREP_WINDOW) { el.hidden = true; return; }
    el.hidden = false;

    const byId = new Map(rows.map((p) => [p.id, p]));
    const posOf = (pk) => byId.get(pk.player_id)?.pos ?? pk.metadata?.position ?? "?";

    // --- your roster and what it still needs ---
    const myPos = sync.picks.filter((p) => p.draft_slot === slot).map(posOf);
    const { open, flexOpen } = openSlots(myPos);
    const needSet = new Set(open);
    if (flexOpen) for (const p of FLEX_OK) needSet.add(p);
    const needList = [...new Set(open)];

    // --- position run pressure over the recent window ---
    const recent = sync.picks.slice(-RUN_LOOKBACK).map(posOf);
    const runs = ["RB","WR","TE","QB"].map((ps) => ({ ps, n: recent.filter((x) => x === ps).length }))
      .filter((r) => r.n > 0).sort((a, b) => b.n - a.n);

    // --- candidates ---
    // Ranked by Boris Chen (the board's own default sort; ADP rides alongside as the market's
    // disagreeing opinion) across every position you still need, then capped and grouped.
    //
    // The cap is what makes this usable. Filtering only on "open starting slot" surfaces K and DEF
    // in round 3 — technically an open slot, obviously not a round-3 decision — and a first cut of
    // this panel did exactly that, printing 18 players across 6 blocks with a meaningless "1 left in
    // tier 22" cliff on kickers. Ranking the pool as one list and taking the top few drops K/DEF on
    // their own merits until they're genuinely the best thing left, with no round-number heuristic
    // to tune or get wrong.
    const MAX_CANDIDATES = 6, MAX_POS_BLOCKS = 3;
    const bcRank = (p) => p.fftiers?.rank ?? Infinity;
    const avail = rows.filter((p) => !taken.has(p.id));
    const pool = avail.filter((p) => needSet.has(p.pos)).sort((a, b) => bcRank(a) - bcRank(b));
    const byPos = {};
    for (const p of pool) {
      if (Object.keys(byPos).length >= MAX_POS_BLOCKS && !byPos[p.pos]) continue;
      const seen = Object.values(byPos).reduce((n, d) => n + d.list.length, 0);
      if (seen >= MAX_CANDIDATES) break;
      (byPos[p.pos] ??= { list: [], topTier: null, leftInTier: null }).list.push(p);
    }
    for (const [ps, d] of Object.entries(byPos)) {
      // Tier cliff: how many remain in the best tier still on the board at this position — the read
      // that actually decides "can I wait a round". Players with no BC tier are excluded from the
      // count rather than assumed into it.
      // The best tier still on the board is the MINIMUM tier among the available, not the first one
      // encountered walking the list — `avail` is in board-rank order, which is not tier order, so
      // `.find()` here reported "2 left in tier 5" directly above a tier-2 player.
      const atPos = avail.filter((p) => p.pos === ps);
      const tiers = atPos.map((p) => p.fftiers?.tier).filter((t) => t != null);
      d.topTier = tiers.length ? Math.min(...tiers) : null;
      d.leftInTier = d.topTier == null ? null : tiers.filter((t) => t === d.topTier).length;
    }

    // What you already have beats a list of what you lack: early on "you need QB, WR, TE, K, DEF"
    // is true of everyone and tells you nothing, while the roster you've built is the actual context
    // for the next pick. The open slots still get named once the list is short enough to mean something.
    const haveTxt = ["QB","RB","WR","TE","K","DEF"]
      .map((ps) => { const n = myPos.filter((x) => x === ps).length; return n ? `${ps}${n > 1 ? "×" + n : ""}` : null; })
      .filter(Boolean).join(" ") || "nothing yet";
    const needTxt = needList.length <= 3
      ? needList.join(", ") + (flexOpen ? ` + ${flexOpen} FLEX` : "")
      : `${needList.length} starting slots + ${flexOpen} FLEX`;
    const runTxt = runs.length
      ? runs.map((r) => `${r.ps} ${r.n}`).join(" · ")
      : "no clear run";

    const head = away === 0
      ? `<b class="prep-up">YOU'RE UP</b> <span class="faint">· pick #${myNext}</span>`
      : `<b>on deck</b> <span class="faint">· #${myNext}, ${away} pick${away === 1 ? "" : "s"} away</span>`;

    const blocks = Object.entries(byPos).map(([ps, d]) => {
      const cliff = d.leftInTier == null ? `<span class="nodata">no tier</span>`
        : d.leftInTier <= 2 ? `<span class="prep-cliff">${d.leftInTier} left in tier ${d.topTier} — cliff</span>`
        : `<span class="faint">${d.leftInTier} left in tier ${d.topTier}</span>`;
      const names = d.list.map((p) => {
        const adp = p.adp?.half_ppr;
        // Does his ADP say he even reaches your pick? Same half-round slack and the same three
        // buckets the rail uses — no new precision is invented here.
        const fate = adp == null ? "" : adp < myNext - ADP_SLACK ? `<span class="prep-gone">likely gone</span>`
          : adp <= myNext + ADP_SLACK ? `<span class="prep-flip">coin flip</span>` : `<span class="prep-safe">should last</span>`;
        // Tier per row, not just per position: "1 left in tier 2" above three names otherwise reads
        // as if all three were in tier 2. Showing T2/T3/T3 makes the cliff visible instead of stated.
        const t = p.fftiers?.tier;
        return `<div class="prep-row"><span class="prep-nm">${esc(p.name)}</span>` +
          `<span class="mono prep-t"${t != null && t === d.topTier ? ' data-top="1"' : ""}>${t == null ? "–" : "T" + t}</span>` +
          `<span class="mono faint">${adp == null ? "no adp" : "adp " + adp}</span>${fate}</div>`;
      }).join("");
      return `<div class="prep-pos"><div class="prep-poshead"><b>${ps}</b> ${cliff}</div>${names}</div>`;
    }).join("");

    el.innerHTML = `<div class="prep-head">${head}</div>` +
      `<div class="prep-need"><span class="faint">have:</span> ${esc(haveTxt)}` +
      `<span class="faint"> · open:</span> ${esc(needTxt)}</div>` +
      (blocks || `<div class="prep-empty">Starters full — this one's a best-available pick.</div>`) +
      `<div class="prep-runs" title="Positions taken in the last ${RUN_LOOKBACK} picks. A run is the signal to pivot early rather than trust ADP.">` +
      `<span class="faint">last ${RUN_LOOKBACK}:</span> ${runTxt}</div>`;
  }

  /* ---------- live draft sync (Sleeper) ----------
     Paste a draft ID, hit connect, and the board marks players off by itself. This exists so that
     during a draft your attention goes to reading players, not to clicking a ✓ 150 times and
     silently corrupting the pick math the one time you forget.

     CACHE BUSTING IS LOAD-BEARING, not defensive habit. Measured live against a running mock on
     2026-08-13: the plain picks URL returned 41 picks while a unique-query-param URL returned 65,
     and moments later 65 vs 119. Sleeper fronts the API with Cloudflare (picks: s-maxage=15,
     draft: s-maxage=30) plus stale-while-revalidate=300, so the CDN will happily hand back a
     response 80+ seconds old with cf-cache-status=UPDATING. The gap scales as roughly
     cache_age × pick_rate, so a fast draft goes dozens of picks stale. A unique param forces a
     MISS for about 100ms of latency. CORS is wide open (access-control-allow-origin: *) and the
     preflight permits Cache-Control, verified against this origin, so no proxy is needed.

     We cannot read the `age` header from JS — Sleeper only exposes etag and date — so freshness is
     asserted by always busting rather than by inspecting the response. */
  const SYNC_KEY = "hq-draft-2026-draftid";
  const POLL_MS = 10000, POLL_MAX_MS = 60000;
  const REPLAY_AT = (() => {
    const v = new URLSearchParams(location.search).get("at");
    const n = v == null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
  })();
  const sync = {
    draftId: null, connected: false, status: null, picksMade: null, mySlot: null,
    reversal: 0, lastOk: null, err: null, timer: null, delay: POLL_MS, shape: null,
    picks: [],   // full ordered pick feed — the prep panel reads roster shape and run pressure off it
    replay: null,
  };

  const sleeperGet = async (path) => {
    const bust = `_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const r = await fetch(`${C.API}${path}${path.includes("?") ? "&" : "?"}${bust}`,
      { cache: "no-store", headers: { "cache-control": "no-cache" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  function paintSyncStatus() {
    const el = $("#lsync-status"); const btn = $("#lsync-btn");
    if (!el) return;
    btn.textContent = sync.connected ? "disconnect" : "connect";
    btn.classList.toggle("on", sync.connected);
    el.className = "lsync-status";

    // The hand-set slot dropdown yields to Sleeper's draft_order while connected, and is handed
    // back on disconnect. It is disabled rather than hidden so it stays obvious where the seat came
    // from — a silently-overridden control is how you end up distrusting the whole rail.
    const slotSel = $("#draft-slot");
    if (slotSel) {
      const overridden = sync.connected && sync.mySlot != null;
      slotSel.disabled = overridden;
      slotSel.value = overridden ? String(sync.mySlot) : (draftSlot ?? "");
      slotSel.title = overridden
        ? `Slot ${sync.mySlot}, read from Sleeper's draft order for draft ${sync.draftId}. Disconnect to set it by hand.`
        : "Your seat in the snake. Connect a live draft and Sleeper fills this in for you.";
    }
    if (!sync.connected) {
      el.textContent = sync.err ? `not connected · ${sync.err}` : "not connected · marking drafted by hand";
      el.classList.add(sync.err ? "bad" : "idle");
      el.title = sync.err ?? "Paste the draft_id from the Sleeper draft URL and hit connect.";
      return;
    }
    if (sync.err) {
      el.classList.add("bad");
      el.textContent = `SYNC FAILING · ${sync.err} · last good ${sync.lastOk ? Math.round((Date.now() - sync.lastOk) / 1000) + "s ago" : "never"}`;
      el.title = `Retrying every ${Math.round(sync.delay / 1000)}s. The board is frozen at the last good fetch — treat the pick count as a floor, not a fact.`;
      return;
    }
    if (sync.replay != null) {
      el.classList.add("replay");
      const np = (sync.picksMade ?? 0) + 1;
      const ms = sync.mySlot ? myPicksFrom(np, sync.mySlot) : [];
      el.textContent = `REPLAY @ pick #${np} · ${sync.picksMade}/${ROUNDS * TEAMS}`
        + (ms.length ? (ms[0] === np ? " · YOU'RE UP" : ` · you in ${ms[0] - np}`) : "");
      el.title = `Rehearsal mode: draft ${sync.draftId} truncated to its first ${sync.replay} picks via ?at=. Not live, and not polling. Drop ?at= from the URL to follow the real feed.`;
      return;
    }
    const done = sync.status === "complete" || sync.picksMade >= ROUNDS * TEAMS;
    const nextPick = (sync.picksMade ?? 0) + 1;
    const mine = sync.mySlot ? myPicksFrom(nextPick, sync.mySlot) : [];
    const away = mine.length ? mine[0] - nextPick : null;
    el.classList.add(done ? "done" : "live");
    const bits = [
      done ? "COMPLETE" : (sync.status === "pre_draft" ? "CONNECTED · not started" : "LIVE"),
      `${sync.picksMade ?? 0}/${ROUNDS * TEAMS}`,
    ];
    if (!done && sync.status !== "pre_draft") bits.push(`on the clock #${nextPick}`);
    if (!done && away != null) bits.push(away === 0 ? "YOU'RE UP" : `you in ${away}`);
    if (sync.shape) bits.push(sync.shape);
    el.textContent = bits.join(" · ");
    el.title = `Draft ${sync.draftId}. Polling every ${Math.round(sync.delay / 1000)}s with cache-busting.`
      + ` Last good sync ${sync.lastOk ? Math.round((Date.now() - sync.lastOk) / 1000) + "s ago" : "pending"}.`
      + (sync.mySlot ? ` Your slot ${sync.mySlot} read from Sleeper's draft order.` : " Your slot is not published yet; Sleeper sets draft_order when the draft starts.");
  }

  async function pollOnce() {
    // eslint-disable-next-line prefer-const -- `picks` is reassigned by the REPLAY slice below
    let [meta, picks] = await Promise.all([
      sleeperGet(`/draft/${sync.draftId}`),
      sleeperGet(`/draft/${sync.draftId}/picks`),
    ]);
    // REPLAY: ?at=<pickNo> truncates a finished draft to its first N picks, so the board reads
    // exactly as it did at that moment. Built for rehearsing draft day against a real pick sequence
    // (and it's how the on-deck panel gets tested without burning a live mock). It is labelled
    // REPLAY everywhere and freezes polling, because a practice board that could be mistaken for a
    // live one is worse than no practice board.
    if (REPLAY_AT != null) {
      picks = picks.filter((p) => p.pick_no <= REPLAY_AT);
      sync.replay = REPLAY_AT;
    }
    sync.status = meta.status;
    sync.picksMade = picks.length;
    sync.mySlot = meta.draft_order?.[C.MY_USER_ID] ?? null;
    sync.reversal = meta.settings?.reversal_round ?? 0;

    // This page hardcodes a 10-team / 15-round snake because that is what the league has run every
    // year on record. If a connected draft disagrees, say so loudly instead of rendering pick math
    // that is quietly wrong — same reason the reversal case was never implemented.
    const t = meta.settings?.teams, rd = meta.settings?.rounds;
    const wrongShape = (t && t !== TEAMS) || (rd && rd !== ROUNDS) || meta.type !== "snake";
    sync.shape = sync.reversal ? `⚠ reversal_round=${sync.reversal}: pick math invalid`
      : wrongShape ? `⚠ ${t}tm/${rd}rd ${meta.type}: page assumes ${TEAMS}tm/${ROUNDS}rd snake`
      : null;

    sync.picks = picks;
    liveTaken.clear(); livePickNo.clear();
    for (const p of picks) {
      if (!p.player_id) continue;
      liveTaken.add(p.player_id);
      livePickNo.set(p.player_id, p.pick_no);
    }
    rebuildTaken();
    sync.lastOk = Date.now();
    sync.err = null;
  }

  function schedule() {
    clearTimeout(sync.timer);
    if (!sync.connected) return;
    // Nothing more will change once it's over (or when replaying a frozen slice); stop hitting
    // their origin.
    if (sync.status === "complete" || sync.replay != null) { paintSyncStatus(); return; }
    sync.timer = setTimeout(tick, sync.delay);
  }

  async function tick() {
    if (!sync.connected) return;
    try {
      await pollOnce();
      sync.delay = POLL_MS;                                  // recovered: back to normal cadence
      paint();
    } catch (e) {
      // Back off rather than hammer a failing origin, and never wipe the last good picture —
      // a frozen board that says it's frozen beats an empty one that says nothing.
      sync.err = e.message;
      sync.delay = Math.min(POLL_MAX_MS, sync.delay * 2);
      paintSyncStatus();
    }
    schedule();
  }

  async function connect(id) {
    sync.draftId = id; sync.connected = true; sync.err = null; sync.delay = POLL_MS;
    $("#lsync-status").textContent = "connecting…";
    try {
      await pollOnce();
      localStorage.setItem(SYNC_KEY, id);
      paint();
      schedule();
    } catch (e) {
      sync.connected = false; sync.err = `${e.message} — check the draft ID`;
      liveTaken.clear(); livePickNo.clear(); rebuildTaken();
      paint();
    }
  }

  function disconnect() {
    sync.connected = false; sync.err = null; sync.status = null;
    sync.picksMade = null; sync.mySlot = null; sync.shape = null; sync.picks = [];
    clearTimeout(sync.timer);
    liveTaken.clear(); livePickNo.clear(); rebuildTaken();
    localStorage.removeItem(SYNC_KEY);
    paint();
  }

  $("#lsync-btn").addEventListener("click", () => {
    if (sync.connected) return disconnect();
    const raw = $("#draft-id").value.trim();
    // Accept a pasted URL as readily as a bare ID — on draft day you copy the address bar.
    const id = (raw.match(/(\d{8,})/) ?? [])[1];
    if (!id) { sync.err = "need a numeric draft ID"; paintSyncStatus(); return; }
    $("#draft-id").value = id;
    connect(id);
  });
  $("#draft-id").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#lsync-btn").click(); });

  /* ---------- boot ---------- */
  (async () => {
    try {
      const r = await fetch(C.DRAFT_BOARD_JSON, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      board = await r.json();
    } catch (e) {
      $("#board-body").innerHTML = `<div class="panel-error" role="alert">Draft board unavailable (${esc(e.message)}). Run node scripts/build-draft-board.mjs and publish — nothing is shown rather than invented data.</div>`;
      $("#board-meta").textContent = "no data";
      paintTargets();   // rail renders its empty state rather than sitting as a blank box
      return;
    }
    rows = rank(board.players.map(compute));
    if (replInput) replInput.value = replBasis;
    $("#draft-slot").value = draftSlot ?? "";
    updateKnobReadouts();
    $("#board-meta").textContent = `board ${board.generated} · ${rows.length} players · ADP as of ${board.generated}`;
    paint();
    syncToolbarH(); // board is now in flow; lock the header offset to the settled toolbar height

    // Reconnect to whatever draft you were on. Draft day means reloads — a dropped tab shouldn't
    // cost you the sync. ?draft=<id> in the URL wins, so pointing at a mock needs no config edit.
    const urlId = (new URLSearchParams(location.search).get("draft") ?? "").match(/\d{8,}/)?.[0];
    const savedId = localStorage.getItem(SYNC_KEY);
    const bootId = urlId ?? savedId;
    if (bootId) { $("#draft-id").value = bootId; await connect(bootId); }
  })();
})();
