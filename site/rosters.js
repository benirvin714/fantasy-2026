/* Roster room — every team in the active league as a scouting object.
   Renders that league's roster-room.json, published by scripts/build-roster-room.mjs, joined with
   the live standings from Sleeper. Same rule as every other page here: no analysis is generated in the
   browser, and a missing feed produces a stated error rather than a blank panel that reads as
   "nothing to report". */
(() => {
  const C = window.HQ_CONFIG;
  // The league in view, resolved by league-switch.js.
  const A = C.active;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const num = (n, d = 0) => n == null ? "—" : Number(n).toFixed(d);
  const sign = (n, d = 0) => n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`;
  const signCls = (n) => n == null ? "" : n > 0 ? "rr-pos" : n < 0 ? "rr-neg" : "rr-zero";
  const ORD = (n) => ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th",
    "11th", "12th", "13th", "14th"][n] ?? `${n}th`;
  const TEAMS = () => DATA.teams.length;
  /* Rank colour is a three-way read, not a gradient. Top third good, bottom third bad, and a middle that deliberately gets no colour so the extremes
     stay legible. Derived from the league size: hardcoding "8th or worse is bad" made 8th of 12 a
     red flag when it is upper-middle. */
  const rankCls = (r) => {
    const third = Math.max(1, Math.round(TEAMS() / 3));
    return r <= third ? "rr-r-good" : r > TEAMS() - third ? "rr-r-bad" : "rr-r-mid";
  };

  // `openRid` not `open`: a module-scope `open` shadows window.open for the whole IIFE.
  let DATA = null, sel = null, openRid = null;
  /* Standings arrive separately and may not arrive at all. `state` is the honest three-way: we
     haven't asked yet, we asked and Sleeper answered, we asked and it didn't. Each one changes what
     the table is sorted by, and the panel says which. */
  let STAND = null, standState = "pending", standErr = "";
  let leaguePainted = false;

  const played = () => !!STAND && [...STAND.values()].some((s) => s.w + s.l + s.t > 0);

  /* ----------------------------------------------------------------- the league table */
  function order(a, b) {
    // Wins, then points for — the same key Sleeper seeds playoffs on. Before anyone has played,
    // that key is an N-way tie, so the projection breaks it and the panel meta says so out loud
    // rather than presenting an arbitrary order as a standing.
    if (played()) {
      const x = STAND.get(a.roster_id), y = STAND.get(b.roster_id);
      return y.w - x.w || y.pf - x.pf || a.starter_rank - b.starter_rank;
    }
    return a.starter_rank - b.starter_rank;
  }

  function paintLeague() {
    const teams = [...DATA.teams].sort(order);
    const max = Math.max(...teams.map((t) => t.starter_pts));
    const min = Math.min(...teams.map((t) => t.starter_pts));
    // Bar width is scaled across the observed range, not from zero: every team fields ten starters,
    // so the interesting variance is the last few percent and a zero-based bar hides all of it.
    const frac = (p) => max === min ? 1 : 0.08 + 0.92 * ((p - min) / (max - min));
    const live = standState === "ok";
    const COLS = 9;
    const cut = A.playoff_teams ?? 6;

    /* Last column, and which one it is depends on what the league can actually know. A league with
       a transaction archive gets the behavioural read - a trade-appetite band. A year-one league has
       no evidence for one, so it gets the moves its teams have actually made this season, which is
       zero for everybody until somebody churns and is never wrong in the meantime. */
    const lastCell = (t) => {
      if (t.tendencies) {
        const a = t.tendencies.appetite;
        return `<span class="rr-app rr-app-${esc(a.band)}" title="${esc(a.note)}">${esc(a.band)}<span class="rr-appn"> · ${a.n}</span></span>`;
      }
      if (t.moves) {
        return `<span class="rr-app rr-app-${t.moves.n === 0 ? "quiet" : "busy"}" title="${esc(t.moves.note)}">${t.moves.n}</span>`;
      }
      return `<span class="faint">—</span>`;
    };

    const rec = (t) => {
      if (!live) return `<td class="num rr-c-rec faint">—</td><td class="num rr-c-pf faint">—</td>`;
      const s = STAND.get(t.roster_id);
      return `<td class="num rr-c-rec">${s.w}-${s.l}${s.t ? `-${s.t}` : ""}${
        s.streak ? `<span class="rr-strk ${/L$/.test(s.streak) ? "streak-l" : "streak-w"}">${esc(s.streak)}</span>` : ""}</td>
        <td class="num rr-c-pf pf-cell"><span class="pf-val">${s.pf.toFixed(1)}</span></td>`;
    };

    let body = "";
    teams.forEach((t, i) => {
      // The playoff line is only drawn once it means something. A field of 0-0 teams has no top six.
      if (live && played() && i === cut && teams.length > cut) {
        body += `<tr class="cutrow"><td colspan="${COLS}"><div class="cutlabel">playoff line · top ${cut}</div></td></tr>`;
      }
      const s = t.strengths[0], w = t.weaknesses[0];
      const isOpen = openRid === t.roster_id;
      body += `<tr class="rr-lrow${t.is_me ? " me" : ""}${t.roster_id === sel ? " on" : ""}"
          data-rid="${t.roster_id}" tabindex="0" role="button" aria-expanded="${isOpen}">
          <td class="num rr-rk">${i + 1}</td>
          <td class="rr-own"><span class="rr-caret" aria-hidden="true">${isOpen ? "▼" : "▶"}</span> ${esc(t.owner)}${
            t.is_me ? ` <span class="rr-you">you</span>` : ""}</td>
          ${rec(t)}
          <td class="num pf-cell"><span class="pf-bar" style="width:${(frac(t.starter_pts) * 100).toFixed(1)}%"></span><span class="pf-val">${num(t.starter_pts)}</span></td>
          <td class="num rr-c-vs ${signCls(t.vs_league_median)}">${sign(t.vs_league_median)}</td>
          <td class="rr-sw rr-c-sw">${s ? `<span class="rr-pos">${esc(s.pos)}</span> <span class="faint">${ORD(s.rank)}</span>` : `<span class="faint">none</span>`}</td>
          <td class="rr-sw rr-c-sw">${w ? `<span class="rr-neg">${esc(w.pos)}</span> <span class="faint">${ORD(w.rank)}</span>` : `<span class="faint">none</span>`}</td>
          <td class="rr-c-tr">${lastCell(t)}</td>
        </tr>`;
      if (isOpen) {
        body += `<tr class="rr-exprow"><td colspan="${COLS}">
          <div class="rr-exp">
            <div class="rr-exphead">
              <b>${esc(t.owner)}</b><span class="faint">${esc(window.HBGB_RosterTable.meta(t))}</span>
              <span class="faint">click any name for the latest published on that player</span>
            </div>
            ${window.HBGB_RosterTable.html(t, { split: true, teams: TEAMS() })}
          </div></td></tr>`;
      }
    });

    // Bars sweep out once, on first paint. The table re-renders on every row you open and when the
    // standings land, and a chart that re-animates each time is a slot machine, not a comparison.
    $("#rr-league-body").innerHTML = `<table class="rr-ltab${leaguePainted ? "" : " bars-in"}" aria-label="Every team${live && played() ? ", by standings" : ", by projected starting points"}">
      <thead><tr>
        <th class="num" title="${live && played() ? "Standings position — wins, then points for" : "Ordered by projected starting points; nobody has played yet"}">#</th>
        <th>Team</th>
        <th class="num rr-c-rec" title="Live from Sleeper">Rec</th>
        <th class="num rr-c-pf" title="Points scored so far, live from Sleeper">PF</th>
        <th class="num" title="Projected points from an optimal lineup under this league's slot shape">Proj</th>
        <th class="num rr-c-vs" title="Projected starting points minus the league median">vs med</th>
        <th class="rr-c-sw">Strength</th><th class="rr-c-sw">Hole</th>
        ${DATA.teams[0] && DATA.teams[0].tendencies
          ? `<th class="rr-c-tr" title="Completed trades 2020-2025, from the raw Sleeper archive">Trades</th>`
          : `<th class="num rr-c-tr" title="Completed transactions this season — trades, waiver claims and free-agent adds, live from Sleeper">Moves</th>`}
      </tr></thead>
      <tbody>${body}</tbody></table>`;
    leaguePainted = true;

    $("#rr-league-body").querySelectorAll(".rr-lrow").forEach((row) => {
      const go = () => select(+row.dataset.rid, { toggle: true });
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function paintLeagueMeta() {
    const base = `${DATA.teams.length} teams · median ${DATA.coverage.league_median_starters} projected starting points`;
    const el = $("#rr-league-meta");
    if (standState === "pending") { el.textContent = `${base} · loading standings…`; return; }
    if (standState === "err") {
      el.innerHTML = `${esc(base)} · <span class="rr-neg">standings unavailable (${esc(standErr)})</span> — ordered by projection`;
      return;
    }
    el.textContent = played()
      ? `${base} · ordered by standings`
      : `${base} · every record is 0-0, so the order is the projection until week 1`;
  }

  /* --------------------------------------------------------------- summary + shape + risk */
  function paintSummary(t) {
    $("#rr-sum-meta").textContent = `${ORD(t.starter_rank)} of ${TEAMS()} by projection${t.draft_slot ? ` · drafted from slot ${t.draft_slot}` : ""}`;
    $("#rr-sum-body").innerHTML = `<p class="rr-summary">${esc(t.summary)}</p>`;
  }

  function paintShape(t) {
    // One bar per position, centred on the league median so a deficit reads as a bar to the left.
    // Absolute totals across positions aren't comparable (QB fills one slot, WR up to four), so
    // the only honest comparison is each position against the same position elsewhere.
    const rows = t.by_pos;
    const span = Math.max(60, ...rows.map((r) => Math.abs(r.vs_median)));
    // Bars sweep out once, on the first team you open. This panel re-renders on every click in the
    // league table, and re-animating there would make flicking between teams feel like a slideshow.
    $("#rr-shape-body").innerHTML = `<div class="rr-shape${shapePainted ? "" : " bars-in"}">${rows.map((r, i) => {
      const w = Math.min(50, (Math.abs(r.vs_median) / span) * 50);
      const streamed = r.pos === "K" || r.pos === "DEF";
      return `<div class="rr-srow${streamed ? " rr-stream" : ""}">
        <span class="rr-spos">${esc(r.pos)}</span>
        <span class="rr-sbar" aria-hidden="true">
          <span class="rr-smid"></span>
          <span class="rr-sfill ${r.vs_median >= 0 ? "up" : "down"}" style="--i:${i};${r.vs_median >= 0 ? "left:50%" : `right:50%`};width:${w}%"></span>
        </span>
        <span class="num rr-spts">${num(r.pts)}</span>
        <span class="num rr-svs ${signCls(r.vs_median)}">${sign(r.vs_median)}</span>
        <span class="rr-srk ${streamed ? "rr-r-mid" : rankCls(r.rank)}">${ORD(r.rank)}</span>
        <span class="rr-scnt faint">${r.starters} starting of ${r.rostered}</span>
      </div>`;
    }).join("")}</div>
    <p class="rr-note">K and DEF are shown but never graded — they're streaming positions in this format, and a
      rank at either says nothing about the roster.</p>`;
    shapePainted = true;
  }
  let shapePainted = false;

  function paintRisks(t) {
    const r = t.risks, out = [];
    if (r.bye_stacks.length) {
      out.push(`<div class="rr-risk rr-risk-bye"><b>Bye stacks.</b> ${r.bye_stacks.map((b) =>
        `Week ${b.week} takes ${b.n} starters (${esc(b.players.join(", "))})`).join("; ")}. Five bench spots don't cover a triple.</div>`);
    }
    if (r.injured.length) {
      out.push(`<div class="rr-risk rr-risk-inj"><b>Carrying a designation.</b> ${r.injured.map((p) =>
        `${esc(p.name)} <span class="rr-inj">${esc(p.status)}</span>`).join(", ")}.</div>`);
    }
    if (r.fragile.length) {
      out.push(`<div class="rr-risk"><b>Availability.</b> ${r.fragile.map((p) =>
        `${esc(p.name)} <span class="mono">${p.score.toFixed(2)}</span>${p.why ? ` <span class="faint">— ${esc(p.why)}</span>` : ""}`).join("<br>")}</div>`);
    }
    if (r.flagged.length) {
      out.push(`<div class="rr-risk"><b>Flagged.</b> ${r.flagged.map((p) =>
        `${esc(p.name)}${p.notes.length ? ` <span class="faint">— ${esc(p.notes[0])}</span>` : ""}`).join("<br>")}</div>`);
    }
    $("#rr-risk-body").innerHTML = out.length ? out.join("")
      : `<div class="loading">No bye stack of three, no injury designation, no availability score under 0.90 among the starters.</div>`;
  }

  function paintTendencies(t) {
    // The panel is removed from the markup on a league with no dossiers (data-league-only in
    // rosters.html), so this is the belt to that braces: a league that grows tendencies later needs
    // no change here, and one without them can never reach a null dereference.
    if (!$("#rr-tend-body")) return;
    if (!t.tendencies) {
      $("#rr-tend-body").innerHTML = `<div class="loading">${esc(A.name)} is in its first season, so there is
        no owner history to read. The league table reports completed moves this season instead.</div>`;
      return;
    }
    const d = t.tendencies, rows = [
      ["draft", d.draft], ["FAAB", d.faab], ["trades", d.trades], ["history", d.history],
    ].filter(([, v]) => v);
    // .exploit is the one line written as an instruction to me. On my own card it's a self-scout,
    // so it gets labelled as such rather than telling me how to beat myself.
    const playLabel = t.is_me ? "fix" : "exploit";
    $("#rr-tend-body").innerHTML = `
      <div class="rr-appetite rr-app-${esc(d.appetite.band)}">
        <b>${esc(d.appetite.band)}</b> — ${esc(d.appetite.note)}
        ${!t.is_me && d.channel_with_me ? ` You've traded with this owner <b>${d.channel_with_me}</b> time${d.channel_with_me === 1 ? "" : "s"} since 2020.` : ""}
      </div>
      ${rows.map(([k, v]) => `<div class="rr-tend"><span class="rr-tkey">${esc(k)}</span><span class="rr-tval">${md(v)}</span></div>`).join("")}
      ${d.exploit ? `<div class="rr-tend rr-tend-play"><span class="rr-tkey">${playLabel}</span><span class="rr-tval">${md(d.exploit)}</span></div>` : ""}`;
  }

  // The dossiers are markdown prose. Only bold and em survive the trip — everything else is escaped,
  // because this text is rendered as HTML and the file it comes from is edited by hand.
  const md = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  /* ------------------------------------------------------------------------- trade panel */
  function paintTrade(t) {
    if (t.is_me) {
      $("#rr-trade-meta").textContent = "";
      $("#rr-trade-body").innerHTML = `<div class="loading">This is your roster. Open any other team to see what
        moves between you — proposals are searched from your side only.</div>`;
      return;
    }
    const f = t.fit, ps = t.proposals;
    $("#rr-trade-meta").textContent = ps.length
      ? `${ps.length} deal${ps.length === 1 ? "" : "s"} where both lineups rise`
      : "no deal clears the two-sided bar";

    const chip = (p) => `<span class="rr-pl">${window.HBGB_PlayerNews.link(p, "pn-strong")} <span class="faint">${esc(p.pos)}${p.team ? " " + esc(p.team) : ""}</span> <span class="mono">${num(p.pts, 0)}</span></span>`;

    const deals = ps.length ? ps.map((p) => `
      <div class="rr-deal">
        <div class="rr-drow">
          <span class="rr-kind rr-kind-${p.kind === "2-for-1" ? "cons" : "even"}">${esc(p.kind)}</span>
          <span class="rr-give">${p.give.map(chip).join(" + ")}</span>
          <span class="rr-arrow" aria-label="for">⇄</span>
          <span class="rr-get">${p.get.map(chip).join(" + ")}</span>
        </div>
        <div class="rr-dgain">
          <span class="rr-pos">you ${sign(p.my_gain, 1)}</span>
          <span class="faint">·</span>
          <span class="rr-them">them ${sign(p.their_gain, 1)}</span>
          <span class="faint">projected starting points over the season</span>
          ${p.frees_bench ? `<span class="rr-frees" title="Two out, one in — and with only five bench spots, that spare slot is real value in this format.">frees a bench spot</span>` : ""}
        </div>
      </div>`).join("")
      : `<div class="rr-nodeal">Nothing here raises <em>both</em> optimal lineups by the threshold, so nothing is
         proposed. That's the common case after a draft — it doesn't mean there's no conversation, it means any
         deal needs a sweetener or a disagreement about the projections.</div>`;

    const fitList = (arr, empty) => arr.length ? `<ul class="rr-fit">${arr.map((p) => `<li>
        ${chip(p)}
        <span class="num rr-net rr-pos" title="What he adds to the receiving lineup minus what he costs the one giving him up">${sign(p.net, 1)}</span>
        <span class="faint rr-fitcost">costs the seller ${num(p.cost, 1)}</span>
      </li>`).join("")}</ul>` : `<div class="loading">${empty}</div>`;

    $("#rr-trade-body").innerHTML = `
      ${deals}
      <div class="rr-fitwrap">
        <p class="rr-note">${md(f.note)}</p>
        <div class="rr-fitcols">
          <div>
            <h3 class="rr-fh">Worth more to you</h3>
            ${fitList(f.they_have, "Nothing of theirs is worth more in your lineup than in theirs.")}
          </div>
          <div>
            <h3 class="rr-fh">Worth more to them</h3>
            ${fitList(f.they_want, "Nothing of yours is worth more in their lineup than in yours.")}
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------------------------ select */
  function select(rid, opts = {}) {
    const t = DATA.teams.find((x) => x.roster_id === rid);
    if (!t) return;
    // Clicking the row that is already open closes it. The analysis panels keep showing that team:
    // collapsing the roster is a request for less table, not a request to stop scouting them.
    openRid = opts.toggle && openRid === rid ? null : rid;
    sel = rid;
    $("#rr-analysis-h").textContent = `${t.owner}${t.is_me ? " — you" : ""}`;
    paintLeague();
    paintSummary(t); paintShape(t); paintRisks(t); paintTendencies(t); paintTrade(t);
    history.replaceState(null, "", `?team=${rid}`);
    if (openRid === rid && opts.scroll !== false) {
      const row = $(`.rr-lrow[data-rid="${rid}"]`);
      // "nearest" so a row already in view doesn't move at all; the smooth scroll is skipped
      // entirely under reduced motion, where CSS can't reach a scrollIntoView option.
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (row) row.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
    }
  }

  function paintMethod() {
    const b = DATA.basis;
    $("#rr-method-body").innerHTML = `<dl class="rr-meth">${
      Object.entries(b).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
      <dt>coverage</dt><dd>${DATA.coverage.priced} of ${DATA.coverage.rostered} rostered players priced${
        DATA.coverage.off_board_priced ? ` (${DATA.coverage.off_board_priced} of them from outside the draft board's top-200 pool, fetched and re-scored the same way)` : ""}.
        League median starting total ${DATA.coverage.league_median_starters}.</dd>
      <dt>standings</dt><dd>Wins and points for come live from the Sleeper API on every page load, not from the
        published file — they move weekly and the room is rebuilt on demand. The table sorts on them once
        anybody has played; before that it sorts on the projection and says so.</dd>
      ${DATA.trade_history
        ? `<dt>trade archive</dt><dd>${DATA.trade_history.total} completed trades, ${esc(DATA.trade_history.seasons)}: ${
            Object.entries(DATA.trade_history.by_year).map(([y, n]) => `${y} ${n}`).join(" · ")}.</dd>`
        : `<dt>moves</dt><dd>${esc(A.name)} has no trade archive — it is in its first season. The Moves column counts
            completed transactions this season straight off Sleeper${DATA.season_moves
              ? `: ${DATA.season_moves.total} through week ${DATA.season_moves.through_week}`
              : ""}. It is zero for everybody until somebody makes one, which is the honest state of a
            brand-new league rather than a borrowed read from another one.</dd>`}
    </dl>`;
  }

  /* --------------------------------------------------------------------------- standings */
  async function loadStandings() {
    try {
      // Sleeper sits behind Cloudflare with stale-while-revalidate, so every read of a moving
      // endpoint carries a unique param. See CLAUDE.md — this has bitten the draft tooling before.
      const r = await fetch(`${C.API}/league/${A.league_id}/rosters?cb=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rows = await r.json();
      STAND = new Map(rows.map((x) => [x.roster_id, {
        w: x.settings.wins ?? 0, l: x.settings.losses ?? 0, t: x.settings.ties ?? 0,
        pf: (x.settings.fpts ?? 0) + (x.settings.fpts_decimal ?? 0) / 100,
        streak: x.metadata?.streak ?? "",
      }]));
      // A roster missing from the response would sort as undefined and throw in order(); better to
      // fall back to the projection than to half-apply a standing.
      if (DATA.teams.some((t) => !STAND.has(t.roster_id))) throw new Error("roster ids don't line up");
      standState = "ok";
    } catch (e) {
      STAND = null; standState = "err"; standErr = e.message;
    }
    paintLeagueMeta();
    if (DATA) paintLeague();
  }

  /* -------------------------------------------------------------------------------- boot */
  (async () => {
    let d;
    try {
      const r = await fetch(A.ROSTER_ROOM_JSON, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      d = await r.json();
    } catch (e) {
      const el = $("#rr-err");
      el.hidden = false;
      el.innerHTML = `<div class="panel-error" role="alert">No published roster room for ${esc(A.name)} (${esc(e.message)}).
        Run <code>node scripts/build-roster-room.mjs --league=${esc(A.key)}</code> — it writes <code>${esc(A.data)}/roster-room.json</code>.
        The build refuses to run until every roster has players, so before the draft this page is empty by design.</div>`;
      $("#rr-league-body").innerHTML = "";
      $("#rr-sum-body").innerHTML = "";
      $("#rr-meta").textContent = "unavailable";
      return;
    }
    DATA = d;

    const age = (Date.now() - new Date(d.generated).getTime()) / 864e5;
    $("#rr-meta").textContent = `${d.league.name} · ${d.league.season} · built ${d.generated}`;
    $("#rr-meta").classList.add("live");
    paintLeagueMeta();
    if (age > 3) {
      $("#rr-err").hidden = false;
      $("#rr-err").innerHTML = `<div class="stale-warn">This room was built ${Math.floor(age)} days ago.
        Rosters move — re-run <code>node scripts/build-roster-room.mjs</code>.</div>`;
    }

    paintMethod();
    const want = +new URLSearchParams(location.search).get("team");
    const mine = d.teams.find((t) => t.is_me);
    select(d.teams.some((t) => t.roster_id === want) ? want : (mine ? mine.roster_id : d.teams[0].roster_id),
      { scroll: false });
    loadStandings();
  })();
})();
