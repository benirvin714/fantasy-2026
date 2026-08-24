/* Roster room — the ten teams as scouting objects.
   Renders data/site/roster-room.json, published by scripts/build-roster-room.mjs. Same rule as
   every other page here: no analysis is generated in the browser, and a missing feed produces a
   stated error rather than a blank panel that reads as "nothing to report". */
(() => {
  const C = window.HQ_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const num = (n, d = 0) => n == null ? "—" : Number(n).toFixed(d);
  const sign = (n, d = 0) => n == null ? "—" : `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`;
  const signCls = (n) => n == null ? "" : n > 0 ? "rr-pos" : n < 0 ? "rr-neg" : "rr-zero";
  const ORD = (n) => ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th"][n] ?? `${n}th`;
  // Rank colour is a three-way read, not a gradient: top third, bottom third, and the middle that
  // deliberately gets no colour at all so the extremes stay legible.
  const rankCls = (r) => r <= 3 ? "rr-r-good" : r >= 8 ? "rr-r-bad" : "rr-r-mid";

  let DATA = null, sel = null;

  /* ----------------------------------------------------------------- the league table */
  function paintLeague() {
    const teams = [...DATA.teams].sort((a, b) => a.starter_rank - b.starter_rank);
    const max = Math.max(...teams.map((t) => t.starter_pts));
    const min = Math.min(...teams.map((t) => t.starter_pts));
    // Bar width is scaled across the observed range, not from zero: every team fields ten starters,
    // so the interesting variance is the last few percent and a zero-based bar hides all of it.
    const frac = (p) => max === min ? 1 : 0.08 + 0.92 * ((p - min) / (max - min));

    $("#rr-league-body").innerHTML = `<table class="rr-ltab" aria-label="Every team by projected starting points">
      <thead><tr>
        <th class="num">#</th><th>Team</th><th class="num">Starters</th>
        <th class="num" title="Projected starting points minus the league median">vs med</th>
        <th>Strength</th><th>Hole</th>
        <th title="Completed trades 2020-2025, from the raw Sleeper archive">Trades</th>
      </tr></thead>
      <tbody>${teams.map((t) => {
        const s = t.strengths[0], w = t.weaknesses[0];
        return `<tr class="rr-lrow${t.is_me ? " me" : ""}${t.roster_id === sel ? " on" : ""}" data-rid="${t.roster_id}" tabindex="0" role="button" aria-pressed="${t.roster_id === sel}">
          <td class="num rr-rk">${t.starter_rank}</td>
          <td class="rr-own">${esc(t.owner)}${t.is_me ? ` <span class="rr-you">you</span>` : ""}</td>
          <td class="num pf-cell"><span class="pf-bar" style="width:${(frac(t.starter_pts) * 100).toFixed(1)}%"></span><span class="pf-val">${num(t.starter_pts)}</span></td>
          <td class="num ${signCls(t.vs_league_median)}">${sign(t.vs_league_median)}</td>
          <td class="rr-sw">${s ? `<span class="rr-pos">${esc(s.pos)}</span> <span class="faint">${ORD(s.rank)}</span>` : `<span class="faint">none</span>`}</td>
          <td class="rr-sw">${w ? `<span class="rr-neg">${esc(w.pos)}</span> <span class="faint">${ORD(w.rank)}</span>` : `<span class="faint">none</span>`}</td>
          <td><span class="rr-app rr-app-${esc(t.tendencies.appetite.band)}" title="${esc(t.tendencies.appetite.note)}">${esc(t.tendencies.appetite.band)}<span class="rr-appn"> · ${t.tendencies.appetite.n}</span></span></td>
        </tr>`;
      }).join("")}</tbody></table>`;

    $("#rr-league-body").querySelectorAll(".rr-lrow").forEach((row) => {
      const go = () => select(+row.dataset.rid);
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  /* ------------------------------------------------------------------------ the roster */
  function paintRoster(t) {
    const line = (s) => {
      const p = s.player;
      if (!p) return `<tr><td class="rr-slot">${esc(s.slot)}</td><td colspan="4" class="faint">empty</td></tr>`;
      return `<tr>
        <td class="rr-slot">${esc(s.slot)}</td>
        <td class="rr-nm">${esc(p.name)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
        <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
        <td class="num">${num(p.pts, 1)}</td>
        <td class="num rr-slotrk ${rankCls(s.rank)}" title="Rank of this slot against the other nine teams · ${sign(s.vs_median, 1)} vs the slot median">${s.rank}<span class="rr-vs ${signCls(s.vs_median)}">${sign(s.vs_median)}</span></td>
      </tr>`;
    };

    const bench = t.bench.map((p) => `<tr>
      <td class="rr-slot rr-bn">BN</td>
      <td class="rr-nm">${esc(p.name)}</td>
      <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
      <td class="num">${num(p.pts, 1)}</td>
      <td class="num rr-starts ${p.starts_on >= 4 ? "rr-r-good" : p.starts_on === 0 ? "rr-r-bad" : "rr-r-mid"}"
          title="Would start on ${p.starts_on} of the other nine teams, measured by recomputing each of their optimal lineups with him inserted. Best single gain: ${sign(p.best_gain, 1)} points.">${p.starts_on}/9</td>
    </tr>`).join("");

    $("#rr-roster-meta").textContent = `${t.starter_pts.toFixed(0)} starting · ${t.bench_pts.toFixed(0)} on the bench`;
    $("#rr-roster-body").innerHTML = `<table class="rr-rtab" aria-label="${esc(t.owner)} roster">
        <thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Proj</th>
          <th class="num" title="Starters: this slot's rank against the other nine teams. Bench: how many of the other nine he would start for.">Rk</th></tr></thead>
        <tbody>${t.slots.map(line).join("")}
          <tr class="rr-div"><td colspan="5"><div class="cutlabel">bench · 5 spots, and that is the whole margin</div></td></tr>
          ${bench}</tbody></table>
      ${t.unpriced.length ? `<div class="rr-unpriced">Unpriced and excluded from every total here: ${
        t.unpriced.map((u) => esc(u.name)).join(", ")}. No 2026 projection — counted as zero would fake a weakness.</div>` : ""}`;
  }

  /* --------------------------------------------------------------- summary + shape + risk */
  function paintSummary(t) {
    $("#rr-sum-meta").textContent = `${ORD(t.starter_rank)} of 10${t.draft_slot ? ` · drafted from slot ${t.draft_slot}` : ""}`;
    $("#rr-sum-body").innerHTML = `<p class="rr-summary">${esc(t.summary)}</p>`;
  }

  function paintShape(t) {
    // One bar per position, centred on the league median so a deficit reads as a bar to the left.
    // Absolute totals across positions aren't comparable (QB fills one slot, WR up to four), so
    // the only honest comparison is each position against the same position elsewhere.
    const rows = t.by_pos;
    const span = Math.max(60, ...rows.map((r) => Math.abs(r.vs_median)));
    $("#rr-shape-body").innerHTML = `<div class="rr-shape">${rows.map((r) => {
      const w = Math.min(50, (Math.abs(r.vs_median) / span) * 50);
      const streamed = r.pos === "K" || r.pos === "DEF";
      return `<div class="rr-srow${streamed ? " rr-stream" : ""}">
        <span class="rr-spos">${esc(r.pos)}</span>
        <span class="rr-sbar" aria-hidden="true">
          <span class="rr-smid"></span>
          <span class="rr-sfill ${r.vs_median >= 0 ? "up" : "down"}" style="${r.vs_median >= 0 ? "left:50%" : `right:50%`};width:${w}%"></span>
        </span>
        <span class="num rr-spts">${num(r.pts)}</span>
        <span class="num rr-svs ${signCls(r.vs_median)}">${sign(r.vs_median)}</span>
        <span class="rr-srk ${streamed ? "rr-r-mid" : rankCls(r.rank)}">${ORD(r.rank)}</span>
        <span class="rr-scnt faint">${r.starters} starting of ${r.rostered}</span>
      </div>`;
    }).join("")}</div>
    <p class="rr-note">K and DEF are shown but never graded — they're streaming positions in this format, and a
      rank at either says nothing about the roster.</p>`;
  }

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

    const chip = (p) => `<span class="rr-pl"><b>${esc(p.name)}</b> <span class="faint">${esc(p.pos)}${p.team ? " " + esc(p.team) : ""}</span> <span class="mono">${num(p.pts, 0)}</span></span>`;

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
  function select(rid) {
    sel = rid;
    const t = DATA.teams.find((x) => x.roster_id === rid);
    if (!t) return;
    $("#rr-roster-h").textContent = `${t.owner}${t.is_me ? " — you" : ""}`;
    paintLeague();
    paintRoster(t); paintSummary(t); paintShape(t); paintRisks(t); paintTendencies(t); paintTrade(t);
    history.replaceState(null, "", `?team=${rid}`);
  }

  function paintMethod() {
    const b = DATA.basis;
    $("#rr-method-body").innerHTML = `<dl class="rr-meth">${
      Object.entries(b).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
      <dt>coverage</dt><dd>${DATA.coverage.priced} of ${DATA.coverage.rostered} rostered players priced${
        DATA.coverage.off_board_priced ? ` (${DATA.coverage.off_board_priced} of them from outside the draft board's top-200 pool, fetched and re-scored the same way)` : ""}.
        League median starting total ${DATA.coverage.league_median_starters}.</dd>
      <dt>trade archive</dt><dd>${DATA.trade_history.total} completed trades, ${esc(DATA.trade_history.seasons)}: ${
        Object.entries(DATA.trade_history.by_year).map(([y, n]) => `${y} ${n}`).join(" · ")}.</dd>
    </dl>`;
  }

  /* -------------------------------------------------------------------------------- boot */
  (async () => {
    let d;
    try {
      const r = await fetch(C.ROSTER_ROOM_JSON, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      d = await r.json();
    } catch (e) {
      const err = $("#rr-err");
      err.hidden = false;
      err.innerHTML = `<div class="panel-error" role="alert">No published roster room (${esc(e.message)}).
        Run <code>node scripts/build-roster-room.mjs</code> — it writes <code>data/site/roster-room.json</code>.
        The build refuses to run until every roster has players, so before the draft this page is empty by design.</div>`;
      $("#rr-league-body").innerHTML = "";
      $("#rr-roster-body").innerHTML = "";
      $("#rr-sum-body").innerHTML = "";
      $("#rr-meta").textContent = "unavailable";
      return;
    }
    DATA = d;

    const age = (Date.now() - new Date(d.generated).getTime()) / 864e5;
    $("#rr-meta").textContent = `${d.league.name} · ${d.league.season} · built ${d.generated}`;
    $("#rr-meta").classList.add("live");
    $("#rr-league-meta").textContent =
      `${d.teams.length} teams · median ${d.coverage.league_median_starters} starting points · ${d.coverage.priced}/${d.coverage.rostered} priced`;
    if (age > 3) {
      $("#rr-err").hidden = false;
      $("#rr-err").innerHTML = `<div class="stale-warn">This room was built ${Math.floor(age)} days ago.
        Rosters move — re-run <code>node scripts/build-roster-room.mjs</code>.</div>`;
    }

    paintMethod();
    const want = +new URLSearchParams(location.search).get("team");
    const mine = d.teams.find((t) => t.is_me);
    select(d.teams.some((t) => t.roster_id === want) ? want : (mine ? mine.roster_id : d.teams[0].roster_id));
  })();
})();
