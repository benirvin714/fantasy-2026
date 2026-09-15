/* HBGBs HQ — read-only dashboard.
   Live data: Sleeper public API (season state, league identity). Local data: JSON published by the
   daily NFL-events routine, /waivers, /brief, and the roster-room build.
   The standings table used to live here; it moved to the roster room, where it sorts all ten teams.
   Rule: never fabricate — every panel shows an explicit error state when its source is unreachable. */
(() => {
  const C = window.HQ_CONFIG;
  // The league in view, resolved by league-switch.js. Every per-league path comes off this; nothing
  // in here should read HQ_CONFIG's flat *_JSON keys, which are back-compat only.
  const A = C.active;
  const $ = (sel) => document.querySelector(sel);

  const fetchJSON = async (url) => {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return r.json();
  };

  const err = (panelSel, msg) => {
    $(panelSel).innerHTML = `<div class="panel-error" role="alert">${msg}</div>`;
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const skel = (n) => `<div class="skel-wrap" aria-hidden="true">${
    Array.from({ length: n }).map(() => `<div class="skel-row"></div>`).join("")}</div>`;

  /* `why` is a parameter because the panels do not go stale for the same reason. The events feed and
     the roster room are rebuilt by the twice-daily routine, so old means that routine did not run.
     The brief is weekly, so old means a Tuesday slot was missed - blaming the daily routine there
     would send the reader to check something that is working fine. */
  const staleBanner = (dateStr, what, days = 2, why = "the daily routine may not have run") => {
    const age = (Date.now() - new Date(dateStr).getTime()) / 864e5;
    return age > days
      ? `<div class="stale-warn">${what} is ${Math.floor(age)} days old — ${why}.</div>`
      : "";
  };

  /* ---------- header ---------- */
  async function renderState() {
    const st = await fetchJSON(`${C.API}/state/nfl`);
    $("#state-chip").textContent = `season ${st.season} · ${st.season_type === "off" ? "offseason" : `week ${st.display_week}`}`;
    $("#state-chip").classList.add("live");
  }

  /* ---------- league chip (live) ---------- */
  async function renderLeague() {
    const league = await fetchJSON(`${C.API}/league/${A.league_id}?cb=${Date.now()}`);
    $("#league-chip").textContent = `${league.name} · ${league.season} (${league.status})`;
  }

  /* ---------- my roster (published by scripts/build-roster-room.mjs) ----------
     The standings used to live in this slot. They moved to the roster room, where they sort all ten
     teams; what belongs on the front page is the lineup, because that is the object every other
     panel here is about. The table itself is site/roster-table.js, shared with the roster room, so
     the slot ranks and the "would start on N of 9" bench read are identical in both places. */
  async function renderMyRoster() {
    $("#myroster-body").innerHTML = skel(8);
    let d;
    try { d = await fetchJSON(A.ROSTER_ROOM_JSON); }
    catch {
      return err("#myroster-body",
        `No published roster room for ${esc(A.name)}. Run <code>node scripts/build-roster-room.mjs --league=${esc(A.key)}</code> — it writes ${esc(A.data)}/roster-room.json. It refuses to run until every roster has players, so before a draft this panel is empty by design.`);
    }
    const t = d.teams.find((x) => x.is_me) ?? d.teams.find((x) => x.roster_id === A.my_roster_id);
    if (!t) return err("#myroster-body", `Roster ${A.my_roster_id} isn't in the published ${esc(A.name)} room — check my_roster_id in config.js.`);

    /* The week, where the build published one. This panel is the in-season lineup view, so it asks
       for the week basis: a Game column and this week's points rather than the season's. `d.week` is
       absent from any roster-room.json built before that existed, and the table falls back to the
       season view on its own rather than painting a column of dashes. */
    const opts = { teams: d.teams.length, week: d.week ?? null };
    $("#myroster-meta").textContent = `${window.HBGB_RosterTable.meta(t, opts)} · ${t.starter_rank} of ${d.teams.length} by season projection`;
    $("#myroster-body").innerHTML =
      staleBanner(d.generated, "This roster", 3) +
      window.HBGB_RosterTable.html(t, opts) +
      `<p class="rr-note">Click any name for the latest published on that player. Kickoffs are in your
        timezone. Every other team is in the <a href="rosters.html">roster room</a>, with the standings,
        the season projections and the trade search.</p>`;
  }

  /* ---------- NFL updates (published by the daily nfl-events routine) ----------
     The feed itself is shared by every league: an injury is an injury. `so_what` is the format read
     and is true in both, because the two leagues match on 42 of 50 scoring keys and have an
     identical slot shape. What does NOT transfer is the half that names an owner, so that lives in
     league_notes keyed by league and only the league it belongs to ever renders it. */
  const leagueNote = (e) => (e.league_notes && e.league_notes[A.key]) || null;
  let events = [], evFilter = "all";
  function paintEvents() {
    const rows = events.filter((e) => evFilter === "all" || e.type === evFilter);
    $("#updates-list").innerHTML = rows.length
      ? `<ul class="events">${rows.map((e) => `
          <li>
            <div class="row1">
              <span class="tag tag-${esc(e.type)}">${esc(e.type)}</span>
              <span class="headline">${esc(e.headline)}</span>
              <span class="edate">${esc(e.date)}</span>
            </div>
            <div class="detail">${esc(e.detail)}</div>
            ${e.so_what ? `<div class="sowhat-line">↳ ${esc(e.so_what)}</div>` : ""}
            ${leagueNote(e) ? `<div class="sowhat-line lg-note">↳ ${esc(leagueNote(e))}</div>` : ""}
            ${e.source?.url ? `<div class="src"><a href="${esc(e.source.url)}" target="_blank" rel="noopener">${esc(e.source.label ?? "source")}</a></div>` : ""}
          </li>`).join("")}</ul>`
      : `<div class="loading">No ${evFilter === "all" ? "" : evFilter + " "}updates.</div>`;
  }

  async function renderNFLUpdates() {
    $("#updates-list").innerHTML = skel(5);
    let d;
    try { d = await fetchJSON(C.EVENTS_JSON); }
    catch {
      return err("#updates-body",
        "No published NFL updates. The daily routine writes data/site/nfl-events.json — run it once, or check that it's scheduled.");
    }
    $("#updates-meta").textContent = `updated ${d.updated} · ${d.events.length} items`;
    events = d.events;
    $("#updates-body").querySelector(".stale-slot").innerHTML = staleBanner(d.updated, "This feed");
    paintEvents();
  }

  /* ---------- waiver board (published by /waivers) ----------
     Collapsed by default so 15+ targets fit in the panel (§1.29). Each target is a two-line button:
     rank, name, verdict, confidence and price on top, a one-line hook and the drop name beneath.
     Everything else (the bid rationale, why, asset, impact, competition, the drop's reason) opens in
     place on click, one row at a time or all at once from the panel head. The order is
     the file's order, which /waivers step 7 now fixes by rule; this page does not re-sort. */
  const wOpen = new Set();   // "<league>:<player>" — survives a refresh, not a reload
  async function renderWaivers() {
    $("#waivers-body").innerHTML = skel(4);
    $("#waivers-expand").hidden = true;
    let d;
    try { d = await fetchJSON(A.WAIVERS_JSON); }
    catch { return err("#waivers-body", `No published waiver board for ${esc(A.name)}. Run /waivers in Claude Code — it writes ${esc(A.data)}/waivers.json.`); }
    $("#waivers-meta").textContent = `generated ${d.generated} · ${d.mode} · ${d.targets.length} targets`;
    const age = (Date.now() - new Date(d.generated).getTime()) / 864e5;
    const stale = age > 7 ? `<div class="stale-warn">This board is ${Math.floor(age)} days old — re-run /waivers for current suggestions.</div>` : "";
    const confDots = { high: "●●●", med: "●●○", low: "●○○" };
    const edgeCls = (e) => e === "value" ? "edge-value" : e === "overpay" ? "edge-over" : "edge-fair";
    /* The price on the collapsed row. `bid_amount` is the field /waivers writes for exactly this;
       boards published before it existed only have `bid`, which is a sentence, so fall back to its
       leading number ("2 dollars -- ...", "$18 (frenzy price)"). No number means no bid, and the
       verdict and the sentence say which kind: AVOID is a pass, the Pit and the Clash are unpriced
       by design, anything else is a hold. */
    const price = (t, v) => {
      const n = Number.isFinite(t.bid_amount) ? t.bid_amount
        : +(String(t.bid ?? "").match(/^\s*\$?(\d+)(?=\s*(?:dollars\b|\(|$|\s*--))/i)?.[1] ?? NaN);
      if (Number.isFinite(n)) return { txt: `$${n}`, cls: "wprice-num" };
      if (v === "avoid") return { txt: "pass", cls: "" };
      if (/^\s*unpriced/i.test(t.bid ?? "")) return { txt: "unpriced", cls: "" };
      return { txt: "no bid", cls: "" };
    };
    // Boards before `hook` existed: the first sentence of `why`, which CSS truncates to one line.
    const hookOf = (t) => t.hook || String(t.why ?? "").split(/(?<=\.)\s/)[0];
    /* The drop on the collapsed row is a name, not the sentence. `drop_player` is written for this;
       older boards only have `drop` ("Mike Washington -- Jeanty has no injury designation..."), so
       take what precedes the first " -- ", comma, parenthesis or period. Anything longer than a name
       could plausibly be is dropped rather than shown half-parsed, and "n/a" means no drop at all. */
    const dropOf = (t) => {
      if (t.drop_player !== undefined) return t.drop_player || null;
      const s = String(t.drop ?? "").trim();
      if (!s || /^(n\/?a|none)\b/i.test(s)) return null;
      const name = s.split(/\s+--\s+|,|\s\(|\.\s/)[0].trim();
      return name.length <= 28 ? name : null;
    };
    $("#waivers-body").innerHTML = stale + `<div class="wlist">` + d.targets.map((t, i) => {
      // /waivers writes the verdict in capitals and the CSS classes are lowercase; class selectors
      // are case-sensitive, so the uncoerced value never matched its color.
      const v = String(t.verdict ?? "").toLowerCase();
      const key = `${A.key}:${t.player}`;
      const isOpen = wOpen.has(key);
      const p = price(t, v);
      const dropName = dropOf(t);
      return `
      <div class="wtarget${isOpen ? " open" : ""}">
        <button class="wrow" data-wkey="${esc(key)}" aria-expanded="${isOpen}" aria-controls="wd-${i}">
          <span class="rank">${esc(t.rank)}</span>
          <span class="wwho"><span class="name">${esc(t.player)}</span><span class="pos">${esc(t.pos)} · ${esc(t.team)}</span></span>
          ${v ? `<span class="verdict verdict-${esc(v)}">${esc(v)}</span>` : "<span></span>"}
          ${t.confidence ? `<span class="wconf conf-${esc(t.confidence)}" aria-label="confidence ${esc(t.confidence)}">${confDots[t.confidence] ?? ""}</span>` : "<span></span>"}
          <span class="wprice ${p.cls}">${esc(p.txt)}</span>
          <span class="wchev" aria-hidden="true">›</span>
          <span class="wline2">
            <span class="whook"><span class="wpos-m">${esc(t.pos)} · ${esc(t.team)} · </span>${esc(hookOf(t))}</span>
            ${dropName ? `<span class="wdrop">drop <b>${esc(dropName)}</b></span>` : ""}
          </span>
        </button>
        <div class="wdetail" id="wd-${i}"${isOpen ? "" : " hidden"}>
          ${t.bid ? `<div class="bid-long"><b>bid:</b> ${esc(t.bid)}</div>` : ""}
          <div class="why">${esc(t.why)}</div>
          ${t.asset ? `<div class="wasset"><b>asset:</b> ${esc(t.asset)}${t.rate_basis ? ` <span class="faint">(${esc(t.rate_basis)})</span>` : ""}${t.edge ? ` · <b class="${edgeCls(t.edge)}">${esc(t.edge)}</b>` : ""}${t.worth != null && t.worth !== "" ? ` · worth <b>${esc(t.worth)}</b>` : ""}</div>` : ""}
          ${t.my_team_impact ? `<div class="impact">↳ ${esc(t.my_team_impact)}</div>` : ""}
          ${t.confidence_why ? `<div class="sub"><b>confidence ${esc(t.confidence ?? "")}:</b> ${esc(t.confidence_why)}</div>` : ""}
          <div class="sub"><b>competition:</b> ${t.pressure ? `<span class="pressure pressure-${esc(t.pressure)}">${esc(t.pressure).toUpperCase()}</span> — ` : ""}${esc(t.competition)} &nbsp;·&nbsp; <b>drop:</b> ${esc(t.drop)}</div>
        </div>
      </div>`;
    }).join("") + `</div>` + (d.note ? `<p class="sub" style="color:var(--faint);font-size:12px;margin:10px 0 0">${esc(d.note)}</p>` : "");
    syncExpandAll();
  }
  const setWOpen = (btn, open) => {
    btn.setAttribute("aria-expanded", String(open));
    btn.parentElement.classList.toggle("open", open);
    document.getElementById(btn.getAttribute("aria-controls")).hidden = !open;
    open ? wOpen.add(btn.dataset.wkey) : wOpen.delete(btn.dataset.wkey);
  };
  /* Expand all / collapse all. The label follows the rows rather than its own last click: open the
     last closed row by hand and it flips to "collapse all", which is the action it would then take.
     Hidden whenever there are no rows (loading, the error state, an empty board). */
  const syncExpandAll = () => {
    const btn = $("#waivers-expand");
    const rows = [...document.querySelectorAll("#waivers-body .wrow")];
    btn.hidden = rows.length === 0;
    const allOpen = rows.length > 0 && rows.every((r) => r.getAttribute("aria-expanded") === "true");
    btn.textContent = allOpen ? "collapse all" : "expand all";
    btn.dataset.expand = String(!allOpen);
  };
  // Delegated listeners, bound once: the panel body is re-rendered on every refresh.
  $("#waivers-body").addEventListener("click", (e) => {
    const btn = e.target.closest(".wrow");
    if (!btn) return;
    setWOpen(btn, btn.getAttribute("aria-expanded") !== "true");
    syncExpandAll();
  });
  $("#waivers-expand").addEventListener("click", (e) => {
    const open = e.currentTarget.dataset.expand === "true";
    document.querySelectorAll("#waivers-body .wrow").forEach((r) => setWOpen(r, open));
    syncExpandAll();
  });

  /* ---------- brief panel (published by /brief) ---------- */
  async function renderBrief() {
    // Guard kept even though both leagues now render the panel: if a league is ever gated out of it
    // again, this is what stops the fetch and its error handler from racing the removal.
    if (!$("#brief-body")) return;
    $("#brief-body").innerHTML = skel(4);
    let d;
    try { d = await fetchJSON(A.BRIEF_JSON); }
    catch { return err("#brief-body", `No published brief for ${esc(A.name)} yet. It publishes on the Tuesday morning run, or run <code>/brief ${esc(A.key)}</code> in Claude Code now — it writes ${esc(A.data)}/latest-brief.json.`); }
    $("#brief-meta").textContent = `from briefs/${d.date}.md`;
    /* /brief runs weekly (Tuesday morning, via the daily routine), so anything past ten days means a
       run was missed. This panel had no staleness check at all and spent seven weeks presenting a
       2026-07-17 brief as current, which is exactly what every other panel here is built to prevent. */
    $("#brief-body").innerHTML =
      staleBanner(d.date, "This brief", 10, `the weekly Tuesday morning slot was missed; run <code>/brief ${esc(A.key)}</code> to refresh it now`) +
      `<ol class="sowhat">${d.so_what.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  }

  /* ---------- filters ---------- */
  document.querySelectorAll(".filters button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      evFilter = b.dataset.f;
      paintEvents();
    }));

  /* ---------- refresh + timestamp ---------- */
  function stampAsOf() {
    const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#asof").textContent = `as of ${t}`;
  }
  function loadAll() {
    renderNFLUpdates();
    renderWaivers();
    renderBrief();
    renderMyRoster();
    renderState().catch(() => { $("#state-chip").textContent = "Sleeper unreachable"; });
    renderLeague().catch(() => { $("#league-chip").textContent = "league unreachable"; });
    stampAsOf();
  }
  const btn = $("#refresh-btn");
  btn.addEventListener("click", () => {
    btn.classList.remove("spin"); void btn.offsetWidth; btn.classList.add("spin");
    loadAll();
  });

  /* ---------- boot ---------- */
  loadAll();
})();
