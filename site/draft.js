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

  const LS_KEY = "hq-draft-2026-taken";
  const taken = new Set(JSON.parse(localStorage.getItem(LS_KEY) ?? "[]"));
  const saveTaken = () => localStorage.setItem(LS_KEY, JSON.stringify([...taken]));

  const KNOB_KEY = "hq-draft-2026-knobs";
  const savedKnobs = JSON.parse(localStorage.getItem(KNOB_KEY) ?? "{}");
  const saveKnobs = () => localStorage.setItem(KNOB_KEY, JSON.stringify({ replBasis }));

  let board = null, rows = [];
  let pos = "ALL", view = "board", sort = "draftval", hideDrafted = false, hideFlagged = false;
  let replBasis = savedKnobs.replBasis ?? 0;  // 0 = starter basis (default), 1 = rostered (best-FA)
  let expandedId = null; // single-row accordion

  /* ---------- the value engine (transparent, in one place) ---------- */
  // Replacement (scarcity) line per position; the knob slides between the STARTER line
  // (last weekly starter — default) and the ROSTERED line (last rostered / best free agent).
  const STARTER_RANK = { QB: 11, RB: 30, WR: 32, TE: 11, K: 11, DEF: 11 };
  const ROSTERED_RANK = { QB: 13, RB: 46, WR: 47, TE: 13, K: 11, DEF: 11 };
  const replRankFor = (ps, t) => Math.max(1, Math.round(STARTER_RANK[ps] + (ROSTERED_RANK[ps] - STARTER_RANK[ps]) * t));
  // Light playing-time model (Q3): median stays near-full; only documented injury/age move it.
  // The uncertainty BAND (Phase B) carries the risk — this is deliberately gentle.
  const AGE_CLIFF = { RB: 28, WR: 31, TE: 31, QB: 37, K: 99, DEF: 99 };
  const BUDGET = 200, TEAMS = 10, ROSTER_SPOTS = 15;   // auction $ scale (relative; snake uses $ as linear currency)
  const EDGE_TARGET = 4, EDGE_FADE = -4;               // $ edge thresholds for TARGET / FADE (tunable)
  const FADE_ADP = 110, PICK_FADE = -25;               // sub-$1 FADE: market drafts a below-replacement player inside pick ~110 AND ≥25 picks earlier than the board ranks him
  const BC_DIVERGE = 15;                               // BC contradicts an actionable rec by ≥ this many ranks = caution note
  let replAsset = {}, replRankUsed = {}, ceilAvg = {}, dollarAtRank = [];

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
      if (p.draftRank != null) {
        const gap = bc.rank - p.draftRank; // + = board more bullish than experts
        const contra = (p.rec === "TARGET" && gap >= BC_DIVERGE) || (p.rec === "FADE" && -gap >= BC_DIVERGE);
        if (contra) { const o = Math.abs(gap) >= 30 ? "high" : "some"; if (SEV[o] < SEV[d]) d = o; }
      }
      dis = d;
    }
    const assetSev = Math.min(SEV[ptRisk], SEV[dis]);
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
      if (assetLevel < edgeStrength) capped = assetConf === "Low"
        ? (ptRisk === "high" ? "playing-time / role risk" : "you're the outlier vs consensus")
        : "moderate asset uncertainty";
    }
    return { assetConf, ptRisk, dis, gLow, gHigh, bandLow, bandHigh, recConf, capped, rookie, injuredNow };
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
    // ③ market edge: your $ vs the $ of the player's ADP slot
    for (const p of list) {
      const adp = p.adp?.half_ppr;
      p.marketDollar = adp != null ? (dollarAtRank[Math.min(dollarAtRank.length, Math.round(adp)) - 1] ?? 1) : null;
      p.edgeDollar = p.marketDollar != null && p.draftDollar != null ? p.draftDollar - p.marketDollar : null;
      p.edgePicks = adp != null && p.draftRank != null ? +(adp - p.draftRank).toFixed(1) : null;
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
  const edgeStr = (e) => { if (e == null) return "–"; const r = Math.round(e); return r === 0 ? "$0" : (r > 0 ? "+$" : "−$") + Math.abs(r); }; // round: a boundary player's sub-dollar market gap reads $0 (fair), not "+$0.04"
  const fmtD = (d) => d == null ? "–" : d >= 1 ? `$${d}` : `$${d.toFixed(2)}`;   // ≥$1 = integer price; <$1 = proximity score

  function rowHTML(p, rankLabel) {
    const isTaken = taken.has(p.id);
    const isOpen = expandedId === p.id;
    const rec = p.rec, conf = p.conf, adp = p.adp?.half_ppr;
    const sub = p.draftDollar != null && p.draftDollar < 1;          // below the $1 line = proximity/bench tier
    const recCls = rec === "TARGET" ? "rec-target" : rec === "FADE" ? "rec-fade" : rec === "FAIR" ? "rec-fair" : "";
    const nameCls = rec === "TARGET" ? "name-value" : rec === "FADE" ? "name-reach" : "";
    const showRec = rec === "TARGET" || rec === "FADE" || (rec === "FAIR" && !sub); // suppress the FAIR badge in the bench tier
    const edgeCls = rec === "TARGET" ? "gap-value" : rec === "FADE" ? "gap-reach" : "gap-fair";
    // edge column: $-edge above $1; the board-vs-ADP pick-gap (disparity) below
    const edgeTxt = sub ? (p.edgePicks == null ? "–" : `${p.edgePicks > 0 ? "+" : ""}${Math.round(p.edgePicks)}p`) : edgeStr(p.edgeDollar);
    const edgeTitle = p.edgeDollar == null ? "no ADP to compare"
      : sub ? `Board ranks him #${p.draftRank}; market ADP ${adp} → the market is ${Math.abs(Math.round(p.edgePicks))} picks ${p.edgePicks < 0 ? "HIGHER" : "lower"} on him. A projection-based board is conservative on late-round upside — check ceiling before acting.${rec === "FADE" ? ` FADE: the market spends an early pick (≤${FADE_ADP}) on a below-replacement projection.` : ""}`
      : `You value him ${fmtD(p.draftDollar)}; the market's ADP slot (pick ${adp}) is worth ${fmtD(p.marketDollar)} → ${p.edgeDollar > 0 ? "UNDER" : p.edgeDollar < 0 ? "OVER" : "fairly"}valued by ${edgeStr(p.edgeDollar)} (${p.edgePicks > 0 ? "+" : ""}${Math.round(p.edgePicks)} picks)${conf?.recConf ? ` · rec-confidence ${CONF_LABEL[conf.recConf - 1]}${conf.capped ? ` (capped: ${conf.capped})` : ""}` : ""}`;
    const bc = p.fftiers;
    const bcTxt = bc ? `${bc.rank}<span class="bctier">T${bc.tier}</span>` : "–";
    const bcTitle = bc ? `Boris Chen half-PPR consensus: overall #${bc.rank}, tier ${bc.tier} (avg ${bc.avg_rank}, range ${bc.best_rank}-${bc.worst_rank})` : "not in fftiers top-200";
    const cl = p.ceiling, clr = p.ceilRatio;
    const clCls = clr == null ? "" : clr >= 1.5 ? "ceil-boom" : clr <= 0.6 ? "ceil-steady" : "";
    const clArrow = clr == null ? "" : clr >= 1.5 ? "▲" : clr <= 0.6 ? "▾" : "";
    const clTxt = cl ? `${Math.round(cl.spike_week_rate * 100)}%${clArrow}` : "–";
    const clTitle = cl ? `Spike-week rate: ${Math.round(cl.spike_week_rate * 100)}% of ${cl.sample_weeks} games at/above the ${p.pos} top-5 weekly line (${cl.boom_line} pts). Boom ~${cl.boom_pts}, floor ~${cl.floor_pts}${clr != null ? `; ${clr}× the board's ${p.pos} average` : ""}. Separate attribute — not in value.` : "no weekly ceiling data (rookie / <10 career games)";
    const badges = [
      showRec ? `<span class="recbadge ${recCls}" title="${esc(edgeTitle)}">${rec}${conf?.recConf ? ` <span class="confdots" title="rec-confidence ${CONF_LABEL[conf.recConf - 1]}">${CONF_DOTS[conf.recConf - 1]}</span>` : ""}</span>` : "",
      ...p.flagged.map((f) => badge(f.slice(0, 3).toUpperCase(), "rbadge-risk", `${f} risk — see detail`)),
      p.unvetted ? badge("unvetted", "rbadge-unvetted", "Risk flags not yet researched — null, not clean") : "",
    ].join("");
    return `
    <div class="drow ${isTaken ? "taken" : ""}" data-id="${p.id}">
      <button class="take" data-act="take" aria-pressed="${isTaken}" title="${isTaken ? "Mark available" : "Mark drafted"}">${isTaken ? "✓" : ""}</button>
      <button class="dmain" data-act="expand" aria-expanded="${isOpen}">
        <span class="dr">${rankLabel}</span>
        <span class="dname ${nameCls}">${esc(p.name)}</span>
        <span class="dpos">${esc(p.pos)}${p.posRank ? p.posRank : ""} · ${esc(p.team)}</span>
        ${badges}
        <span class="dval mono" title="${sub ? "proximity-to-rosterable score (below the $1 startable line — a differentiation score, not a price)" : "draft value — scarcity-aware auction $"}">${fmtD(p.draftDollar)}</span>
        <span class="dadp mono" title="ADP (half-PPR)">${p.adp?.half_ppr ?? "–"}</span>
        <span class="dgap mono ${edgeCls}" title="${esc(edgeTitle)}">${edgeTxt}</span>
        <span class="dbc mono" title="${esc(bcTitle)}">${bcTxt}</span>
        <span class="dceil mono ${clCls}" title="${esc(clTitle)}">${clTxt}</span>
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

  function detailHTML(p) {
    const a = p.availability ?? {};
    const gp = a.games_played ?? {};
    const facts = p.situation?.facts ?? [];
    const notes = p.risk_flags?.notes ?? [];
    return `<div class="ddetail">
      ${p.adp_commentary ? `<div class="dcommentary"><b>Why here at ${esc(p.pos)}:</b> ${esc(p.adp_commentary)}</div>` : ""}
      ${edgeExplainer(p)}
      <div class="dcol">
        <h4>Value <span class="faint">(Phase A · $-engine)</span></h4>
        <div><b>Sleeper proj:</b> ${p.projection?.pts ?? "–"} pts <span class="faint">(full-health season)</span></div>
        <div><b>asset:</b> ${p.rate ?? "–"}/g rate × ${p.medianGames} median games = <b>${p.assetPts ?? "–"}</b> pts</div>
        <div><b>draft value:</b> <b>${fmtD(p.draftDollar)}</b> <span class="faint">${p.draftDollar != null && p.draftDollar < 1 ? "(proximity score — below the $1 startable line)" : `(${p.marginal ?? "–"} over free ${esc(p.pos)}${replRankUsed[p.pos] ?? "?"} @ ${replAsset[p.pos] ?? "?"})`}</span></div>
        <div><b>market:</b> ${fmtD(p.marketDollar)} at ADP ${p.adp?.half_ppr ?? "–"} → <b>edge ${p.draftDollar != null && p.draftDollar < 1 ? (p.edgePicks == null ? "–" : (p.edgePicks > 0 ? "+" : "") + Math.round(p.edgePicks) + "p") : edgeStr(p.edgeDollar)}</b> (${p.edgePicks == null ? "–" : (p.edgePicks > 0 ? "+" : "") + Math.round(p.edgePicks) + " picks"})</div>
        <div><b>recommendation:</b> <b class="${p.rec === "TARGET" ? "name-value" : p.rec === "FADE" ? "name-reach" : ""}">${p.rec ?? "–"}</b>${p.conf?.recConf ? ` · confidence ${CONF_LABEL[p.conf.recConf - 1]} <span class="confdots">${CONF_DOTS[p.conf.recConf - 1]}</span>${p.conf.capped ? ` <span class="faint">(capped: ${p.conf.capped})</span>` : ""}` : ""}</div>
        <div><b>asset confidence:</b> ${p.conf?.assetConf ?? "–"} <span class="faint">· band ${fmtD(p.conf?.bandLow)}–${fmtD(p.conf?.bandHigh)} · PT ${p.conf?.gLow ?? "–"}–${p.conf?.gHigh ?? "–"} games · disagreement ${p.conf?.dis ?? "–"}</span></div>
        <h4>Boris Chen (fftiers)</h4>
        ${p.fftiers ? `<div><b>consensus rank:</b> #${p.fftiers.rank} · tier ${p.fftiers.tier}</div>
        <div><b>expert avg:</b> ${p.fftiers.avg_rank} <span class="faint">(range ${p.fftiers.best_rank}–${p.fftiers.worst_rank}, std ${p.fftiers.std_dev})</span></div>
        <div class="faint">FantasyPros consensus, GMM tiers, half-PPR · as of ${esc(board.fftiers?.updated ?? "?")}</div>`
          : `<div>${noData} — not in Boris Chen's top-200 (free agent or deep)</div>`}
        <h4>Ceiling (spike weeks) <span class="faint">— separate attribute, not in value</span></h4>
        ${p.ceiling ? `<div><b>spike-week rate:</b> ${Math.round(p.ceiling.spike_week_rate * 100)}% <span class="faint">of ${p.ceiling.sample_weeks} games${p.ceilRatio != null ? ` · ${p.ceilRatio}× ${esc(p.pos)} avg` : ""}</span></div>
        <div><b>boom / floor week:</b> ${p.ceiling.boom_pts} / ${p.ceiling.floor_pts} pts <span class="faint">(${esc(p.pos)} top-5 line ${p.ceiling.boom_line})</span></div>`
          : `<div>${noData} — rookie / &lt;10 career games</div>`}
      </div>
      <div class="dcol">
        <h4>Availability <span class="faint">— feeds median games (lightly) + the uncertainty band</span></h4>
        <div><b>median games used:</b> ${p.medianGames} <span class="faint">of 17</span></div>
        <div><b>games played:</b> ${["2023", "2024", "2025"].map((y) => `${y}: ${gp[y] ?? "–"}`).join(" · ")}</div>
        <div><b>age:</b> ${a.age ?? p.age ?? "–"} · <b>status:</b> ${esc(a.current_injury_status ?? "healthy/none")}</div>
        <div><b>injury history:</b> ${a.injury_history == null ? noData + ' <span class="faint">(research pending)</span>' : esc(a.injury_history)}</div>
      </div>
      <div class="dcol">
        <h4>Situation ${p.situation?.modifier == null ? noData : `×${p.situation.modifier}`}</h4>
        ${facts.length ? facts.map((f) => `<div class="fact">${esc(f.date)} <span class="ftype">${esc(f.type)}</span> ${esc(f.fact)}${f.source ? ` <a href="${esc(f.source)}" target="_blank" rel="noopener">src</a>` : ""}</div>`).join("") : `<div>${noData} — no curated facts touch this player yet</div>`}
        <h4>Risk flags</h4>
        <div>${p.risk_flags.researched === false ? `${noData} — not yet researched (null ≠ clean)` :
          p.flagged.length ? `<b class="flagged-txt">${p.flagged.map(esc).join(", ")}</b>` : "researched: clean"}</div>
        ${notes.map((n) => `<div class="fact faint">• ${esc(n)}</div>`).join("")}
      </div>
      <div class="dcontext">
        <span class="ctxlabel">context <span class="faint">— display only, never affects the value number</span></span>
        ${[["contract_year", "contract yr"], ["rookie_capital", "draft capital"], ["team_win_total", "team win total"], ["playoff_sos", "playoff SOS"]]
          .map(([k, lab]) => `<span class="ctxitem"><b>${lab}:</b> ${p.context?.[k] == null ? '<span class="nodata">pending</span>' : esc(String(p.context[k]))}</span>`).join("")}
      </div>
    </div>`;
  }

  const headerHTML = `
    <div class="drow dhead" aria-hidden="true">
      <span></span>
      <span class="dmain-head"><span class="dr">#</span><span class="dname">player</span><span class="dpos">pos</span>
      <span class="dval">$val</span><span class="dadp">adp</span><span class="dgap">edge</span><span class="dbc">BC</span><span class="dceil">ceil</span></span>
    </div>`;

  /* ---------- views ---------- */
  function visible() {
    let list = rows;
    if (pos !== "ALL") list = list.filter((p) => p.pos === pos);
    if (hideDrafted) list = list.filter((p) => !taken.has(p.id));
    if (hideFlagged) list = list.filter((p) => !p.flagged.length);
    return list;
  }

  function paint() {
    const list = visible();
    if (view === "board") {
      const sortLabel = { draftval: "by draft $", edge: "by edge", adp: "by ADP", bc: "by Boris Chen" }[sort] ?? "by draft $";
      $("#board-title").textContent = (pos === "ALL" ? "Value board" : `Value board — ${pos}`) + " · " + sortLabel;
      const sortFns = {
        adp: (a, b) => (a.adp?.half_ppr ?? Infinity) - (b.adp?.half_ppr ?? Infinity),
        bc: (a, b) => (a.fftiers?.rank ?? Infinity) - (b.fftiers?.rank ?? Infinity),
        draftval: (a, b) => (b.draftDollar ?? -1) - (a.draftDollar ?? -1),
        edge: (a, b) => (b.edgeDollar ?? -Infinity) - (a.edgeDollar ?? -Infinity),
      };
      const sorted = [...list].sort(sortFns[sort] ?? sortFns.draftval);
      $("#board-body").innerHTML = headerHTML +
        sorted.map((p) => rowHTML(p, p.draftRank ?? "–")).join("") +
        `<div class="boardfoot">$val: <b>≥$1</b> = auction price · <b>&lt;$1</b> = proximity-to-rosterable score (differentiates the bench) · edge: $-gap above $1, board-vs-ADP pick-gap (<b>Np</b>) below · <span class="name-value">TARGET</span>/<span class="name-reach">FADE</span> + confidence dots ●●●. Bench tier gets no TARGET — lean on the <b>ceil</b> column for upside. # = draft-value rank.</div>`;
    } else {
      $("#board-title").textContent = "Tiers — cliff edges (by draft $)";
      const posList = pos === "ALL" ? ["RB", "WR", "QB", "TE", "K", "DEF"] : [pos];
      $("#board-body").innerHTML = posList.map((ps) => {
        const tiers = tiersFor(list.filter((p) => p.pos === ps));
        return tiers.map((tier, i) => `
          <div class="tierhead"><span>${ps} · Tier ${i + 1}</span><span class="faint">${tier.length} players</span></div>
          ${headerHTML}
          ${tier.map((p, j) => rowHTML(p, `${ps}${p.posRank}`) + (j === tier.length - 1 ? '<div class="cliff">▼ value cliff</div>' : "")).join("")}
        `).join("");
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
      taken.has(id) ? taken.delete(id) : taken.add(id);
      saveTaken();
    } else if (act.dataset.act === "expand") {
      expandedId = expandedId === id ? null : id;
    }
    paint();
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
    if (taken.size && confirm(`Clear ${taken.size} drafted marks?`)) { taken.clear(); saveTaken(); paint(); }
  });

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

  /* ---------- boot ---------- */
  (async () => {
    try {
      const r = await fetch(C.DRAFT_BOARD_JSON, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      board = await r.json();
    } catch (e) {
      $("#board-body").innerHTML = `<div class="panel-error" role="alert">Draft board unavailable (${esc(e.message)}). Run node scripts/build-draft-board.mjs and publish — nothing is shown rather than invented data.</div>`;
      $("#board-meta").textContent = "no data";
      return;
    }
    rows = rank(board.players.map(compute));
    if (replInput) replInput.value = replBasis;
    updateKnobReadouts();
    $("#board-meta").textContent = `board ${board.generated} · ${rows.length} players · ADP as of ${board.generated}`;
    paint();
  })();
})();
