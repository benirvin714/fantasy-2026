/* player-news.js — click a player's name anywhere on this dashboard, get what is actually known
   about that player right now.

   Shared by the HQ roster panel and the roster room, so it is a single delegated listener rather
   than per-page wiring: any element carrying data-pid opens the dossier, including markup rendered
   after this file loads. The feed is data/site/player-news.json, published by
   scripts/build-player-news.mjs, and it is fetched lazily on the first click — 296KB is cheap once
   somebody asks for a player and pure waste on a page load where nobody does.

   The rule the rest of the dashboard follows applies here too: nothing on this panel is written by
   the browser. A player with no published item says so, with the date the feed was last built, and
   that is a more useful answer than an empty box that reads as "nothing happened". */
(() => {
  const C = window.HQ_CONFIG;
  // Per-league: each league publishes its own dossiers, because the roster join and the projection
  // are the two things in there that are not facts about the player.
  const A = C.active;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let DATA = null, loading = null, dlg = null, lastFocus = null;

  const dayAge = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 864e5) : null;
  const ago = (d) => {
    const n = dayAge(d);
    return n == null ? "" : n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
  };

  function build() {
    dlg = document.createElement("dialog");
    dlg.className = "pn-dlg";
    dlg.setAttribute("aria-labelledby", "pn-name");
    dlg.innerHTML = `
      <div class="pn-head">
        <div class="pn-id">
          <h2 id="pn-name"></h2>
          <span class="pn-sub"></span>
        </div>
        <button type="button" class="pn-close" aria-label="Close">✕</button>
      </div>
      <div class="pn-body"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector(".pn-close").addEventListener("click", () => dlg.close());
    // Click outside the card closes it. <dialog> puts the backdrop behind the element itself, so
    // the hit test is "did the click land outside the card's own box", not "was the target the
    // backdrop" — the backdrop is a pseudo-element and is never an event target.
    dlg.addEventListener("click", (e) => {
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener("close", () => { if (lastFocus && lastFocus.isConnected) lastFocus.focus(); });
    return dlg;
  }

  async function load() {
    if (DATA) return DATA;
    if (!loading) {
      loading = (async () => {
        const r = await fetch(A.PLAYER_NEWS_JSON, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })().catch((e) => { loading = null; throw e; });
    }
    DATA = await loading;
    return DATA;
  }

  /* ------------------------------------------------------------------ the dossier itself */
  function render(p, fallbackName) {
    dlg.querySelector("#pn-name").textContent = p ? p.name : fallbackName;
    const sub = dlg.querySelector(".pn-sub");
    sub.innerHTML = p
      ? `${esc(p.pos)} · ${esc(p.team ?? "FA")}${p.bye ? ` · bye ${p.bye}` : ""}
         <span class="pn-owner">${p.roster.is_me ? "your roster" : esc(p.roster.owner)} · ${esc(p.roster.slot)}</span>`
      : "";

    if (!p) {
      dlg.querySelector(".pn-body").innerHTML = `<div class="panel-error" role="alert">
        ${esc(fallbackName)} isn't in ${esc(A.name)}'s dossier file. That file covers players rostered in
        this league only, and it is rebuilt with the rosters — if he was just added, re-run
        <code>node scripts/build-player-news.mjs --league=${esc(A.key)}</code>.</div>`;
      return;
    }

    const secs = [];

    /* This file is built on demand, while two of its three inputs move on a schedule (the events
       feed twice a day, the draft board daily). So the panel checks its own age and says when it is
       behind, rather than presenting a four-day-old "Latest" as current. */
    const stale = dayAge(DATA.generated);
    if (stale != null && stale > 2) {
      secs.push(`<div class="stale-warn">These dossiers were built ${stale} days ago, and the events feed has
        run since. Re-run <code>node scripts/build-player-news.mjs --league=${esc(A.key)}</code> for what's current.</div>`);
    }

    /* Numbers first, because they are the only part of this panel that is a fact rather than a read. */
    const facts = [];
    if (p.projection) {
      facts.push(`<span class="pn-fact"><b>${p.projection.pts.toFixed(1)}</b> projected
        ${p.projection.ppg != null ? `<span class="faint">${p.projection.ppg.toFixed(1)}/wk</span>` : ""}</span>`);
    }
    if (p.adp) facts.push(`<span class="pn-fact">ADP <b>${p.adp.half_ppr.toFixed(1)}</b></span>`);
    // A team defense doesn't miss games, so the availability model has nothing to say about one and
    // printing "1.00 · 17.0 games" against the Seahawks is noise dressed as a measurement.
    if (p.availability?.score != null && p.pos !== "DEF") {
      facts.push(`<span class="pn-fact" title="1 minus the missed-game rate, age-adjusted. ${
        esc(p.availability.history ?? "no history string")}">availability <b>${p.availability.score.toFixed(2)}</b>
        ${p.availability.expected_games != null ? `<span class="faint">${p.availability.expected_games.toFixed(1)} games</span>` : ""}</span>`);
    }
    if (p.availability?.status) facts.push(`<span class="pn-fact pn-inj">${esc(p.availability.status)}</span>`);
    if (facts.length) secs.push(`<div class="pn-facts">${facts.join("")}</div>`);

    /* What changed. This is the part the click is actually for. */
    if (p.events.length) {
      secs.push(`<section class="pn-sec">
        <h3>Latest <span class="faint">${p.events.length} item${p.events.length === 1 ? "" : "s"} in the feed</span></h3>
        <ul class="events pn-events">${p.events.map((e) => `
          <li>
            <div class="row1">
              <span class="tag tag-${esc(e.type)}">${esc(e.type)}</span>
              <span class="headline">${esc(e.headline)}</span>
              <span class="edate">${esc(e.date)} · ${esc(ago(e.date))}</span>
            </div>
            <div class="detail">${esc(e.detail)}</div>
            ${e.so_what ? `<div class="sowhat-line">↳ ${esc(e.so_what)}</div>` : ""}
            ${e.league_notes && e.league_notes[A.key] ? `<div class="sowhat-line lg-note">↳ ${esc(e.league_notes[A.key])}</div>` : ""}
            <div class="src">
              ${e.source?.url ? `<a href="${esc(e.source.url)}" target="_blank" rel="noopener">${esc(e.source.label ?? "source")}</a>` : ""}
              ${e.also?.length ? `<span class="faint"> · also names ${esc(e.also.join(", "))}</span>` : ""}
            </div>
          </li>`).join("")}</ul>
      </section>`);
    } else {
      secs.push(`<section class="pn-sec"><h3>Latest</h3>
        <div class="loading">Nothing in the events feed naming ${esc(p.name)} as of ${
          esc(DATA.sources.events ?? "unknown")}. That feed runs twice a day and covers the whole league, so this
          means no item mentioned this player — not that nothing happened.</div></section>`);
    }

    /* The standing read. Older than the feed by construction, and labelled with its own date. */
    if (p.brief) {
      const b = p.brief;
      const chips = [];
      if (b.role_stability) chips.push(`<span class="pn-chip pn-role-${esc(b.role_stability)}">role: ${esc(b.role_stability)}</span>`);
      if (b.scheme_fit) chips.push(`<span class="pn-chip pn-fit-${esc(b.scheme_fit)}">scheme: ${esc(b.scheme_fit)}</span>`);
      const newest = b.sources.map((s) => s.date).filter(Boolean).sort().pop();
      secs.push(`<section class="pn-sec">
        <h3>Scouting brief ${newest ? `<span class="faint">newest source ${esc(newest)}</span>` : ""}</h3>
        ${chips.length ? `<div class="pn-chips">${chips.join("")}</div>` : ""}
        <p class="pn-prose">${esc(b.prose)}</p>
        ${b.rationale ? `<p class="pn-rationale"><b>why that grade:</b> ${esc(b.rationale)}</p>` : ""}
        ${b.sources.length ? `<div class="pn-srcs">${b.sources.map((s) =>
          `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>${s.date ? `<span class="faint"> ${esc(s.date)}</span>` : ""}`).join("<br>")}</div>` : ""}
      </section>`);
    } else {
      // Two different reasons for the same blank, and conflating them would be misleading: a
      // missing brief on a kicker is the design, a missing brief on a WR is the pass running out.
      const why = p.pos === "K" || p.pos === "DEF"
        ? `Kickers and defenses aren't scouted here. They're streaming slots in this format, and a brief on one
           would be decoration — the draft board doesn't price them off research either.`
        : `No brief on file. The research pass works down the board by price, so the deep end of a bench is
           where it thins out first.`;
      secs.push(`<section class="pn-sec"><h3>Scouting brief</h3><div class="loading">${why}</div></section>`);
    }

    if (p.adp_commentary) {
      secs.push(`<section class="pn-sec"><h3>Price <span class="faint">${
        p.adp?.updated ? `ADP as of ${esc(p.adp.updated)}` : ""}</span></h3>
        <p class="pn-prose">${esc(p.adp_commentary)}</p></section>`);
    }

    const extra = [
      ...p.situation.map((f) => `<li>${esc(f)}</li>`),
      ...p.risk_notes.map((n) => `<li>${esc(n)}</li>`),
      p.availability?.history ? `<li>${esc(p.availability.history)}</li>` : "",
    ].filter(Boolean);
    if (extra.length) {
      secs.push(`<section class="pn-sec"><h3>Also on file</h3><ul class="pn-list">${extra.join("")}</ul></section>`);
    }

    secs.push(`<div class="pn-foot">Built ${esc(DATA.generated)} from the events feed (${
      esc(DATA.sources.events ?? "?")}), the draft board (${esc(DATA.sources.draft_board ?? "?")}) and the roster
      room (${esc(DATA.sources.roster_room ?? "?")}). Nothing on this panel is written by the page.</div>`);

    dlg.querySelector(".pn-body").innerHTML = secs.join("");
    dlg.querySelector(".pn-body").scrollTop = 0;
  }

  async function open(id, name, from) {
    lastFocus = from ?? document.activeElement;
    if (!dlg) build();
    dlg.querySelector("#pn-name").textContent = name ?? "Player";
    dlg.querySelector(".pn-sub").textContent = "";
    dlg.querySelector(".pn-body").innerHTML = `<div class="loading">Loading dossier…</div>`;
    if (!dlg.open) dlg.showModal();
    try {
      const d = await load();
      render(d.players[id] ?? null, name ?? id);
    } catch (e) {
      dlg.querySelector(".pn-body").innerHTML = `<div class="panel-error" role="alert">
        No published player dossiers for ${esc(A.name)} (${esc(e.message)}). Run
        <code>node scripts/build-player-news.mjs --league=${esc(A.key)}</code> — it writes
        <code>${esc(A.data)}/player-news.json</code> from that league's roster room, the shared draft
        board and the shared events feed.</div>`;
    }
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-pid]");
    if (!el) return;
    e.preventDefault();
    open(el.dataset.pid, el.dataset.pname ?? el.textContent.trim(), el);
  });

  /* The one bit of markup every caller needs, kept here so the button contract lives with the
     listener that depends on it. */
  window.HBGB_PlayerNews = {
    open,
    link: (p, cls = "") =>
      `<button type="button" class="pn-link ${cls}" data-pid="${esc(p.id)}" data-pname="${esc(p.name)}"
        title="Latest on ${esc(p.name)}">${esc(p.name)}</button>`,
  };
})();
