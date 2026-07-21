/* HBGBs HQ — read-only dashboard.
   Live data: Sleeper public API (standings, season state). Local data: JSON published by the
   daily NFL-events routine, /waivers, and /brief.
   Rule: never fabricate — every panel shows an explicit error state when its source is unreachable. */
(() => {
  const C = window.HQ_CONFIG;
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

  /* ---------- standings (live) ---------- */
  async function renderLeague() {
    $("#standings-body").innerHTML = skel(6);
    const [league, rosters, users] = await Promise.all([
      fetchJSON(`${C.API}/league/${C.LEAGUE_ID}`),
      fetchJSON(`${C.API}/league/${C.LEAGUE_ID}/rosters`),
      fetchJSON(`${C.API}/league/${C.LEAGUE_ID}/users`),
    ]);
    $("#league-chip").textContent = `${league.name} · ${league.season} (${league.status})`;
    const nameOf = {};
    for (const u of users) nameOf[u.user_id] = u.display_name;

    const rows = rosters
      .map((r) => ({
        owner: nameOf[r.owner_id] ?? r.owner_id, me: r.roster_id === C.MY_ROSTER_ID,
        w: r.settings.wins, l: r.settings.losses,
        pf: r.settings.fpts + (r.settings.fpts_decimal ?? 0) / 100,
        streak: r.metadata?.streak ?? "",
      }))
      .sort((a, b) => b.w - a.w || b.pf - a.pf);

    const maxPf = Math.max(...rows.map((r) => r.pf));
    const minPf = Math.min(...rows.map((r) => r.pf));
    const frac = (pf) => maxPf === minPf ? 1 : 0.12 + 0.88 * ((pf - minPf) / (maxPf - minPf));
    const playoffCut = C.PLAYOFF_TEAMS ?? 6;

    let bodyHTML = "";
    rows.forEach((r, i) => {
      if (i === playoffCut && rows.length > playoffCut) {
        bodyHTML += `<tr class="cutrow"><td colspan="5"><div class="cutlabel">playoff line · top ${playoffCut}</div></td></tr>`;
      }
      const cls = [r.me ? "me" : "", i === playoffCut ? "cut" : ""].filter(Boolean).join(" ");
      bodyHTML += `<tr${cls ? ` class="${cls}"` : ""}>
        <td>${esc(r.owner)}</td>
        <td class="num">${r.w}</td><td class="num">${r.l}</td>
        <td class="num pf-cell"><span class="pf-bar" style="width:${(frac(r.pf) * 100).toFixed(1)}%"></span><span class="pf-val">${r.pf.toFixed(1)}</span></td>
        <td class="num ${/L$/.test(r.streak) ? "streak-l" : "streak-w"}">${esc(r.streak)}</td>
      </tr>`;
    });

    $("#standings-body").innerHTML = `<table aria-label="Standings — top ${playoffCut} make the playoffs">
      <thead><tr><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">PF</th><th class="num">Strk</th></tr></thead>
      <tbody>${bodyHTML}</tbody></table>`;
  }

  /* ---------- NFL updates (published by the daily nfl-events routine) ---------- */
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
    try { d = await fetchJSON(C.WAIVERS_JSON); }
    catch { return err("#waivers-body", "No published waiver board. Run /waivers in Claude Code — it writes data/site/waivers.json."); }
    $("#waivers-meta").textContent = `generated ${d.generated} · ${d.mode}`;
    const age = (Date.now() - new Date(d.generated).getTime()) / 864e5;
    const stale = age > 7 ? `<div class="stale-warn">This board is ${Math.floor(age)} days old — re-run /waivers for current suggestions.</div>` : "";
    const confDots = { high: "●●●", med: "●●○", low: "●○○" };
    const edgeCls = (e) => e === "value" ? "edge-value" : e === "overpay" ? "edge-over" : "edge-fair";
    $("#waivers-body").innerHTML = stale + d.targets.map((t) => `
      <div class="wtarget">
        <div class="row1">
          <span class="rank">${t.rank}.</span>
          <span class="name">${esc(t.player)}</span>
          <span class="pos">${esc(t.pos)} · ${esc(t.team)}</span>
          ${t.verdict ? `<span class="verdict verdict-${esc(t.verdict)}">${esc(t.verdict)}</span>` : ""}
          ${t.confidence ? `<span class="wconf conf-${esc(t.confidence)}" title="rec-confidence: ${esc(t.confidence)}${t.confidence_why ? " — " + esc(t.confidence_why) : ""}">${confDots[t.confidence] ?? ""}</span>` : ""}
          <span class="bid">${esc(t.bid)}</span>
        </div>
        <div class="why">${esc(t.why)}</div>
        ${t.asset ? `<div class="wasset"><b>asset:</b> ${esc(t.asset)}${t.rate_basis ? ` <span class="faint">(${esc(t.rate_basis)})</span>` : ""}${t.edge ? ` · <b class="${edgeCls(t.edge)}">${esc(t.edge)}</b>` : ""}${t.worth ? ` · worth <b>${esc(t.worth)}</b>` : ""}</div>` : ""}
        ${t.my_team_impact ? `<div class="impact">↳ ${esc(t.my_team_impact)}</div>` : ""}
        <div class="sub"><b>competition:</b> ${t.pressure ? `<span class="pressure pressure-${esc(t.pressure)}">${esc(t.pressure).toUpperCase()}</span> — ` : ""}${esc(t.competition)} &nbsp;·&nbsp; <b>drop:</b> ${esc(t.drop)}</div>
      </div>`).join("") + (d.note ? `<p class="sub" style="color:var(--faint);font-size:12px;margin:10px 0 0">${esc(d.note)}</p>` : "");
  }

  /* ---------- brief panel (published by /brief) ---------- */
  async function renderBrief() {
    $("#brief-body").innerHTML = skel(4);
    let d;
    try { d = await fetchJSON(C.BRIEF_JSON); }
    catch { return err("#brief-body", "No published brief. Run /brief in Claude Code — it writes data/site/latest-brief.json."); }
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
    renderState().catch(() => { $("#state-chip").textContent = "Sleeper unreachable"; });
    renderLeague().catch((e) =>
      err("#standings-body", `Sleeper API unreachable (${esc(e.message)}). Standings unavailable — nothing is shown rather than stale data.`));
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
