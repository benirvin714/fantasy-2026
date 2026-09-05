/* league-switch.js — which league is in-season HQ and the roster room looking at.
 *
 * The dashboard renders two leagues from one set of pages. Rather than forking index.html and
 * rosters.html per league (two copies of every renderer, guaranteed to drift the first time either
 * grows a column), the pages take a league dimension and this file resolves it once.
 *
 * WHERE THIS FILE LOADS MATTERS, and it is the end of <body>, above app.js / rosters.js. The inline
 * block in each page's <head> stamps the palette early so it cannot flash; the DOM work has to
 * happen before the page renderers boot, because they run at end-of-body and NOT at
 * DOMContentLoaded. Deferring to DOMContentLoaded raced: renderBrief() found the brief panel,
 * started its fetch, and the panel was removed out from under its error handler mid-request.
 *
 * Resolution order, matching how the other-league tab already behaves:
 *   0. an existing <html data-league> stamp, written by that inline block
 *   1. ?league=<key>   one visit, wins over everything, deliberately NOT sticky
 *   2. localStorage    whatever you last clicked in the switcher, per browser
 *   3. DEFAULT_LEAGUE  so a device that has never seen this opens on the HBGBs
 *
 * It publishes HQ_CONFIG.active - the resolved league plus its four published-JSON paths - and
 * nothing downstream should build a data path itself. It also stamps <html data-league="...">,
 * which is what the palette hangs off, and honours two declarative attributes in the markup:
 *
 *   [data-league-switch]        gets the switcher chips rendered into it
 *   [data-league-only="hbgbs"]  removed entirely unless that league is active
 *   [data-league-name]          filled with the active league's name
 *
 * The attribute is removal, not hiding: a brief panel that is display:none still fires its fetch
 * and still reports an error into a box nobody can see.
 */
(() => {
  const C = window.HQ_CONFIG;
  const KEY = "hbgb.activeLeague";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  /* Honour the head block's stamp if it is there, so the two can never disagree; resolve from
     scratch if a page forgot it, so this file still works standalone. */
  const stamped = document.documentElement.getAttribute("data-league");
  let key = stamped && C.LEAGUES[stamped] ? stamped : null;
  if (!key) {
    const q = new URLSearchParams(location.search).get("league");
    if (q && C.LEAGUES[q]) key = q;
  }
  if (!key) { const s = stored(); if (s && C.LEAGUES[s]) key = s; }
  if (!key) key = C.DEFAULT_LEAGUE;

  const L = C.LEAGUES[key];
  document.documentElement.setAttribute("data-league", key);

  C.active = {
    ...L,
    ROSTER_ROOM_JSON: `${L.data}/roster-room.json`,
    PLAYER_NEWS_JSON: `${L.data}/player-news.json`,
    WAIVERS_JSON: `${L.data}/waivers.json`,
    BRIEF_JSON: `${L.data}/latest-brief.json`,
  };

  /* Switching reloads rather than re-rendering in place. Every panel on these pages is an async
     fetch with its own error state, and re-running all of them against a different league while
     the old league's responses are still in flight is a race with no upside - you would see one
     league's roster under the other's name for a beat. A reload is instant off a warm cache and
     cannot interleave. */
  C.setLeague = (k) => {
    if (!C.LEAGUES[k] || k === key) return;
    try { localStorage.setItem(KEY, k); } catch { /* private window: the choice lasts this visit */ }
    const u = new URL(location.href);
    u.searchParams.delete("league");   // the click is the new persistent choice; drop the override
    u.searchParams.delete("team");     // a roster id in one league means someone else in the other
    location.assign(u.toString());
  };

  function paint() {
    for (const el of document.querySelectorAll("[data-league-name]")) el.textContent = L.name.toUpperCase();
    // The tab title too: two of these open side by side is the normal way to use them. The page's
    // own label comes off <body data-page>, not off parsing the existing title - a regex over a
    // string another league already rewrote is a bug waiting for the second reload.
    if (document.body.dataset.page) document.title = `${L.short} ${document.body.dataset.page}`;
    for (const el of document.querySelectorAll("[data-league-only]")) {
      if (el.dataset.leagueOnly !== key) el.remove();
    }
    for (const host of document.querySelectorAll("[data-league-switch]")) {
      host.innerHTML = Object.values(C.LEAGUES).map((x) => x.key === key
        ? `<span class="chip lgchip active" aria-current="true">${esc(x.short)}</span>`
        : `<button type="button" class="chip lgchip" data-go="${esc(x.key)}">${esc(x.short)}</button>`
      ).join("");
      host.querySelectorAll("[data-go]").forEach((b) =>
        b.addEventListener("click", () => C.setLeague(b.dataset.go)));
    }
  }

  /* Immediate, not deferred. See the note at the top: this file loads at the end of <body>, so the
     markup it acts on is already parsed and the page renderers below it have not run yet. */
  paint();
})();
