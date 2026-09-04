/* Draft Aid — tiered board + live Sleeper pick sync.
 *
 * Two sources of "this player is gone":
 *   manual — you tapped him. Persisted in localStorage, undoable, cleared by reset.
 *   live   — Sleeper says he was picked. Never persisted, never undoable: the feed is the truth
 *            and a local override of it is just a way to draft someone who is already on a roster.
 *
 * The union is what gets struck through. Keeping them in separate sets (rather than folding live
 * picks into the manual set on arrival) is what makes `reset` safe mid-draft — it wipes your own
 * marks and the next poll repaints Sleeper's, instead of blanking the board until someone picks.
 */
(() => {
  "use strict";

  const API = "https://api.sleeper.app/v1";
  const DATA_URL = "/data/site/draft-aid.json";
  const K_MANUAL = "draft-aid-manual";
  const K_DRAFTID = "draft-aid-draftid";
  const K_HIDE = "draft-aid-hide-drafted";
  const K_FMT = "draft-aid-format";
  const POLL_MS = 10000;        // the cadence asked for: every 10s once a draft is connected
  const POLL_MAX_MS = 60000;    // ...backing off to this while the origin is failing

  const $ = (sel) => document.querySelector(sel);
  const el = {
    list: $("#list"),
    tabs: $("#tabs"),
    search: $("#search"),
    searchClear: $("#search-clear"),
    hide: $("#hide-drafted"),
    undo: $("#undo"),
    reset: $("#reset"),
    count: $("#bar-count"),
    scoring: $("#scoring"),
    scoringNote: $("#scoring-note"),
    pill: $("#sync-pill"),
    pillDot: $("#sync-dot"),
    pillLabel: $("#sync-label"),
    panel: $("#sync-panel"),
    draftId: $("#draft-id"),
    syncBtn: $("#sync-btn"),
    syncNote: $("#sync-note"),
    ftrSrc: $("#ftr-src"),
  };

  // ---------- state -------------------------------------------------------------------------

  let players = [];        // sorted for the CURRENT format; re-sorted whenever the format changes
  let meta = null;
  let fmt = localStorage.getItem(K_FMT) || "half";
  let pos = "ALL";
  let query = "";
  let hideDrafted = localStorage.getItem(K_HIDE) === "1";

  const manual = new Set(readManual());
  const manualStack = [...manual];          // tap order, so undo pops the most recent mark
  const live = new Map();                   // player id -> pick number

  const sync = {
    id: null, on: false, status: null, picks: 0, lastPick: null,
    err: null, lastOk: null, delay: POLL_MS, timer: null, wakeLock: null,
    shaped: false,      // has this connection's scoring/roster shape been read yet
    superflex: false,
  };

  function readManual() {
    try { return JSON.parse(localStorage.getItem(K_MANUAL) || "[]"); }
    catch { return []; }
  }
  function saveManual() {
    try { localStorage.setItem(K_MANUAL, JSON.stringify([...manual])); } catch { /* private mode */ }
  }

  const isGone = (p) => manual.has(p.id) || live.has(p.id);

  // ---------- scoring format ------------------------------------------------------------------

  // Each player carries {r, tr, a} per format under `f`. Everything downstream reads through here,
  // so switching format is a re-sort and a repaint rather than a second data file.
  const F = (p) => p.f?.[fmt] ?? {};

  /* Ranked players in consensus order, then the ADP-only tail cheapest first. Re-run on every
     format change: Ja'Marr Chase is WR1 overall in PPR and third in standard, and a board that
     kept one order across all three would be quietly wrong in two of them. */
  function sortForFormat() {
    players.sort((x, y) => {
      const a = F(x), b = F(y);
      if (a.r != null && b.r != null) return a.r - b.r;
      if (a.r != null) return -1;
      if (b.r != null) return 1;
      return (a.a ?? 9999) - (b.a ?? 9999);
    });
  }

  function setFormat(next, reason) {
    if (!next || !meta?.formats?.[next] || next === fmt) {
      if (reason) paintScoring(reason);
      return;
    }
    fmt = next;
    try { localStorage.setItem(K_FMT, fmt); } catch { /* private mode */ }
    sortForFormat();
    paintScoring(reason);
    paintList();
  }

  function paintScoring(reason) {
    for (const b of el.scoring.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.fmt === fmt));
    }
    el.scoringNote.textContent = reason ?? "";
    el.scoringNote.hidden = !reason;
  }

  // ---------- rendering ---------------------------------------------------------------------

  const posLabel = (p) => (p === "DEF" ? "DST" : p);
  const bandOf = (tier) => (tier == null ? "x" : String((tier - 1) % 6));

  /* `flat` renders the row for a list that is NOT grouped into tier cards — a position tab or a
     search result. Filtering to one position leaves most tiers holding a single player, and a card
     header above every one of them is more tier furniture than board; the row carries its own tier
     chip and colour stripe instead, which is the same information in a fifth of the height. */
  function rowHtml(p, flat) {
    const gone = isGone(p);
    const pickNo = live.get(p.id);
    const f = F(p);
    const sub = [p.t || "FA", p.b ? `bye ${p.b}` : null].filter(Boolean).join(" · ");
    const adp = f.a != null ? `${f.a.toFixed(1)}` : "";
    const lead = flat
      ? `<span class="tchip">${f.tr != null ? `T${f.tr}` : "–"}</span>`
      : `<span class="rk">${f.r ?? ""}</span>`;
    return `<button class="row${gone ? " gone" : ""}" data-id="${p.id}"
        aria-pressed="${gone}"${flat ? ` data-band="${bandOf(f.tr)}"` : ""}>
      ${lead}
      <span class="pos pos-${p.p}">${posLabel(p.p)}</span>
      <span class="nm"><span class="who">${esc(p.n)}</span><span class="sub">${sub}</span></span>
      ${pickNo ? `<span class="by">#${pickNo}</span>` : `<span class="adp">${adp}</span>`}
    </button>`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function visible() {
    let out = players;
    if (pos !== "ALL") out = out.filter((p) => p.p === pos);
    if (query) {
      const q = query.toLowerCase();
      out = out.filter((p) => p.n.toLowerCase().includes(q) || (p.t || "").toLowerCase() === q);
    }
    if (hideDrafted) out = out.filter((p) => !isGone(p));
    return out;
  }

  function paintList() {
    const rows = visible();
    if (!rows.length) {
      el.list.innerHTML = `<p class="empty">${query ? "No player by that name." : "Nothing left here."}</p>`;
      paintCount();
      return;
    }

    // Grouped tier cards are the point of the All tab and only get in the way everywhere else.
    if (query || pos !== "ALL") {
      const head = query ? `Matches` : `${posLabel(pos)} board`;
      el.list.innerHTML = `<section class="tier" data-band="x">
        <div class="tier-head">${head} <span class="n">${rows.length}</span></div>
        ${rows.map((p) => rowHtml(p, true)).join("")}</section>`;
      paintCount();
      return;
    }

    const groups = [];
    let cur = null;
    for (const p of rows) {
      const key = F(p).tr ?? "x";
      if (!cur || cur.key !== key) { cur = { key, items: [] }; groups.push(cur); }
      cur.items.push(p);
    }

    el.list.innerHTML = groups.map((g) => {
      const band = bandOf(g.key === "x" ? null : g.key);
      const head = g.key === "x" ? "Unranked · by ADP" : `Tier ${g.key}`;
      const left = g.items.filter((p) => !isGone(p)).length;
      return `<section class="tier" data-band="${band}">
        <div class="tier-head">${head} <span class="n">${left}/${g.items.length} left</span></div>
        ${g.items.map((p) => rowHtml(p, false)).join("")}
      </section>`;
    }).join("");
    paintCount();
  }

  function paintCount() {
    const pool = pos === "ALL" ? players : players.filter((p) => p.p === pos);
    const gone = pool.filter(isGone).length;
    el.count.textContent = `${pool.length - gone} left · ${gone} gone`;
    el.undo.disabled = manualStack.length === 0;
  }

  // ---------- live sync ---------------------------------------------------------------------

  /* Sleeper sits behind Cloudflare with stale-while-revalidate, and it WILL hand back a cached
     pick list minutes old — measured on this league's own draft. A unique query param per request
     is the only thing that reliably defeats it, so every read gets one. */
  async function sleeperGet(path) {
    const bust = `_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const r = await fetch(`${API}${path}?${bust}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* The draft object states its own scoring and roster shape, so the board configures itself from
     the thing you connected instead of trusting you to have remembered which league this is. Only
     acted on once per connection — re-applying it every 10s would fight you if you deliberately
     switched formats mid-draft to peek at another set of tiers. */
  const SCORING_MAP = { std: "std", standard: "std", half_ppr: "half", ppr: "ppr" };
  function applyDraftShape(info) {
    if (sync.shaped) return;
    sync.shaped = true;

    const detected = SCORING_MAP[String(info?.metadata?.scoring_type ?? "").toLowerCase()];
    const s = info?.settings ?? {};
    // Superflex shows up either as an explicit slot or as a second starting QB.
    const superflex = (s.slots_super_flex ?? 0) > 0 || (s.slots_qb ?? 0) >= 2;
    sync.superflex = superflex;

    const bits = [];
    if (detected && detected !== fmt) bits.push(`switched to ${meta?.formats?.[detected]?.label ?? detected} — the draft says so`);
    else if (detected) bits.push(`${meta?.formats?.[detected]?.label ?? detected}, matching the draft`);
    else bits.push("draft did not state a scoring type — format left as you set it");
    if (superflex) bits.push("⚠ superflex/2QB: these are 1QB tiers, so QBs rank far too low here");

    if (detected) setFormat(detected, bits.join(" · "));
    else paintScoring(bits.join(" · "));
  }

  async function pollOnce() {
    const [info, picks] = await Promise.all([
      sleeperGet(`/draft/${sync.id}`),
      sleeperGet(`/draft/${sync.id}/picks`),
    ]);
    sync.status = info?.status ?? null;
    sync.picks = picks.length;
    applyDraftShape(info);

    live.clear();
    for (const p of picks) if (p.player_id) live.set(String(p.player_id), p.pick_no);

    const last = picks.reduce((a, b) => (!a || b.pick_no > a.pick_no ? b : a), null);
    sync.lastPick = last
      ? `#${last.pick_no} ${[last.metadata?.first_name, last.metadata?.last_name].filter(Boolean).join(" ") || last.player_id}`
      : null;

    sync.lastOk = Date.now();
    sync.err = null;
  }

  function schedule() {
    clearTimeout(sync.timer);
    if (!sync.on) return;
    // Nothing else is coming once the draft is over — stop hitting their origin every 10 seconds.
    if (sync.status === "complete") { paintSync(); releaseWakeLock(); return; }
    sync.timer = setTimeout(tick, sync.delay);
  }

  async function tick() {
    if (!sync.on) return;
    try {
      await pollOnce();
      sync.delay = POLL_MS;               // recovered: back to the normal cadence
      paintList();
    } catch (e) {
      // Back off instead of hammering a failing origin, and never wipe the last good picture: a
      // frozen board that says it is frozen beats an empty one that says nothing.
      sync.err = e.message;
      sync.delay = Math.min(POLL_MAX_MS, sync.delay * 2);
    }
    paintSync();
    schedule();
  }

  async function connect(id) {
    sync.id = id; sync.on = true; sync.err = null; sync.delay = POLL_MS;
    sync.shaped = false; sync.superflex = false;
    el.pillLabel.textContent = "connecting…";
    try {
      await pollOnce();
      try { localStorage.setItem(K_DRAFTID, id); } catch { /* private mode */ }
      requestWakeLock();
      paintList(); paintSync(); schedule();
    } catch (e) {
      sync.on = false;
      sync.err = `${e.message} — check the draft ID`;
      live.clear();
      paintList(); paintSync();
    }
  }

  function disconnect() {
    sync.on = false; sync.err = null; sync.status = null;
    sync.picks = 0; sync.lastPick = null; sync.id = null;
    sync.shaped = false; sync.superflex = false;
    clearTimeout(sync.timer);
    live.clear();
    releaseWakeLock();
    try { localStorage.removeItem(K_DRAFTID); } catch { /* private mode */ }
    // The format stays where the draft put it — you are usually disconnecting from the draft you
    // are still in, and silently reverting the tiers under you would be worse than leaving them.
    paintScoring(null);
    paintList(); paintSync();
  }

  function paintSync() {
    el.syncBtn.textContent = sync.on ? "disconnect" : "connect";
    el.syncBtn.classList.toggle("on", sync.on);
    el.pill.className = "sync-pill";
    el.syncNote.classList.remove("bad");

    if (!sync.on) {
      el.pillLabel.textContent = sync.err ? "failed" : "connect";
      if (sync.err) {
        el.pill.classList.add("bad");
        el.syncNote.textContent = sync.err;
        el.syncNote.classList.add("bad");
      }
      return;
    }
    if (sync.err) {
      el.pill.classList.add("bad");
      el.pillLabel.textContent = `stale · ${sync.picks}`;
      const age = sync.lastOk ? `${Math.round((Date.now() - sync.lastOk) / 1000)}s ago` : "never";
      el.syncNote.textContent = `Sync failing (${sync.err}). Last good read ${age}; retrying every ${Math.round(sync.delay / 1000)}s. Treat the pick count as a floor.`;
      el.syncNote.classList.add("bad");
      return;
    }
    if (sync.status === "complete") {
      el.pill.classList.add("done");
      el.pillLabel.textContent = `done · ${sync.picks}`;
      el.syncNote.textContent = `Draft complete — ${sync.picks} picks in. Polling stopped.`;
      return;
    }
    el.pill.classList.add("live");
    el.pillLabel.textContent = `live · ${sync.picks}`;
    el.syncNote.textContent = `Reading draft ${sync.id} every 10s.`
      + (sync.lastPick ? ` Last pick ${sync.lastPick}.` : " No picks yet.");
  }

  /* A phone that locks itself between picks is the single most annoying thing about drafting on
     one. Safari 16.4+ honours this; anywhere it is missing we just do without. */
  async function requestWakeLock() {
    if (!("wakeLock" in navigator) || sync.wakeLock) return;
    try { sync.wakeLock = await navigator.wakeLock.request("screen"); }
    catch { sync.wakeLock = null; }
  }
  function releaseWakeLock() {
    try { sync.wakeLock?.release(); } catch { /* already gone */ }
    sync.wakeLock = null;
  }

  // iOS drops both the wake lock and (eventually) our timer when the tab is backgrounded. Coming
  // back, poll immediately rather than waiting out a stale timeout.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !sync.on) return;
    requestWakeLock();
    clearTimeout(sync.timer);
    tick();
  });

  // ---------- events ------------------------------------------------------------------------

  el.list.addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (!row) return;
    const id = row.dataset.id;
    if (live.has(id)) return;             // Sleeper owns this one; a local un-mark would be a lie
    if (manual.has(id)) {
      manual.delete(id);
      const i = manualStack.lastIndexOf(id);
      if (i >= 0) manualStack.splice(i, 1);
    } else {
      manual.add(id);
      manualStack.push(id);
    }
    saveManual();
    paintList();
  });

  el.scoring.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fmt]");
    if (!b) return;
    // A hand-picked format after connecting is a deliberate override, so say which it is rather
    // than leaving the earlier "matching the draft" note standing over a board it no longer describes.
    setFormat(b.dataset.fmt, sync.on ? "set by hand — no longer following the draft's scoring" : null);
  });

  el.tabs.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pos]");
    if (!b) return;
    pos = b.dataset.pos;
    for (const x of el.tabs.querySelectorAll("button")) {
      x.setAttribute("aria-pressed", String(x === b));
    }
    window.scrollTo({ top: 0 });
    paintList();
  });

  let searchTimer = null;
  el.search.addEventListener("input", () => {
    el.searchClear.hidden = !el.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = el.search.value.trim(); paintList(); }, 90);
  });
  el.searchClear.addEventListener("click", () => {
    el.search.value = ""; query = ""; el.searchClear.hidden = true; paintList(); el.search.focus();
  });

  el.hide.addEventListener("click", () => {
    hideDrafted = !hideDrafted;
    el.hide.setAttribute("aria-pressed", String(hideDrafted));
    try { localStorage.setItem(K_HIDE, hideDrafted ? "1" : "0"); } catch { /* private mode */ }
    paintList();
  });

  el.undo.addEventListener("click", () => {
    const id = manualStack.pop();
    if (!id) return;
    manual.delete(id);
    saveManual();
    paintList();
  });

  el.reset.addEventListener("click", () => {
    if (!manual.size) return;
    if (!confirm(`Clear ${manual.size} manual mark${manual.size === 1 ? "" : "s"}? Sleeper's picks stay.`)) return;
    manual.clear();
    manualStack.length = 0;
    saveManual();
    paintList();
  });

  el.pill.addEventListener("click", () => {
    const open = el.panel.hidden;
    el.panel.hidden = !open;
    el.pill.setAttribute("aria-expanded", String(open));
    if (open && !sync.on) el.draftId.focus();
  });

  el.syncBtn.addEventListener("click", () => {
    if (sync.on) return disconnect();
    // Accept a pasted URL as readily as a bare ID — on draft day you copy the address bar.
    const id = (el.draftId.value.trim().match(/(\d{8,})/) || [])[1];
    if (!id) {
      sync.err = "Need the numeric draft ID from the Sleeper URL.";
      paintSync();
      return;
    }
    el.draftId.value = id;
    connect(id);
  });
  el.draftId.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el.syncBtn.click(); }
  });

  // ---------- boot --------------------------------------------------------------------------

  (async function boot() {
    el.hide.setAttribute("aria-pressed", String(hideDrafted));
    try {
      const r = await fetch(`${DATA_URL}?v=${Date.now().toString(36)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      players = d.players;
      meta = d;
    } catch (e) {
      el.list.innerHTML = `<p class="err">Could not load the board (${esc(e.message)}).
        Nothing is shown rather than something wrong.</p>`;
      return;
    }

    if (!meta.formats?.[fmt]) fmt = meta.default_format || "half";
    for (const b of el.scoring.querySelectorAll("button[data-fmt]")) {
      const f = meta.formats[b.dataset.fmt];
      if (f) b.textContent = f.label.replace("Standard", "Std");
      else b.hidden = true;                       // a format the build could not produce is not offered
    }
    sortForFormat();

    el.ftrSrc.textContent = `${meta.players.length} players, ${meta.season} · tiers: ${meta.tiers_source}`
      + ` (built ${meta.generated}) · ADP: ${meta.adp_source}.`;

    paintScoring(null);
    paintList();
    paintSync();

    // ?draft=<id> beats the stored one, so a link shared into the group chat connects on open.
    const fromUrl = (new URLSearchParams(location.search).get("draft") || "").match(/(\d{8,})/);
    const stored = localStorage.getItem(K_DRAFTID);
    const bootId = fromUrl ? fromUrl[1] : stored;
    if (bootId) {
      el.draftId.value = bootId;
      connect(bootId);
    }
  })();
})();
