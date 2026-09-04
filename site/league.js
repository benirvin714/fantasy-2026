/* league.js — the fourth tab: any OTHER Sleeper league, live, on demand.

   Why this page is completely self-contained
   ------------------------------------------
   Every other page here renders JSON that a build script produced *for the HBGBs*: the draft board,
   the roster room, the waiver board, the player dossiers, the six-season owner file. All of it is
   scored in the HBGBs' exact settings and keyed to its ten roster ids. None of that transfers to a
   different league, and quietly re-pointing those panels at another league id would put numbers on
   screen that look like analysis and are not. That is the one failure mode this project refuses.

   So this page publishes nothing, reads nothing local, and computes no valuation. It asks Sleeper
   about the league you paste in, reports what Sleeper says in that league's own slot shape, and
   puts an explicit scoring diff against the HBGBs on screen so the format difference is stated
   rather than assumed.

   Cache busting is load-bearing, not defensive habit — see the long note in draft.js. Sleeper sits
   behind Cloudflare with stale-while-revalidate, so any read of a fast-changing endpoint (rosters,
   matchups, picks) gets a unique query param or it can hand back a picture minutes old.
*/
(() => {
  const C = window.HQ_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 1) => n == null ? "—" : Number(n).toFixed(d);

  /* Three sources for the league, in this order: `?league=` for one visit, whatever this browser
     last connected to, then the default in config.js. The sentinel matters — "disconnect" has to
     stick, and a cleared key would just fall through to the config default on the next load and
     silently reconnect you to a league you had just dismissed. */
  const LS_KEY = "hq-other-league-id";
  const NONE = "none";
  const store = {
    get: () => { try { return localStorage.getItem(LS_KEY); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(LS_KEY, v); } catch { /* private mode */ } },
    clear: () => { try { localStorage.setItem(LS_KEY, NONE); } catch { /* private mode */ } },
  };

  const sleeperGet = async (path) => {
    const bust = `_=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const r = await fetch(`${C.API}${path}${path.includes("?") ? "&" : "?"}${bust}`,
      { cache: "no-store", headers: { "cache-control": "no-cache" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}`);
    return r.json();
  };

  /* A league id is a long number. Accept the whole Sleeper URL too, because that is what is
     actually on the clipboard when you have just come from the app. */
  const parseId = (raw) => (String(raw ?? "").match(/(\d{8,})/) ?? [])[1] ?? null;

  const S = {
    id: null, league: null, users: null, rosters: null, picks: [], draft: null,
    state: null, matchups: null, week: null, hbgbs: null, names: new Map(),
    openRid: null, playersLoaded: false, loading: false,
  };

  /* ---------------------------------------------------------------- names
     Sleeper's roster endpoint returns bare player ids. The draft feed carries first/last/pos/team
     in each pick's metadata, which right after a draft covers essentially every rostered player for
     free. Only the leftovers — waiver adds, undrafted fill-ins — need the full 5 MB player file,
     and that stays behind a button rather than firing on load: a silent multi-megabyte download on
     a page you opened to glance at standings is a rude default. */
  function namesFromPicks() {
    for (const p of S.picks) {
      if (!p.player_id) continue;
      const m = p.metadata ?? {};
      const nm = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
      S.names.set(String(p.player_id), {
        name: nm || String(p.player_id),
        pos: m.position ?? "", team: m.team ?? "",
        injury: (m.injury_status && m.injury_status !== "Healthy") ? m.injury_status : "",
        pick: p.pick_no ?? null, round: p.round ?? null, slot: p.draft_slot ?? null,
      });
    }
  }

  const unknownIds = () => {
    const seen = new Set();
    for (const r of S.rosters ?? []) for (const pid of r.players ?? []) {
      const id = String(pid);
      if (!S.names.has(id)) seen.add(id);
    }
    return [...seen];
  };

  async function loadPlayerFile() {
    const all = await sleeperGet("/players/nfl");
    for (const id of unknownIds()) {
      const p = all[id];
      if (!p) continue;
      S.names.set(id, {
        name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
        pos: p.position ?? "", team: p.team ?? "",
        injury: (p.injury_status && p.injury_status !== "Healthy") ? p.injury_status : "",
        pick: null, round: null, slot: null,
      });
    }
    S.playersLoaded = true;
  }

  const who = (pid) => S.names.get(String(pid))
    ?? { name: String(pid), pos: "", team: "", injury: "", pick: null, round: null, slot: null };

  /* ------------------------------------------------------------- league shape */
  const NON_START = new Set(["BN", "IR", "TAXI"]);
  const startSlots = (lg) => (lg.roster_positions ?? []).filter((s) => !NON_START.has(s));
  const benchCount = (lg) => (lg.roster_positions ?? []).filter((s) => s === "BN").length;
  /* IR reaches us two ways depending on the league: as "IR" entries in roster_positions, or only
     as settings.reserve_slots with nothing in the array (The Panther Pit does the latter). Reading
     one and not the other quietly understates the roster by a spot. */
  const irCount = (lg) => (lg.roster_positions ?? []).filter((s) => s === "IR").length
    || (lg.settings?.reserve_slots ?? 0);

  const ownerOf = (rid) => {
    const r = (S.rosters ?? []).find((x) => x.roster_id === rid);
    const u = (S.users ?? []).find((x) => x.user_id === r?.owner_id);
    return u?.metadata?.team_name || u?.display_name || `roster ${rid}`;
  };
  const isMine = (r) => String(r.owner_id) === String(C.MY_USER_ID);

  const record = (r) => {
    const s = r.settings ?? {};
    return { w: s.wins ?? 0, l: s.losses ?? 0, t: s.ties ?? 0,
      pf: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
      pa: (s.fpts_against ?? 0) + (s.fpts_against_decimal ?? 0) / 100,
      used: s.waiver_budget_used ?? 0, moves: s.total_moves ?? 0,
      streak: r.metadata?.streak ?? "" };
  };
  const played = () => (S.rosters ?? []).some((r) => { const x = record(r); return x.w + x.l + x.t > 0; });

  /* ------------------------------------------------------------- format read + diff */
  /* The diff is computed over the union of both leagues' scoring keys rather than a curated list.
     A hand-picked list is exactly how you end up not noticing that the new league pays 6 for a
     passing TD, or bonuses long receptions. Identical keys are dropped; everything left is a real
     difference and is shown, however long the list gets. */
  function scoringDiff(mine, theirs) {
    const keys = [...new Set([...Object.keys(mine ?? {}), ...Object.keys(theirs ?? {})])].sort();
    const rows = [];
    for (const k of keys) {
      const a = mine?.[k], b = theirs?.[k];
      const same = (a ?? 0) === (b ?? 0);
      if (!same) rows.push({ k, hbgbs: a, here: b });
    }
    return rows;
  }

  function fmtPanel() {
    const lg = S.league;
    const s = lg.settings ?? {};
    const sc = lg.scoring_settings ?? {};
    const slots = startSlots(lg);
    const rec = sc.rec ?? 0;
    const ppr = rec >= 1 ? "full PPR" : rec > 0 ? `${rec} PPR` : "standard (no PPR)";
    $("#ol-fmtchip").hidden = false;
    $("#ol-fmtchip").textContent = `${lg.total_rosters} teams · ${ppr} · ${slots.length} starters`;

    const kv = [
      ["teams", lg.total_rosters],
      ["scoring", ppr],
      ["pass TD", sc.pass_td ?? 0],
      ["interception", sc.pass_int ?? 0],
      ["fumble lost", sc.fum_lost ?? 0],
      ["starting slots", slots.join(" · ")],
      ["bench", `${benchCount(lg)}${irCount(lg) ? ` + ${irCount(lg)} IR` : ""}`],
      ["playoff teams", s.playoff_teams ?? "—"],
      ["playoffs start", s.playoff_week_start ? `week ${s.playoff_week_start}` : "—"],
      ["trade deadline", s.trade_deadline ? `week ${s.trade_deadline}` : "none"],
      ["waivers", s.waiver_budget != null ? `FAAB $${s.waiver_budget}` : `type ${s.waiver_type ?? "—"}`],
      ["keepers", s.max_keepers ? s.max_keepers : "none"],
    ];

    const diffHtml = (() => {
      if (!S.hbgbs) {
        return `<div class="ol-warn">Couldn't read the HBGBs league to diff against, so the comparison
          below is missing. The format above is still this league's own, straight from Sleeper.</div>`;
      }
      const mySlots = startSlots(S.hbgbs).join(" · ");
      const theirSlots = slots.join(" · ");
      const rows = scoringDiff(S.hbgbs.scoring_settings, sc);
      const slotLine = mySlots === theirSlots
        ? `<div class="ol-diff-same">Same starting shape as the HBGBs — <span class="mono">${esc(theirSlots)}</span>.</div>`
        : `<div class="ol-diff-row"><span class="ol-dk">starting slots</span>
             <span class="ol-dv"><b>${esc(theirSlots)}</b></span>
             <span class="ol-dh">HBGBs: ${esc(mySlots)}</span></div>`;
      const scoreLines = rows.length
        ? rows.map((r) => `<div class="ol-diff-row"><span class="ol-dk mono">${esc(r.k)}</span>
             <span class="ol-dv"><b>${r.here ?? 0}</b></span>
             <span class="ol-dh">HBGBs: ${r.hbgbs ?? 0}</span></div>`).join("")
        : `<div class="ol-diff-same">Scoring is identical to the HBGBs on every key Sleeper reports.</div>`;
      return `<div class="ol-diffs">${slotLine}${scoreLines}</div>
        <p class="rr-note">Bold is <b>this</b> league. Every key where the two leagues agree is
          omitted. A difference here is the reason nothing from the other three tabs can be reused:
          the whole valuation is scored in HBGBs settings.</p>`;
    })();

    $("#ol-fmt-meta").textContent = `league ${lg.league_id} · ${lg.season} ${lg.status}`;
    $("#ol-fmt-body").innerHTML =
      `<div class="ol-kv">${kv.map(([k, v]) =>
        `<div class="ol-kv-k">${esc(k)}</div><div class="ol-kv-v">${esc(v)}</div>`).join("")}</div>
       <h3 class="ol-sub">vs the HBGBs</h3>${diffHtml}`;
    $("#ol-fmt-panel").hidden = false;
  }

  /* ------------------------------------------------------------- the league table + rosters */
  function leaguePanel() {
    const live = played();
    const rows = [...S.rosters].sort((a, b) => {
      if (live) {
        const x = record(a), y = record(b);
        return y.w - x.w || y.pf - x.pf;
      }
      return a.roster_id - b.roster_id;   // nothing to sort on yet; say so rather than fake an order
    });
    const cut = S.league.settings?.playoff_teams ?? 0;

    const body = rows.map((r, i) => {
      const rec = record(r);
      const cls = `rr-lrow${isMine(r) ? " me" : ""}${S.openRid === r.roster_id ? " on" : ""}`;
      const cutRow = live && cut && i === cut
        ? `<tr class="ol-cutrow"><td colspan="7"><div class="cutlabel">playoff cut · top ${cut}</div></td></tr>` : "";
      const open = S.openRid === r.roster_id
        ? `<tr class="ol-exp"><td colspan="7">${rosterHtml(r)}</td></tr>` : "";
      return cutRow + `<tr class="${cls}" data-rid="${r.roster_id}" tabindex="0">
          <td class="rr-rk">${live ? i + 1 : "—"}</td>
          <td class="rr-own">${esc(ownerOf(r.roster_id))}${isMine(r) ? ` <span class="rr-you">you</span>` : ""}</td>
          <td class="num">${live ? `${rec.w}-${rec.l}${rec.t ? `-${rec.t}` : ""}` : "—"}</td>
          <td class="num">${rec.streak ? `<span class="${/L$/.test(rec.streak) ? "streak-l" : "streak-w"}">${esc(rec.streak)}</span>` : ""}</td>
          <td class="num">${live ? num(rec.pf) : "—"}</td>
          <td class="num">${live ? num(rec.pa) : "—"}</td>
          <td class="num faint">${(r.players ?? []).length}</td>
        </tr>` + open;
    }).join("");

    const unknown = unknownIds().length;
    const nameNote = unknown && !S.playersLoaded
      ? `<div class="ol-warn">${unknown} rostered player${unknown === 1 ? "" : "s"} weren't in this
           league's draft feed (waiver adds, or an undrafted fill-in), so they show as bare ids.
           <button class="lsync-btn" id="ol-loadnames" type="button">name them</button>
           <span class="faint">— downloads Sleeper's full player file, about 5 MB.</span></div>`
      : "";

    $("#ol-league-meta").textContent = live
      ? `standings · ${S.rosters.length} teams`
      : `no games played yet — listed in Sleeper's roster order, not ranked`;
    $("#ol-league-body").innerHTML = nameNote + `<table class="rr-ltab ol-ltab">
        <thead><tr><th class="rr-rk">#</th><th>Team</th><th class="num">Rec</th><th class="num">Strk</th>
          <th class="num">PF</th><th class="num">PA</th><th class="num">Ros</th></tr></thead>
        <tbody>${body}</tbody></table>
      <p class="rr-note">Click a row to open that roster in this league's own slot shape.</p>`;
    $("#ol-league-panel").hidden = false;
  }

  /* One roster, in the slot order the league actually declares. `starters` is index-aligned with
     the non-bench entries of roster_positions, so the labels come from the league object and the
     ids from the roster — never from an assumption about what a 10-team league looks like. */
  function rosterHtml(r) {
    const slots = startSlots(S.league);
    const starters = r.starters ?? [];
    const startSet = new Set(starters.filter((x) => x && x !== "0").map(String));
    const reserve = new Set((r.reserve ?? []).map(String));
    const bench = (r.players ?? []).map(String).filter((p) => !startSet.has(p) && !reserve.has(p));

    const line = (label, pid, extraCls = "") => {
      if (!pid || pid === "0") return `<tr class="${extraCls}"><td class="rr-slot">${esc(label)}</td>
        <td colspan="3" class="faint">empty</td></tr>`;
      const p = who(pid);
      const pk = p.slot != null ? `${p.round}.${String(p.slot).padStart(2, "0")}` : "";
      return `<tr class="${extraCls}">
        <td class="rr-slot">${esc(label)}</td>
        <td class="rr-nm">${esc(p.name)}${p.injury ? ` <span class="rr-inj">${esc(p.injury)}</span>` : ""}</td>
        <td class="rr-pt">${esc(p.pos || "—")}<span class="faint"> ${esc(p.team || "—")}</span></td>
        <td class="num ol-pk" title="${pk ? "Drafted at pick " + p.pick : "Not in this league's draft feed — added after the draft"}">${esc(pk || "add")}</td>
      </tr>`;
    };

    const rec = record(r);
    return `<div class="ol-roster">
      <div class="rr-rcap">${esc(ownerOf(r.roster_id))}
        <span class="faint">${rec.used ? `$${rec.used} FAAB spent · ` : ""}${rec.moves} move${rec.moves === 1 ? "" : "s"}</span></div>
      <table class="rr-rtab">
        <thead><tr><th>Slot</th><th>Player</th><th>Pos</th><th class="num">Pick</th></tr></thead>
        <tbody>
          ${slots.map((lab, i) => line(lab, starters[i])).join("")}
          <tr class="rr-div"><td colspan="4"><div class="cutlabel">bench · ${benchCount(S.league)} spots</div></td></tr>
          ${bench.length ? bench.map((p) => line("BN", p, "ol-bn")).join("")
            : `<tr><td class="rr-slot rr-bn">BN</td><td colspan="3" class="faint">empty</td></tr>`}
          ${reserve.size ? [...reserve].map((p) => line("IR", p, "ol-bn")).join("") : ""}
        </tbody>
      </table>
    </div>`;
  }

  /* ------------------------------------------------------------- this week */
  function matchupPanel() {
    if (!S.matchups || !S.matchups.length) { $("#ol-mu-panel").hidden = true; return; }
    const byId = new Map();
    for (const m of S.matchups) {
      if (m.matchup_id == null) continue;
      if (!byId.has(m.matchup_id)) byId.set(m.matchup_id, []);
      byId.get(m.matchup_id).push(m);
    }
    if (!byId.size) { $("#ol-mu-panel").hidden = true; return; }
    const anyPoints = S.matchups.some((m) => (m.points ?? 0) > 0);

    const side = (m, other) => {
      const r = S.rosters.find((x) => x.roster_id === m.roster_id);
      const winning = anyPoints && (m.points ?? 0) > (other?.points ?? 0);
      return `<div class="ol-mu-side${winning ? " up" : ""}${r && isMine(r) ? " mine" : ""}">
        <span class="ol-mu-tm">${esc(ownerOf(m.roster_id))}</span>
        <span class="ol-mu-pts mono">${anyPoints ? num(m.points ?? 0) : "—"}</span></div>`;
    };

    $("#ol-mu-meta").textContent = `week ${S.week}${anyPoints ? "" : " · no scoring yet"}`;
    $("#ol-mu-body").innerHTML = [...byId.values()].map(([a, b]) =>
      `<div class="ol-mu">${side(a, b)}${b ? side(b, a) : `<div class="ol-mu-side faint">bye</div>`}</div>`).join("")
      + (anyPoints ? "" : `<p class="rr-note">Week ${S.week} hasn't been scored — these are the pairings.</p>`);
    $("#ol-mu-panel").hidden = false;
  }

  /* ------------------------------------------------------------- draft results */
  function draftPanel() {
    if (!S.draft || !S.picks.length) {
      if (!S.draft) { $("#ol-draft-panel").hidden = true; return; }
      $("#ol-draft-meta").textContent = S.draft.status;
      $("#ol-draft-body").innerHTML = `<div class="loading">Draft ${esc(S.draft.status)} — no picks yet.</div>`;
      $("#ol-draft-panel").hidden = false;
      return;
    }
    const rounds = new Map();
    for (const p of [...S.picks].sort((a, b) => a.pick_no - b.pick_no)) {
      if (!rounds.has(p.round)) rounds.set(p.round, []);
      rounds.get(p.round).push(p);
    }
    const mineRid = (S.rosters.find(isMine) ?? {}).roster_id;
    const pickRow = (p) => {
      const m = p.metadata ?? {};
      const nm = [m.first_name, m.last_name].filter(Boolean).join(" ") || String(p.player_id ?? "—");
      const mine = p.roster_id === mineRid;
      return `<div class="ol-pick${mine ? " mine" : ""}">
        <span class="ol-pk mono">${p.round}.${String(p.draft_slot).padStart(2, "0")}</span>
        <span class="ol-pn">${esc(nm)}</span>
        <span class="ol-pp mono">${esc(m.position ?? "")} ${esc(m.team ?? "")}</span>
        <span class="ol-po">${esc(ownerOf(p.roster_id))}</span>
      </div>`;
    };
    $("#ol-draft-meta").textContent =
      `${S.picks.length} picks · ${rounds.size} rounds · ${S.draft.status}${S.draft.type ? ` · ${S.draft.type}` : ""}`;
    $("#ol-draft-body").innerHTML = [...rounds.entries()].map(([rd, ps], i) =>
      `<details class="ol-round"${i === 0 ? " open" : ""}>
        <summary>Round ${rd}<span class="faint"> — ${ps.length} picks</span></summary>
        <div class="ol-picks">${ps.map(pickRow).join("")}</div>
      </details>`).join("")
      + (mineRid != null ? `<p class="rr-note">Your picks are highlighted.</p>` : "");
    $("#ol-draft-panel").hidden = false;
  }

  /* ------------------------------------------------------------- load + paint */
  function setStatus(text, cls) {
    const el = $("#ol-status");
    el.className = `lsync-status ${cls}`;
    el.textContent = text;
  }
  function showErr(msg) {
    const el = $("#ol-err");
    el.hidden = !msg;
    el.innerHTML = msg ?? "";
  }
  function hidePanels() {
    for (const id of ["#ol-fmt-panel", "#ol-league-panel", "#ol-mu-panel", "#ol-draft-panel"])
      $(id).hidden = true;
    $("#ol-fmtchip").hidden = true;
  }

  async function load(id) {
    if (S.loading) return;
    S.loading = true;
    setStatus("connecting…", "idle");
    showErr(null);
    // Hide the how-to immediately rather than after the round trip: on a boot from the stored id it
    // would otherwise flash the "paste a league id" copy at somebody who has already pasted one.
    $("#ol-empty").hidden = true;
    try {
      const [league, users, rosters, state] = await Promise.all([
        sleeperGet(`/league/${id}`),
        sleeperGet(`/league/${id}/users`),
        sleeperGet(`/league/${id}/rosters`),
        sleeperGet("/state/nfl"),
      ]);
      if (!league || !league.league_id) throw new Error("Sleeper returned no league for that id");

      S.id = id; S.league = league; S.users = users; S.rosters = rosters; S.state = state;
      S.names = new Map(); S.playersLoaded = false;

      // The draft is a separate object, and a league can have several (a re-do, a mock). Take the
      // completed one, newest first, and fall back to whatever is there so an in-progress draft
      // still renders what has been picked so far.
      const drafts = await sleeperGet(`/league/${id}/drafts`).catch(() => []);
      S.draft = [...drafts].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .find((d) => d.status === "complete") ?? drafts[0] ?? null;
      S.picks = S.draft ? await sleeperGet(`/draft/${S.draft.draft_id}/picks`).catch(() => []) : [];
      namesFromPicks();

      // Matchups only exist once a week is playable, and the week has to be one this league runs.
      const wk = Math.max(1, state.display_week ?? state.week ?? 1);
      const lastWeek = (league.settings?.playoff_week_start ?? 15) + 3;
      S.week = wk;
      S.matchups = (state.season === league.season && wk <= lastWeek)
        ? await sleeperGet(`/league/${id}/matchups/${wk}`).catch(() => null)
        : null;

      // The HBGBs league, for the format diff only. A failure here costs the diff, not the page.
      S.hbgbs = String(id) === String(C.LEAGUE_ID)
        ? league
        : await sleeperGet(`/league/${C.LEAGUE_ID}`).catch(() => null);

      store.set(id);
      $("#ol-id").value = id;
      $("#ol-btn").textContent = "disconnect";
      $("#ol-btn").classList.add("on");
      $("#ol-empty").hidden = true;
      $("#ol-title").innerHTML = `${esc((league.name ?? "other league").toUpperCase())} <span class="hq">/ LIVE</span>`;
      document.title = `${league.name} — live`;
      $("#ol-state").textContent = `${league.season} ${league.status}${state.season === league.season ? ` · week ${wk}` : ""}`;
      $("#ol-state").classList.add("live");
      setStatus(`live · ${league.name}`, "live");

      fmtPanel(); leaguePanel(); matchupPanel(); draftPanel();
      $("#ol-asof").textContent = `as of ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      if (String(id) === String(C.LEAGUE_ID)) {
        showErr(`That is the HBGBs itself. It renders fine here, but the other three tabs know far
          more about it — this page deliberately shows only what Sleeper states.`);
      }
    } catch (e) {
      hidePanels();
      $("#ol-empty").hidden = false;
      setStatus(`failed · ${e.message}`, "bad");
      showErr(`Couldn't load league <code>${esc(id)}</code>: ${esc(e.message)}. Check the id, and
        that the league is on Sleeper's <code>nfl</code> sport. Nothing is cached — the page shows
        no data rather than stale data.`);
    } finally {
      S.loading = false;
    }
  }

  function disconnect() {
    store.clear();
    S.id = null; S.league = null; S.openRid = null; S.names = new Map();
    hidePanels();
    showErr(null);
    $("#ol-empty").hidden = false;
    $("#ol-id").value = "";
    $("#ol-btn").textContent = "connect";
    $("#ol-btn").classList.remove("on");
    $("#ol-title").innerHTML = `OTHER LEAGUE <span class="hq">/ LIVE</span>`;
    document.title = "Other league — live";
    $("#ol-state").textContent = "not connected";
    $("#ol-state").classList.remove("live");
    $("#ol-asof").textContent = "";
    setStatus("not connected", "idle");
  }

  /* ------------------------------------------------------------- wiring */
  $("#ol-btn").addEventListener("click", () => {
    if (S.league) return disconnect();
    const id = parseId($("#ol-id").value);
    if (!id) return setStatus("that doesn't look like a league id", "bad");
    load(id);
  });
  $("#ol-id").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#ol-btn").click(); });

  $("#ol-refresh").addEventListener("click", () => {
    const btn = $("#ol-refresh");
    btn.classList.remove("spin"); void btn.offsetWidth; btn.classList.add("spin");
    if (S.id) load(S.id);
  });

  /* One delegated document listener rather than per-row handlers: every repaint rebuilds the
     table, and re-binding ten rows each time is how a stale closure gets left behind. */
  document.addEventListener("click", async (e) => {
    if (e.target.id === "ol-loadnames") {
      const b = e.target;
      b.disabled = true; b.textContent = "downloading…";
      try { await loadPlayerFile(); leaguePanel(); }
      catch (err) { b.disabled = false; b.textContent = "retry"; showErr(`Player file failed: ${esc(err.message)}`); }
      return;
    }
    const row = e.target.closest?.(".ol-ltab .rr-lrow");
    if (!row) return;
    const rid = Number(row.dataset.rid);
    S.openRid = S.openRid === rid ? null : rid;
    leaguePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest?.(".ol-ltab .rr-lrow");
    if (!row) return;
    e.preventDefault();
    row.click();
  });

  /* ------------------------------------------------------------- boot */
  const fromUrl = parseId(new URLSearchParams(location.search).get("league"));
  const saved = store.get();
  const boot = fromUrl ?? (saved === NONE ? null : (saved || parseId(C.OTHER_LEAGUE_ID)));
  if (boot) { $("#ol-id").value = boot; load(boot); }
})();
