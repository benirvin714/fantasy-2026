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

  const staleBanner = (dateStr, what, days = 2) => {
    const age = (Date.now() - new Date(dateStr).getTime()) / 864e5;
    return age > days
      ? `<div class="stale-warn">${what} is ${Math.floor(age)} days old — the daily routine may not have run.</div>`
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

    $("#myroster-meta").textContent = `${window.HBGB_RosterTable.meta(t)} · ${t.starter_rank} of ${d.teams.length} by projection`;
    $("#myroster-body").innerHTML =
      staleBanner(d.generated, "This roster", 3) +
      window.HBGB_RosterTable.html(t, { teams: d.teams.length }) +
      `<p class="rr-note">Click any name for the latest published on that player. Every other team is in the
        <a href="rosters.html">roster room</a>, with the standings and the trade search.</p>`;
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

  /* ---------- waiver board (published by /waivers) ---------- */
  async function renderWaivers() {
    $("#waivers-body").innerHTML = skel(4);
    let d;
    try { d = await fetchJSON(A.WAIVERS_JSON); }
    catch { return err("#waivers-body", `No published waiver board for ${esc(A.name)}. Run /waivers in Claude Code — it writes ${esc(A.data)}/waivers.json.`); }
    $("#waivers-meta").textContent = `generated ${d.generated} · ${d.mode}`;
    const age = (Date.now() - new Date(d.generated).getTime()) / 864e5;
    const stale = age > 7 ? `<div class="stale-warn">This board is ${Math.floor(age)} days old — re-run /waivers for current suggestions.</div>` : "";
    const confDots = { high: "●●●", med: "●●○", low: "●○○" };
    /* `bid` started life as a price ("$5") and /waivers now writes either that or a full
       recommendation sentence into it. Only the price shape belongs in the right-aligned chip on
       the name row; a sentence gets its own line below. 24 characters clears the longest real price
       string ("$18 (frenzy price)") without letting prose through. */
    const isChipBid = (b) => b != null && String(b).trim().length > 0 && String(b).length <= 24;
    const edgeCls = (e) => e === "value" ? "edge-value" : e === "overpay" ? "edge-over" : "edge-fair";
    $("#waivers-body").innerHTML = stale + d.targets.map((t) => `
      <div class="wtarget">
        <div class="row1">
          <span class="rank">${t.rank}.</span>
          <span class="name">${esc(t.player)}</span>
          <span class="pos">${esc(t.pos)} · ${esc(t.team)}</span>
          ${t.verdict ? `<span class="verdict verdict-${esc(t.verdict)}">${esc(t.verdict)}</span>` : ""}
          ${t.confidence ? `<span class="wconf conf-${esc(t.confidence)}" title="rec-confidence: ${esc(t.confidence)}${t.confidence_why ? " — " + esc(t.confidence_why) : ""}">${confDots[t.confidence] ?? ""}</span>` : ""}
          ${isChipBid(t.bid) ? `<span class="bid">${esc(t.bid)}</span>` : ""}
        </div>
        ${t.bid && !isChipBid(t.bid) ? `<div class="bid-long"><b>bid:</b> ${esc(t.bid)}</div>` : ""}
        <div class="why">${esc(t.why)}</div>
        ${t.asset ? `<div class="wasset"><b>asset:</b> ${esc(t.asset)}${t.rate_basis ? ` <span class="faint">(${esc(t.rate_basis)})</span>` : ""}${t.edge ? ` · <b class="${edgeCls(t.edge)}">${esc(t.edge)}</b>` : ""}${t.worth ? ` · worth <b>${esc(t.worth)}</b>` : ""}</div>` : ""}
        ${t.my_team_impact ? `<div class="impact">↳ ${esc(t.my_team_impact)}</div>` : ""}
        <div class="sub"><b>competition:</b> ${t.pressure ? `<span class="pressure pressure-${esc(t.pressure)}">${esc(t.pressure).toUpperCase()}</span> — ` : ""}${esc(t.competition)} &nbsp;·&nbsp; <b>drop:</b> ${esc(t.drop)}</div>
      </div>`).join("") + (d.note ? `<p class="sub" style="color:var(--faint);font-size:12px;margin:10px 0 0">${esc(d.note)}</p>` : "");
  }

  /* ---------- brief panel (published by /brief) ---------- */
  async function renderBrief() {
    // The panel is removed outright on a league /brief has not written for (see data-league-only
    // in index.html), so this is a normal skip, not a failure.
    if (!$("#brief-body")) return;
    $("#brief-body").innerHTML = skel(4);
    let d;
    try { d = await fetchJSON(A.BRIEF_JSON); }
    catch { return err("#brief-body", `No published brief. Run /brief in Claude Code — it writes ${esc(A.data)}/latest-brief.json.`); }
    $("#brief-meta").textContent = `from briefs/${d.date}.md`;
    $("#brief-body").innerHTML = `<ol class="sowhat">${d.so_what.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
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
