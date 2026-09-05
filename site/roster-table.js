/* roster-table.js — one roster, rendered as this league's slot shape actually uses it.

   Shared because the same table appears in two places: the HQ page (my team, where the standings
   used to sit) and the roster room (inside the row you expand). Two copies would have drifted the
   first time either grew a column, and the second copy would have been the one that silently lost
   the slot-rank tooltip.

   Two layouts, one data shape. `{split: true}` puts the bench in its own column beside the
   starters, which is what the roster room's expanded row wants: it spans the full league table, and
   a single 16-row list down the left of a 1400px card is mostly empty card. HQ renders it stacked,
   because there the panel is ~560px and two columns would just squeeze both. The split is a caller
   decision rather than a media query because the constraint is the container, not the viewport, and
   the two callers know their own width.

   Input is a team object straight out of a league's roster-room.json, plus `opts.teams` - the size
   of that league, which every piece of wording here derives from. It used to say "the other nine"
   in five places, which was true of exactly one league. Nothing is computed here: the ranks, the
   vs-median figures and the "would start on N of N-1" counts are all recomputed optimal lineups
   from scripts/build-roster-room.mjs. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 0) => n == null ? "—" : Number(n).toFixed(d);
  const sign = (n, d = 0) => n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`;
  const signCls = (n) => n == null ? "" : n > 0 ? "rr-pos" : n < 0 ? "rr-neg" : "rr-zero";
  const rankCls = (r) => r <= 3 ? "rr-r-good" : r >= 8 ? "rr-r-bad" : "rr-r-mid";
  // Falls back to a plain name if player-news.js isn't on the page, so this file can't break a
  // roster table by being loaded without its companion.
  const name = (p) => window.HBGB_PlayerNews ? window.HBGB_PlayerNews.link(p) : esc(p.name);
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen"];
  const spell = (n) => WORDS[n] ?? String(n);
  /* Set per render from opts.teams. The 9 is a floor for a caller that forgets to pass it, not an
     assumption about the league: every caller in this repo passes it. */
  let OTHERS = 9;

  const startRow = (s) => {
    const p = s.player;
    if (!p) return `<tr><td class="rr-slot">${esc(s.slot)}</td><td colspan="4" class="faint">empty</td></tr>`;
    return `<tr>
      <td class="rr-slot">${esc(s.slot)}</td>
      <td class="rr-nm">${name(p)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
      <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
      <td class="num">${num(p.pts, 1)}</td>
      <td class="num rr-slotrk ${rankCls(s.rank)}" title="Rank of this slot against the other ${spell(OTHERS)} teams · ${sign(s.vs_median, 1)} vs the slot median">${s.rank}<span class="rr-vs ${signCls(s.vs_median)}">${sign(s.vs_median)}</span></td>
    </tr>`;
  };

  const benchRow = (p, withSlot) => `<tr>
    ${withSlot ? `<td class="rr-slot rr-bn">BN</td>` : ""}
    <td class="rr-nm">${name(p)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
    <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
    <td class="num">${num(p.pts, 1)}</td>
    <td class="num rr-starts ${p.starts_on >= 4 ? "rr-r-good" : p.starts_on === 0 ? "rr-r-bad" : "rr-r-mid"}"
        title="Would start on ${p.starts_on} of the other ${spell(OTHERS)} teams, measured by recomputing each of their optimal lineups with him inserted. Best single gain: ${sign(p.best_gain, 1)} points.">${p.starts_on}/${OTHERS}</td>
  </tr>`;

  const rkTip = () => `Starters: this slot's rank against the other ${spell(OTHERS)} teams. Bench: how many of the other ${spell(OTHERS)} he would start for.`;

  const unpriced = (t) => t.unpriced.length
    ? `<div class="rr-unpriced">Unpriced and excluded from every total here: ${
        t.unpriced.map((u) => esc(u.name)).join(", ")}. No 2026 projection — counted as zero would fake a weakness.</div>`
    : "";

  /* ---------- stacked: ten starters, a divider, five bench ---------- */
  function stacked(t) {
    return `<table class="rr-rtab" aria-label="${esc(t.owner)} roster">
        <thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Proj</th>
          <th class="num" title="${rkTip()}">Rk</th></tr></thead>
        <tbody>${t.slots.map(startRow).join("")}
          <tr class="rr-div"><td colspan="5"><div class="cutlabel">bench · 5 spots, and that is the whole margin</div></td></tr>
          ${t.bench.map((p) => benchRow(p, true)).join("")}</tbody></table>
      ${unpriced(t)}`;
  }

  /* ---------- split: starters left, bench right ---------- */
  /* The bench drops its slot column here — every row in it says BN, and a column of one repeated
     value is the first thing to cut when the point is to use the width for something. What it gains
     instead is a caption that says what the column is for, because a bench list without the
     "would start on N of 9" framing is just five names. */
  function split(t) {
    return `<div class="rr-rwrap">
      <div class="rr-rcol">
        <div class="rr-rcap">Starting lineup <span class="faint">${t.starter_pts.toFixed(0)} projected</span></div>
        <table class="rr-rtab" aria-label="${esc(t.owner)} starting lineup">
          <thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Proj</th>
            <th class="num" title="This slot's rank against the other ${spell(OTHERS)} teams">Rk</th></tr></thead>
          <tbody>${t.slots.map(startRow).join("")}</tbody></table>
      </div>
      <div class="rr-rcol">
        <div class="rr-rcap" title="Five bench spots is the whole margin in this format - there is no room to stash depth you will not start.">Bench <span class="faint">${t.bench.length} of 5 · ${t.bench_pts.toFixed(0)} sitting</span></div>
        <table class="rr-rtab rr-btab" aria-label="${esc(t.owner)} bench">
          <thead><tr><th>Player</th><th>Pos</th><th class="num">Proj</th>
            <th class="num" title="How many of the other ${spell(OTHERS)} teams he would start for, by recomputing each of their optimal lineups with him inserted">Starts</th></tr></thead>
          <tbody>${t.bench.map((p) => benchRow(p, false)).join("")}</tbody></table>
        ${unpriced(t)}
      </div>
    </div>`;
  }

  const html = (t, opts = {}) => {
    if (opts.teams > 1) OTHERS = opts.teams - 1;
    return opts.split ? split(t) : stacked(t);
  };
  const meta = (t) => `${t.starter_pts.toFixed(0)} starting · ${t.bench_pts.toFixed(0)} on the bench`;

  window.HBGB_RosterTable = { html, meta };
})();
