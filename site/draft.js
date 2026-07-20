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

  let board = null, rows = [];
  let pos = "ALL", view = "board", hideDrafted = false, hideFlagged = false;
  const expanded = new Set();

  /* ---------- value math (transparent, in one place) ----------
     Cross-positional value MUST be VORP, not raw points: in this league QB13-16,
     TE12-15, RB/WR ~45+, a top-12 K and streamable DEFs sit on waivers all season
     (league-profile.md), so a player's draft value is points OVER that free
     replacement. Raw points would rank all QBs first — exactly the trap the
     league doctrine warns against. Replacement rank per position: */
  const REPL_RANK = { QB: 13, RB: 46, WR: 47, TE: 13, K: 11, DEF: 11 };
  let replPts = {}; // computed from the board itself

  function compute(p) {
    const avail = p.availability?.score;   // null => neutral, flagged "no data"
    const situ = p.situation?.modifier;    // null => neutral, flagged "no data"
    const flags = p.risk_flags ?? {};
    const flagged = ["suspension", "contract", "legal"].filter((k) => flags[k] === true);
    const unvetted = flags.researched === false;
    return { ...p, availMissing: avail == null, situMissing: situ == null, flagged, unvetted };
  }

  function rank(list) {
    // replacement level = projection of the REPL_RANK-th player at each position
    for (const pos of Object.keys(REPL_RANK)) {
      const posSorted = list.filter((p) => p.pos === pos && p.projection?.pts != null)
        .sort((a, b) => b.projection.pts - a.projection.pts);
      replPts[pos] = posSorted[Math.min(REPL_RANK[pos], posSorted.length) - 1]?.projection.pts ?? 0;
    }
    for (const p of list) {
      if (p.projection?.pts == null) { p.value = null; continue; }
      const vorp = p.projection.pts - (replPts[p.pos] ?? 0);
      p.value = +(vorp * (p.availability?.score ?? 1) * (p.situation?.modifier ?? 1)).toFixed(1);
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
    const isOpen = expanded.has(p.id);
    const gapCls = p.gap == null ? "" : p.gap >= 5 ? "gap-value" : p.gap <= -5 ? "gap-reach" : "gap-fair";
    const gapTxt = p.gap == null ? "–" : (p.gap > 0 ? "+" : "") + Math.round(p.gap);
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
        <span class="dname">${esc(p.name)}</span>
        <span class="dpos">${esc(p.pos)}${p.posRank ? p.posRank : ""} · ${esc(p.team)}</span>
        ${badges}
        <span class="dval mono">${p.value ?? "–"}</span>
        <span class="dadp mono" title="ADP (half-PPR, ${esc(board.players ? p.adp?.updated : "")})">${p.adp?.half_ppr ?? "–"}</span>
        <span class="dgap mono ${gapCls}">${gapTxt}</span>
      </button>
      ${isOpen ? detailHTML(p) : ""}
    </div>`;
  }

  function detailHTML(p) {
    const a = p.availability ?? {};
    const gp = a.games_played ?? {};
    const facts = p.situation?.facts ?? [];
    const ctx = p.context ?? {};
    const ctxRow = (label, v, fmt) => `<div><b>${label}:</b> ${v == null ? noData : esc(fmt ? fmt(v) : v)}</div>`;
    const notes = p.risk_flags?.notes ?? [];
    return `<div class="ddetail">
      ${p.adp_commentary ? `<div class="dcommentary"><b>Why here at ${esc(p.pos)}:</b> ${esc(p.adp_commentary)}</div>` : ""}
      <div class="dcol">
        <h4>Projection</h4>
        <div><b>league pts:</b> ${p.projection.pts ?? "–"} (${p.projection.ppg ?? "–"}/g)</div>
        <div><b>VORP:</b> ${p.value ?? "–"} <span class="faint">(over free ${esc(p.pos)}${REPL_RANK[p.pos] ?? "?"} @ ${replPts[p.pos] ?? "?"} pts × avail × situation)</span></div>
        <div><b>method:</b> ${esc(p.projection.method)}</div>
        <div><b>sleeper half-PPR anchor:</b> ${p.projection.sleeper_half_ppr ?? "–"}</div>
        <div><b>ADP:</b> ${p.adp?.half_ppr ?? "–"} <span class="faint">(as of ${esc(p.adp?.updated ?? "?")})</span></div>
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
        <h4>Context</h4>
        ${ctxRow("contract year", ctx.contract_year)}
        ${ctxRow("rookie capital", ctx.rookie_capital)}
        ${ctxRow("team win total", ctx.team_win_total)}
        ${ctxRow("playoff SOS (wks 15-17)", ctx.playoff_sos)}
      </div>
    </div>`;
  }

  const headerHTML = `
    <div class="drow dhead" aria-hidden="true">
      <span></span>
      <span class="dmain-head"><span class="dr">#</span><span class="dname">player</span><span class="dpos">pos</span>
      <span class="dval">value</span><span class="dadp">adp</span><span class="dgap">gap</span></span>
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
      $("#board-title").textContent = pos === "ALL" ? "Value board" : `Value board — ${pos}`;
      const sorted = [...list].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
      $("#board-body").innerHTML = headerHTML +
        sorted.map((p) => rowHTML(p, p.valueRank ?? "–")).join("") +
        `<div class="boardfoot">gap = ADP − value rank · <span class="gap-value">+green</span> = market prices them later than their value (bargain) · <span class="gap-reach">−red</span> = priced above value (reach)</div>`;
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
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
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
  $("#hide-drafted").addEventListener("click", (e) => {
    hideDrafted = !hideDrafted; e.target.setAttribute("aria-pressed", String(hideDrafted)); paint();
  });
  $("#hide-flagged").addEventListener("click", (e) => {
    hideFlagged = !hideFlagged; e.target.setAttribute("aria-pressed", String(hideFlagged)); paint();
  });
  $("#reset-draft").addEventListener("click", () => {
    if (taken.size && confirm(`Clear ${taken.size} drafted marks?`)) { taken.clear(); saveTaken(); paint(); }
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
    $("#board-meta").textContent = `board ${board.generated} · ${rows.length} players · ADP as of ${board.generated}`;
    paint();
  })();
})();
