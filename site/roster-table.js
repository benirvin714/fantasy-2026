/* roster-table.js — one roster, rendered as this league's slot shape actually uses it.

   Shared because the same table now appears in two places: the HQ page (my team, where the
   standings used to sit) and the roster room (inside the row you expand). Two copies would have
   drifted the first time either grew a column, and the second copy would have been the one that
   silently lost the slot-rank tooltip.

   Input is a team object straight out of data/site/roster-room.json. Nothing is computed here —
   the ranks, the vs-median figures and the "would start on N of 9" counts are all recomputed
   optimal lineups from scripts/build-roster-room.mjs. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 0) => n == null ? "—" : Number(n).toFixed(d);
  const sign = (n, d = 0) => n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`;
  const signCls = (n) => n == null ? "" : n > 0 ? "rr-pos" : n < 0 ? "rr-neg" : "rr-zero";
  const rankCls = (r) => r <= 3 ? "rr-r-good" : r >= 8 ? "rr-r-bad" : "rr-r-mid";
  // Falls back to a plain name if player-news.js isn't on the page, so this file can't break a
  // roster table by being loaded without its companion.
  const name = (p) => window.HBGB_PlayerNews
    ? window.HBGB_PlayerNews.link(p)
    : esc(p.name);

  function html(t) {
    const line = (s) => {
      const p = s.player;
      if (!p) return `<tr><td class="rr-slot">${esc(s.slot)}</td><td colspan="4" class="faint">empty</td></tr>`;
      return `<tr>
        <td class="rr-slot">${esc(s.slot)}</td>
        <td class="rr-nm">${name(p)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
        <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
        <td class="num">${num(p.pts, 1)}</td>
        <td class="num rr-slotrk ${rankCls(s.rank)}" title="Rank of this slot against the other nine teams · ${sign(s.vs_median, 1)} vs the slot median">${s.rank}<span class="rr-vs ${signCls(s.vs_median)}">${sign(s.vs_median)}</span></td>
      </tr>`;
    };

    const bench = t.bench.map((p) => `<tr>
      <td class="rr-slot rr-bn">BN</td>
      <td class="rr-nm">${name(p)}</td>
      <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
      <td class="num">${num(p.pts, 1)}</td>
      <td class="num rr-starts ${p.starts_on >= 4 ? "rr-r-good" : p.starts_on === 0 ? "rr-r-bad" : "rr-r-mid"}"
          title="Would start on ${p.starts_on} of the other nine teams, measured by recomputing each of their optimal lineups with him inserted. Best single gain: ${sign(p.best_gain, 1)} points.">${p.starts_on}/9</td>
    </tr>`).join("");

    return `<table class="rr-rtab" aria-label="${esc(t.owner)} roster">
        <thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Proj</th>
          <th class="num" title="Starters: this slot's rank against the other nine teams. Bench: how many of the other nine he would start for.">Rk</th></tr></thead>
        <tbody>${t.slots.map(line).join("")}
          <tr class="rr-div"><td colspan="5"><div class="cutlabel">bench · 5 spots, and that is the whole margin</div></td></tr>
          ${bench}</tbody></table>
      ${t.unpriced.length ? `<div class="rr-unpriced">Unpriced and excluded from every total here: ${
        t.unpriced.map((u) => esc(u.name)).join(", ")}. No 2026 projection — counted as zero would fake a weakness.</div>` : ""}`;
  }

  const meta = (t) => `${t.starter_pts.toFixed(0)} starting · ${t.bench_pts.toFixed(0)} on the bench`;

  window.HBGB_RosterTable = { html, meta };
})();
