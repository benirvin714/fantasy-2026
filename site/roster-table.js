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
   from scripts/build-roster-room.mjs.

   TWO BASES, and which one a table is on is the caller's choice. Without `opts.week` every number
   is a season projection, which is the basis a trade or a roster-strength read wants. With it, the
   table grows a Game column and the projection column becomes that week's points - the basis a
   Sunday lineup wants. The Game column is itself two things over the life of a week: the kickoff
   before the game, the result after it, because the time a finished game started is the least
   useful fact the cell could hold. HQ's My roster passes the week; the roster room's expanded rows do not,
   because the ranks in those rows are computed from season projections and a week number sitting
   under a season rank invites reading one as the other. The Rk column stays season-based in both
   and says so, because the optimal lineup itself is chosen on season points: re-ranking that lineup
   by a single week would be measuring something the lineup was not built to answer. */
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

  /* ---------------------------------------------------------------- the week, when a caller wants it
     Set per render from opts.week — the `week` block off that league's roster-room.json. Null means
     the caller asked for the season view, and then this file renders exactly what it always did.

     The two are a package on purpose. A Game column next to a season point total is a column about
     Sunday sitting beside a number about January, and the reader has to hold both bases in their
     head to read one row. So a caller that turns on the week gets the week everywhere in the table:
     the projection column switches with it and the header says which week it is. */
  let WK = null;

  /* Rendered from the kickoff instant, in the reader's own timezone, every time the table paints.
     Deliberately not a formatted string baked into the JSON: that would freeze one timezone into
     the data, and it would go wrong twice a year when the offset moves under it. */
  const kickoffCell = (g, p) => {
    /* Once a game is over the time it started is the least interesting thing about it, so the
       result takes the cell. `week_actual` is only attached by the build when the schedule says
       the game is done (or in progress), never when a points value merely exists - every rostered
       player carries a 0 from kickoff onward, and a 0 that means "has not played" and a 0 that
       means "played and did nothing" are the two readings a lineup decision most needs apart. */
    const a = p && p.week_actual;
    if (a && a.pts != null) {
      const proj = p.week_pts;
      const vs = proj != null
        ? ` Projected ${proj.toFixed(1)}, so ${Math.abs(a.pts - proj).toFixed(1)} ${a.pts >= proj ? "over" : "under"}.`
        : " No week projection was published for him, so there is nothing to compare it against.";
      const where = g && g.opp ? `${g.home ? "vs " : "at "}${g.opp}` : "";
      const when = g && g.kickoff
        ? new Date(g.kickoff).toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "";
      return a.final
        ? `<span class="rr-gm-fin" title="Final${where ? ` ${esc(where)}` : ""}${when ? ` · ${esc(when)}` : ""} · ${a.pts.toFixed(1)} points in this league's own scoring, read from its Sleeper matchup rather than recomputed here.${esc(vs)}">${num(a.pts, 1)}</span>`
        : `<span class="rr-gm-live" title="IN PROGRESS when this page's data was built${where ? `, ${esc(where)}` : ""} · ${a.pts.toFixed(1)} points so far, not a final score. Rebuild the roster room for a current figure.${esc(vs)}">${num(a.pts, 1)}<span class="rr-gm-dot">·</span></span>`;
    }
    if (!g) return `<span class="faint" title="No week in this build. Rebuild the roster room to attach one.">—</span>`;
    if (g.status === "bye") return `<span class="rr-gm-bye" title="On bye in week ${g.week} — no game, and no projection to show beside it.">BYE</span>`;
    if (g.status === "canceled") {
      return `<span class="rr-gm-off" title="Week ${g.week}${g.opp ? ` against ${g.opp}` : ""} is listed as canceled in the NFL schedule. Not a bye — the game was called off.">off</span>`;
    }
    if (g.status === "unknown") {
      return `<span class="faint" title="Week ${g.week} has neither a game nor a bye for this team in the schedule. That is a gap in the source, not a quiet bye — see the build log.">?</span>`;
    }
    const where = g.opp ? `${g.home ? "vs " : "at "}${g.opp}` : "opponent unknown";
    if (!g.kickoff) {
      // Sleeper gave the date, ESPN did not give the time. Say the day and nothing more.
      const d = g.date ? new Date(`${g.date}T12:00:00`) : null;
      return `<span class="rr-gm" title="${esc(where)}, week ${g.week}. Kickoff time unavailable from the schedule — only the date is published.">${
        d ? esc(d.toLocaleDateString(undefined, { weekday: "short" })) : "—"}</span>`;
    }
    const d = new Date(g.kickoff);
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    // "12:00 PM" -> "12:00p". A 24-hour locale has no AM/PM to strip, so it falls through as "19:20".
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      .replace(/\s*([AP])M$/i, (_, m) => m.toLowerCase());
    const past = d.getTime() < Date.now();
    const full = d.toLocaleString(undefined, { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<span class="rr-gm${past ? " rr-gm-past" : ""}" title="${esc(where)} · ${esc(full)}${
      past ? " — kicked off already. No result here yet: this page's data is rebuilt twice a day, so a score appears at the next build after the game ends" : ""}">${esc(day)} ${esc(time)}</span>`;
  };

  // The projection cell, on whichever basis this render is using. A null week number is a dash, not
  // a zero: Sleeper publishes no week line for a player it has as out, and 0.0 would read as a
  // forecast rather than as an absence.
  const projCell = (p) => WK
    ? `<td class="num rr-wkpts">${p.week_pts == null
        ? `<span class="faint" title="No week-${WK.n} projection published for ${esc(p.name)}${p.injury ? ` — Sleeper has him ${esc(p.injury)}` : ""}. Not a forecast of zero.">—</span>`
        : num(p.week_pts, 1)}</td>`
    : `<td class="num">${num(p.pts, 1)}</td>`;

  const gameCell = (p) => WK ? `<td class="rr-gmc">${kickoffCell(p.game, p)}</td>` : "";

  const startRow = (s) => {
    const p = s.player;
    if (!p) return `<tr><td class="rr-slot">${esc(s.slot)}</td><td colspan="${WK ? 5 : 4}" class="faint">empty</td></tr>`;
    return `<tr>
      <td class="rr-slot">${esc(s.slot)}</td>
      <td class="rr-nm">${name(p)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
      <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
      ${gameCell(p)}
      ${projCell(p)}
      <td class="num rr-slotrk ${rankCls(s.rank)}" title="Rank of this slot against the other ${spell(OTHERS)} teams over the FULL SEASON · ${sign(s.vs_median, 1)} vs the slot median${WK ? ". Season-based whichever column sits beside it — the optimal lineup is built from season projections, so ranking it by one week would be measuring a different thing." : ""}">${s.rank}<span class="rr-vs ${signCls(s.vs_median)}">${sign(s.vs_median)}</span></td>
    </tr>`;
  };

  const benchRow = (p, withSlot) => `<tr>
    ${withSlot ? `<td class="rr-slot rr-bn">BN</td>` : ""}
    <td class="rr-nm">${name(p)}${p.injury ? ` <span class="rr-inj" title="Sleeper injury designation">${esc(p.injury)}</span>` : ""}</td>
    <td class="rr-pt">${esc(p.pos)}<span class="faint"> ${esc(p.team ?? "—")}</span></td>
    ${gameCell(p)}
    ${projCell(p)}
    <td class="num rr-starts ${p.starts_on >= 4 ? "rr-r-good" : p.starts_on === 0 ? "rr-r-bad" : "rr-r-mid"}"
        title="Would start on ${p.starts_on} of the other ${spell(OTHERS)} teams, measured by recomputing each of their optimal lineups with him inserted over the full season. Best single gain: ${sign(p.best_gain, 1)} points.">${p.starts_on}/${OTHERS}</td>
  </tr>`;

  const rkTip = () => `Starters: this slot's rank against the other ${spell(OTHERS)} teams. Bench: how many of the other ${spell(OTHERS)} he would start for. Both measured over the full season.`;

  // Header for the projection column, which is the one thing in this table that changes meaning.
  const projTh = () => WK
    ? `<th class="num" title="Projected points in week ${WK.n} only, in this league's scoring. ${esc(WK.projection_source ?? "Source unavailable.")}">Wk ${WK.n}</th>`
    : `<th class="num">Proj</th>`;
  const gameTh = () => WK
    ? `<th title="Before kickoff, when this player's week-${WK.n} game starts, in your timezone (${esc(WK.schedule_source ?? "source unavailable")}). Once it is over, what he actually scored${WK.result_source ? ` — ${esc(WK.result_source)}` : ""}.">Game</th>`
    : "";

  const unpriced = (t) => t.unpriced.length
    ? `<div class="rr-unpriced">Unpriced and excluded from every total here: ${
        t.unpriced.map((u) => esc(u.name)).join(", ")}. No 2026 projection — counted as zero would fake a weakness.</div>`
    : "";

  /* ---------- stacked: ten starters, a divider, five bench ---------- */
  function stacked(t) {
    return `<table class="rr-rtab${WK ? " rr-rtab-wk" : ""}" aria-label="${esc(t.owner)} roster">
        <thead><tr><th>Slot</th><th>Player</th><th>Pos</th>${gameTh()}${projTh()}
          <th class="num" title="${rkTip()}">Rk</th></tr></thead>
        <tbody>${t.slots.map(startRow).join("")}
          <tr class="rr-div"><td colspan="${WK ? 6 : 5}"><div class="cutlabel">bench · 5 spots, and that is the whole margin</div></td></tr>
          ${t.bench.map((p) => benchRow(p, true)).join("")}</tbody></table>
      ${unpriced(t)}${weekNote(t)}`;
  }

  /* The week's caveats, once under the table rather than repeated per row. Only the ones that are
     actually true of this build get printed: a clean week says nothing, which is the point. */
  function weekNote(t) {
    if (!WK) return "";
    const bits = [];
    const w = t.week;
    if (w && w.starter_n < w.starter_of) {
      bits.push(`${w.starter_of - w.starter_n} of your ${w.starter_of} starters ${w.starter_of - w.starter_n === 1 ? "has" : "have"} no week-${WK.n} projection, so the total is over ${w.starter_n}`);
    }
    if (WK.canceled && WK.canceled.length) bits.push(`canceled this week: ${WK.canceled.join("; ")}`);
    for (const warn of WK.warnings ?? []) bits.push(warn);
    if (!bits.length) return "";
    // A source warning arrives as a finished sentence; the counts above do not. Only punctuate the
    // ones that need it, or a clean line ends in "..".
    const line = bits.join(" · ");
    return `<p class="rr-wknote">${esc(/[.!?]$/.test(line) ? line : `${line}.`)}</p>`;
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
        <table class="rr-rtab${WK ? " rr-rtab-wk" : ""}" aria-label="${esc(t.owner)} starting lineup">
          <thead><tr><th>Slot</th><th>Player</th><th>Pos</th>${gameTh()}${projTh()}
            <th class="num" title="This slot's rank against the other ${spell(OTHERS)} teams">Rk</th></tr></thead>
          <tbody>${t.slots.map(startRow).join("")}</tbody></table>
      </div>
      <div class="rr-rcol">
        <div class="rr-rcap" title="Five bench spots is the whole margin in this format - there is no room to stash depth you will not start.">Bench <span class="faint">${t.bench.length} of 5 · ${t.bench_pts.toFixed(0)} sitting</span></div>
        <table class="rr-rtab rr-btab${WK ? " rr-rtab-wk" : ""}" aria-label="${esc(t.owner)} bench">
          <thead><tr><th>Player</th><th>Pos</th>${gameTh()}${projTh()}
            <th class="num" title="How many of the other ${spell(OTHERS)} teams he would start for, by recomputing each of their optimal lineups with him inserted">Starts</th></tr></thead>
          <tbody>${t.bench.map((p) => benchRow(p, false)).join("")}</tbody></table>
        ${unpriced(t)}
      </div>
    </div>`;
  }

  const html = (t, opts = {}) => {
    if (opts.teams > 1) OTHERS = opts.teams - 1;
    // Only if the build actually attached a week. An older cached roster-room.json has no `week`
    // block and no per-player game, and rendering a column of dashes off it would be worse than
    // rendering the season table it was built for.
    WK = opts.week && opts.week.n && t.week ? opts.week : null;
    return opts.split ? split(t) : stacked(t);
  };

  /* The panel meta above the table has to be on the same basis as the table under it. A "1,870
     starting" over a column of 18s and 13s reads as a broken number rather than as a season total. */
  const meta = (t, opts = {}) => {
    if (opts.week && opts.week.n && t.week) {
      const w = t.week;
      /* Once any starter's game is final, what happened outranks what was forecast, so the scored
         figure leads and the projection follows it. The count is load-bearing: "35.0 scored, 3 of
         10 played" cannot be mistaken for a finished week the way a bare 35.0 beside a 104.2 could.
         The projection's own "priced over N" caveat drops out of this line while a score is
         showing - two different counts of ten, side by side, read as one - and stays in the note
         under the table, which carries it in a full sentence. */
      if (w.scored_n > 0) {
        return `week ${w.n}: ${w.scored_pts.toFixed(1)} scored, ${w.scored_n} of ${w.starter_of} played · ` +
          `${w.starter_pts.toFixed(1)} projected · ${w.bench_pts.toFixed(1)} on the bench`;
      }
      const over = w.starter_n < w.starter_of ? ` over ${w.starter_n} of ${w.starter_of}` : "";
      return `week ${w.n}: ${w.starter_pts.toFixed(1)} starting${over} · ${w.bench_pts.toFixed(1)} on the bench`;
    }
    return `${t.starter_pts.toFixed(0)} starting · ${t.bench_pts.toFixed(0)} on the bench`;
  };

  window.HBGB_RosterTable = { html, meta };
})();
