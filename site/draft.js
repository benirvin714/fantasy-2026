/* HBGBs Draft Day — pre-season value board. Reads data/site/draft-board.json (shared data
   layer). Composite value = projection.pts × availability.score × situation.modifier, with
   null components treated as neutral 1 but ALWAYS surfaced as "no data" — never invented.
   Risk flags are badges that cap enthusiasm; they never adjust the score.
   Drafted/available state lives in localStorage (survives reloads; this browser only). */
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
  const saveKnobs = () => localStorage.setItem(KNOB_KEY, JSON.stringify({ replBasis, ceilTilt }));

  let board = null, rows = [];
  let pos = "ALL", view = "board", sort = "value", hideDrafted = false, hideFlagged = false;
  let replBasis = savedKnobs.replBasis ?? 0;  // 0 = starter basis (fixed replacement), 1 = rostered (best-FA)
  let ceilTilt = savedKnobs.ceilTilt ?? 0;    // 0 = pure mean-VORP; >0 blends spike-week upside into value
  let expandedId = null; // single-row accordion: only one detail open at a time

  /* ---------- value math (transparent, in one place) ----------
     Cross-positional value MUST be VORP, not raw points: in this league QB13-16,
     TE12-15, RB/WR streamers and streamable K/DEF sit on waivers all season
     (league-profile.md), so draft value is points OVER that free replacement.
     Replacement = "the streamer you'd actually start." The replacement-basis knob
     slides each position's rank between the STARTER line (last weekly starter — the
     fix; avoids Sleeper's backup-RB≈0 projections dragging the RB baseline down and
     inflating RB VORP) and the ROSTERED line (last rostered / best free agent — the
     old basis). t=0 => starters (default), t=1 => rostered. */
  const STARTER_RANK = { QB: 11, RB: 30, WR: 32, TE: 11, K: 11, DEF: 11 };
  const ROSTERED_RANK = { QB: 13, RB: 46, WR: 47, TE: 13, K: 11, DEF: 11 };
  const replRankFor = (ps, t) => Math.max(1, Math.round(STARTER_RANK[ps] + (ROSTERED_RANK[ps] - STARTER_RANK[ps]) * t));
  let replPts = {}, replRankUsed = {}, ceilAvg = {}; // all computed from the board itself
  // ceiling-tilt factor: blends spike-week upside into value. ratio = player's spike
  // rate vs the board's positional average, clamped [0.5, 2]; tilt 0 => factor 1.
  const ceilFactor = (p) => {
    if (!ceilTilt || !p.ceiling || !ceilAvg[p.pos]) return 1;
    const ratio = Math.max(0.5, Math.min(2, p.ceiling.spike_week_rate / ceilAvg[p.pos]));
    return 1 + ceilTilt * (ratio - 1);
  };

  function compute(p) {
    const avail = p.availability?.score;   // null => neutral, flagged "no data"
    const situ = p.situation?.modifier;    // null => neutral, flagged "no data"
    const flags = p.risk_flags ?? {};
    const flagged = ["suspension", "contract", "legal"].filter((k) => flags[k] === true);
    const unvetted = flags.researched === false;
    return { ...p, availMissing: avail == null, situMissing: situ == null, flagged, unvetted };
  }

  function rank(list) {
    // replacement level = projection of the (knob-selected) replacement-rank player per position
    for (const ps of Object.keys(STARTER_RANK)) {
      const posSorted = list.filter((p) => p.pos === ps && p.projection?.pts != null)
        .sort((a, b) => b.projection.pts - a.projection.pts);
      const n = replRankFor(ps, replBasis);
      replRankUsed[ps] = n;
      replPts[ps] = posSorted[Math.min(n, posSorted.length) - 1]?.projection.pts ?? 0;
    }
    // board-relative positional average spike rate = denominator for the ceiling ratio/badge
    for (const ps of Object.keys(STARTER_RANK)) {
      const rates = list.filter((p) => p.pos === ps && p.ceiling).map((p) => p.ceiling.spike_week_rate);
      ceilAvg[ps] = rates.length ? +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(3) : null;
    }
    for (const p of list) {
      if (p.projection?.pts == null) { p.value = p.valueBase = null; p.ceilRatio = null; continue; }
      const vorp = p.projection.pts - (replPts[p.pos] ?? 0);
      p.valueBase = +(vorp * (p.availability?.score ?? 1) * (p.situation?.modifier ?? 1)).toFixed(1);
      p.value = +(p.valueBase * ceilFactor(p)).toFixed(1);
      p.ceilRatio = (p.ceiling && ceilAvg[p.pos]) ? +(p.ceiling.spike_week_rate / ceilAvg[p.pos]).toFixed(2) : null;
    }
    const byValue = [...list].filter((p) => p.value != null).sort((a, b) => b.value - a.value);
    byValue.forEach((p, i) => { p.valueRank = i + 1; });
    const posCount = {};
    for (const p of byValue) { posCount[p.pos] = (posCount[p.pos] ?? 0) + 1; p.posRank = posCount[p.pos]; }
    for (const p of list) p.gap = p.adp?.half_ppr != null && p.valueRank != null
      ? +(p.adp.half_ppr - p.valueRank).toFixed(1) : null;
    return list;
  }

  /* ---------- tiers: natural breaks within position by value ---------- */
  function tiersFor(list) {
    const sorted = [...list].filter((p) => p.value != null).sort((a, b) => b.value - a.value);
    const tiers = [];
    let cur = [];
    for (const p of sorted) {
      if (cur.length) {
        const drop = cur[cur.length - 1].value - p.value;
        // threshold relative to the CURRENT tier's leader so mid-range flat zones
        // still split; hard cap so no tier balloons past scannable size
        const threshold = Math.max(4, Math.abs(cur[0].value) * 0.08);
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

  function rowHTML(p, rankLabel) {
    const isTaken = taken.has(p.id);
    const isOpen = expandedId === p.id;
    const gapCls = p.gap == null ? "" : p.gap >= 5 ? "gap-value" : p.gap <= -5 ? "gap-reach" : "gap-fair";
    const nameCls = p.gap == null ? "" : p.gap >= 5 ? "name-value" : p.gap <= -5 ? "name-reach" : "";
    const gapTxt = p.gap == null ? "–" : (p.gap > 0 ? "+" : "") + Math.round(p.gap);
    const bc = p.fftiers;
    const bcTxt = bc ? `${bc.rank}<span class="bctier">T${bc.tier}</span>` : "–";
    const bcTitle = bc ? `Boris Chen half-PPR consensus: overall #${bc.rank}, tier ${bc.tier} (avg ${bc.avg_rank}, range ${bc.best_rank}-${bc.worst_rank})` : "not in fftiers top-200";
    const cl = p.ceiling, clr = p.ceilRatio;
    const clCls = clr == null ? "" : clr >= 1.5 ? "ceil-boom" : clr <= 0.6 ? "ceil-steady" : "";
    const clArrow = clr == null ? "" : clr >= 1.5 ? "▲" : clr <= 0.6 ? "▾" : "";
    const clTxt = cl ? `${Math.round(cl.spike_week_rate * 100)}%${clArrow}` : "–";
    const clTitle = cl ? `Spike-week rate: ${Math.round(cl.spike_week_rate * 100)}% of ${cl.sample_weeks} games (2023-25) at/above the ${p.pos} top-5 weekly line (${cl.boom_line} pts). Boom week ~${cl.boom_pts}, floor ~${cl.floor_pts}${clr != null ? `; ${clr}× the board's ${p.pos} average` : ""}.` : "no weekly ceiling data (rookie / <10 career games)";
    const badges = [
      ...p.flagged.map((f) => badge(f.slice(0, 3).toUpperCase(), "rbadge-risk", `${f} risk — see detail`)),
      p.unvetted ? badge("unvetted", "rbadge-unvetted", "Risk flags not yet researched — null, not clean") : "",
      p.availMissing ? badge("avail: no data", "rbadge-nodata", "No NFL history (rookie) or no availability inputs") : "",
    ].join("");
    return `
    <div class="drow ${isTaken ? "taken" : ""}" data-id="${p.id}">
      <button class="take" data-act="take" aria-pressed="${isTaken}" title="${isTaken ? "Mark available" : "Mark drafted"}">${isTaken ? "✓" : ""}</button>
      <button class="dmain" data-act="expand" aria-expanded="${isOpen}">
        <span class="dr">${rankLabel}</span>
        <span class="dname ${nameCls}">${esc(p.name)}</span>
        <span class="dpos">${esc(p.pos)}${p.posRank ? p.posRank : ""} · ${esc(p.team)}</span>
        ${badges}
        <span class="dval mono">${p.value ?? "–"}</span>
        <span class="dadp mono" title="ADP (half-PPR, ${esc(board.players ? p.adp?.updated : "")})">${p.adp?.half_ppr ?? "–"}</span>
        <span class="dgap mono ${gapCls}">${gapTxt}</span>
        <span class="dbc mono" title="${esc(bcTitle)}">${bcTxt}</span>
        <span class="dceil mono ${clCls}" title="${esc(clTitle)}">${clTxt}</span>
      </button>
      ${isOpen ? detailHTML(p) : ""}
    </div>`;
  }

  // Transparent, computed decomposition of how value/placement is derived and why the ADP gap exists.
  // Uses only numbers already in the data — consistent for all 248 players, never fabricated.
  function gapExplainer(p) {
    if (p.value == null) return `<div class="gapexp"><b>No gap:</b> no projection for this player, so no value rank (shows ${noData}).</div>`;
    const repl = replPts[p.pos], replRank = replRankUsed[p.pos];
    const rawVorp = +(p.projection.pts - repl).toFixed(1);
    const avail = p.availability?.score, situ = p.situation?.modifier;
    const availTxt = avail == null ? "×1 (no availability data — rookie/no history, so NO injury discount)" : `×${avail} availability`;
    const situTxt = situ == null ? "×1 (no situation modifier)" : `×${situ} situation`;
    const adp = p.adp?.half_ppr;
    let verdict;
    if (p.gap == null) verdict = `<b>Gap: —</b> no ADP for this player, so nothing to compare.`;
    else if (p.gap >= 5) verdict = `<b class="name-value">Bargain (+${Math.round(p.gap)}):</b> the market drafts him around pick <b>${adp}</b> — about ${Math.round(p.gap)} slots <b>later</b> than the board's value rank (<b>#${p.valueRank}</b>). He tends to be available after his value says he's worth taking.`;
    else if (p.gap <= -5) verdict = `<b class="name-reach">Reach (${Math.round(p.gap)}):</b> the market drafts him around pick <b>${adp}</b> — about ${Math.abs(Math.round(p.gap))} slots <b>earlier</b> than the board's value rank (<b>#${p.valueRank}</b>). Taking him at ADP means paying above the board's price.`;
    else verdict = `<b>Fair:</b> market ADP <b>${adp}</b> ≈ board value rank <b>#${p.valueRank}</b> — priced about where the board values him.`;
    const drivers = [];
    if (avail != null && avail < 0.95) drivers.push(`his availability score (${avail}) trims the projection ~${Math.round((1 - avail) * 100)}% for injury/age history, pulling value below raw points`);
    if (avail == null && p.projection.pts != null) drivers.push(`as a rookie he gets no availability haircut (×1), so his value is pure projection — which can rank him above veterans who are docked for injury history`);
    if (situ != null && situ !== 1) drivers.push(`a situation modifier (×${situ}) adjusts for a team/scheme change`);
    if (["QB", "TE", "K", "DEF"].includes(p.pos)) drivers.push(`at ${p.pos}, replacement is deep — the freely-available ${p.pos}${replRank} already projects ${repl} pts, so even a big raw projection leaves only modest value OVER replacement. This is why elite ${p.pos}s rank lower here than their raw points suggest, and why the market (which drafts on name/points) reaches for them`);
    const driverTxt = drivers.length ? `<div class="gapdriver">Why the gap: ${drivers.join("; ")}.</div>` : "";
    return `<div class="gapexp">
      <b>How this value is built:</b> ${p.projection.pts} projected pts − ${repl} replacement (free ${esc(p.pos)}${replRank}) = ${rawVorp} raw VORP, then ${availTxt} ${situTxt} = <b>${p.value} value</b> → <b>#${p.valueRank}</b> overall.
      <div class="gapverdict">${verdict}</div>
      ${driverTxt}
    </div>`;
  }

  function detailHTML(p) {
    const a = p.availability ?? {};
    const gp = a.games_played ?? {};
    const facts = p.situation?.facts ?? [];
    const notes = p.risk_flags?.notes ?? [];
    return `<div class="ddetail">
      ${p.adp_commentary ? `<div class="dcommentary"><b>Why here at ${esc(p.pos)}:</b> ${esc(p.adp_commentary)}</div>` : ""}
      ${gapExplainer(p)}
      <div class="dcol">
        <h4>Projection</h4>
        <div><b>league pts:</b> ${p.projection.pts ?? "–"} (${p.projection.ppg ?? "–"}/g)</div>
        <div><b>value:</b> ${p.value ?? "–"} <span class="faint">(VORP over free ${esc(p.pos)}${replRankUsed[p.pos] ?? "?"} @ ${replPts[p.pos] ?? "?"} pts × avail × situation${ceilTilt && p.valueBase != null && p.value !== p.valueBase ? ` · ceiling-tilt ${p.valueBase}→${p.value}` : ""})</span></div>
        <div><b>method:</b> ${esc(p.projection.method)}</div>
        <div><b>sleeper half-PPR anchor:</b> ${p.projection.sleeper_half_ppr ?? "–"}</div>
        <div><b>ADP:</b> ${p.adp?.half_ppr ?? "–"} <span class="faint">(as of ${esc(p.adp?.updated ?? "?")})</span></div>
        <h4>Boris Chen (fftiers)</h4>
        ${p.fftiers ? `<div><b>consensus rank:</b> #${p.fftiers.rank} · tier ${p.fftiers.tier}</div>
        <div><b>expert avg:</b> ${p.fftiers.avg_rank} <span class="faint">(range ${p.fftiers.best_rank}–${p.fftiers.worst_rank}, std ${p.fftiers.std_dev})</span></div>
        <div class="faint">FantasyPros consensus, GMM-clustered tiers, half-PPR · as of ${esc(board.fftiers?.updated ?? "?")}</div>`
          : `<div>${noData} — not in Boris Chen's top-200 (free agent or deep)</div>`}
        <h4>Ceiling (spike weeks)</h4>
        ${p.ceiling ? `<div><b>spike-week rate:</b> ${Math.round(p.ceiling.spike_week_rate * 100)}% <span class="faint">of ${p.ceiling.sample_weeks} games${p.ceilRatio != null ? ` · ${p.ceilRatio}× ${esc(p.pos)} avg` : ""}</span></div>
        <div><b>boom / floor week:</b> ${p.ceiling.boom_pts} / ${p.ceiling.floor_pts} pts <span class="faint">(${esc(p.pos)} top-5 line ${p.ceiling.boom_line})</span></div>
        <div class="faint">${esc(p.ceiling.method)}${ceilTilt ? ` · tilt ${Math.round(ceilTilt * 100)}% applied` : " · tilt off (display only)"}</div>`
          : `<div>${noData} — rookie / &lt;10 career games, no stable spike-rate</div>`}
      </div>
      <div class="dcol">
        <h4>Availability</h4>
        <div><b>score:</b> ${a.score ?? noData} ${a.partial ? '<span class="faint">(injury-type component missing)</span>' : ""}</div>
        <div><b>expected games:</b> ${a.expected_games ?? noData}</div>
        <div><b>games played:</b> ${["2023", "2024", "2025"].map((y) => `${y}: ${gp[y] ?? "–"}`).join(" · ")}</div>
        <div><b>age:</b> ${a.age ?? "–"} (curve ×${a.age_factor ?? "–"}) · <b>status:</b> ${esc(a.current_injury_status ?? "healthy/none")}</div>
        <div><b>injury history:</b> ${a.injury_history == null ? noData + ' <span class="faint">(research pass pending)</span>' : esc(a.injury_history)}</div>
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
      <span class="dval">value</span><span class="dadp">adp</span><span class="dgap">gap</span><span class="dbc">BC</span><span class="dceil">ceil</span></span>
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
      const sortLabel = { value: "by value", adp: "by ADP", bc: "by Boris Chen rank" }[sort] ?? "by value";
      $("#board-title").textContent = (pos === "ALL" ? "Value board" : `Value board — ${pos}`) + " · " + sortLabel;
      const sortFns = {
        adp: (a, b) => (a.adp?.half_ppr ?? Infinity) - (b.adp?.half_ppr ?? Infinity),
        bc: (a, b) => (a.fftiers?.rank ?? Infinity) - (b.fftiers?.rank ?? Infinity),
        value: (a, b) => (b.value ?? -1) - (a.value ?? -1),
      };
      const sorted = [...list].sort(sortFns[sort] ?? sortFns.value);
      $("#board-body").innerHTML = headerHTML +
        sorted.map((p) => rowHTML(p, p.valueRank ?? "–")).join("") +
        `<div class="boardfoot">gap = ADP − value rank · name in <span class="name-value">light&nbsp;blue</span> = market prices them later than their value (bargain, +gap) · <span class="name-reach">red</span> = priced above value (reach, −gap). # column is value rank in both sorts.</div>`;
    } else {
      $("#board-title").textContent = "Tiers — cliff edges";
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

  /* ---------- events (delegated; state never lost to reloads) ---------- */
  $("#board-body").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const id = act.closest(".drow")?.dataset.id;
    if (!id) return;
    if (act.dataset.act === "take") {
      taken.has(id) ? taken.delete(id) : taken.add(id);
      saveTaken();
    } else if (act.dataset.act === "expand") {
      expandedId = expandedId === id ? null : id; // open this row, closing any other
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

  /* ---------- value knobs (replacement basis + ceiling tilt) ---------- */
  function updateKnobReadouts() {
    const rb = $("#repl-basis-val"), ct = $("#ceil-tilt-val");
    if (rb) rb.textContent = replBasis <= 0 ? `starters (RB${replRankFor("RB", 0)}·WR${replRankFor("WR", 0)})`
      : replBasis >= 1 ? `rostered (RB${replRankFor("RB", 1)}·WR${replRankFor("WR", 1)})`
      : `RB${replRankFor("RB", replBasis)}·WR${replRankFor("WR", replBasis)}`;
    if (ct) ct.textContent = ceilTilt ? `${Math.round(ceilTilt * 100)}% ceiling` : "off (mean)";
  }
  const replInput = $("#repl-basis"), ceilInput = $("#ceil-tilt");
  if (replInput) replInput.addEventListener("input", (e) => {
    replBasis = +e.target.value; saveKnobs(); rank(rows); updateKnobReadouts(); paint();
  });
  if (ceilInput) ceilInput.addEventListener("input", (e) => {
    ceilTilt = +e.target.value; saveKnobs(); rank(rows); updateKnobReadouts(); paint();
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
    if (ceilInput) ceilInput.value = ceilTilt;
    updateKnobReadouts();
    $("#board-meta").textContent = `board ${board.generated} · ${rows.length} players · ADP as of ${board.generated}`;
    paint();
  })();
})();
