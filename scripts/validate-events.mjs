// Deterministic gate for the nfl-daily-events routine.
//
// Replaces the ad-hoc `node -e` checks the routine used to compose (every new string
// tripped a fresh permission prompt — see the ~15 near-identical entries that piled up
// in .claude/settings.local.json) with ONE stable command, and enforces the two quality
// checks Ben signed off on:
//   (i)  every source.url must actually resolve (dead link => drop that event)
//   (ii) every players[] tag must be a real Sleeper player AND appear in the item's prose
//        (the Dillon-Gabriel / wrong-Robinson mis-file => strip that one tag)
//
// Item-level quarantine, NEVER halts: a dead source drops that one event, a bad tag is
// stripped from that one event, everything else publishes. Findings are written to
// data/raw/nfl-events-flags.json (gitignored, local record) and printed as a summary the
// routine surfaces in its morning report. Exit code is ALWAYS 0 — an unattended 4:10am
// run must never wedge on this.
//
// Usage:
//   node scripts/validate-events.mjs           enforce: clean nfl-events.json in place + write flags
//   node scripts/validate-events.mjs --check    report only, no mutation (audit / shadow-test)
//   node scripts/validate-events.mjs --no-net   skip the URL liveness check (offline)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const EVENTS_PATH = path.join(ROOT, "data", "site", "nfl-events.json");
const PIDS_CACHE = path.join(ROOT, "data", "raw", "db_playerids.csv");
const FLAGS_PATH = path.join(ROOT, "data", "raw", "nfl-events-flags.json");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check") || args.has("--check-only");
const NO_NET = args.has("--no-net");

// ---- name normalization (mirrors build-draft-board.mjs's matching intent) ----------
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const normName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")   // ALL punctuation -> space, both sides normalize identically.
    .split(/\s+/)                   // "A.J."->"a j", "De'Zhaun"->"de zhaun", possessive "Barkley's"->"barkley s"
    .filter((t) => t && !SUFFIXES.has(t))
    .join(" ")
    .trim();

// ---- minimal CSV line splitter (quote-aware) ---------------------------------------
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---- player universe: sleeper_id crosswalk, offline (no egress needed) --------------
// realNames: normalized full names that exist. suggestBySurname: normalized surname ->
// display suggestions, for actionable "did you mean" hints. surnameToFullNorms: surname ->
// the active skill players carrying it, so a tag whose full name is absent can be checked
// against whether a DIFFERENT same-surname player is named in full (the Bijan-vs-Brian case).
let realNames = new Set(), suggestBySurname = new Map(), surnameToFullNorms = new Map(), universeStatus = "ok";
{
  try {
    const csv = fs.readFileSync(PIDS_CACHE, "utf8");
    const lines = csv.trim().split("\n");
    const h = splitCsv(lines[0]);
    const ci = (n) => h.indexOf(n);
    const iName = ci("name"), iPos = ci("position"), iTeam = ci("team");
    const FANTASY = new Set(["QB", "RB", "WR", "TE", "K"]);
    for (const line of lines.slice(1)) {
      const c = splitCsv(line);
      const raw = (c[iName] || "").trim();
      if (!raw) continue;
      const nn = normName(raw);
      if (!nn) continue;
      realNames.add(nn);
      const surname = nn.split(" ").slice(-1)[0];
      if (!suggestBySurname.has(surname)) suggestBySurname.set(surname, []);
      const pos = (c[iPos] || "").trim(), team = (c[iTeam] || "").trim();
      suggestBySurname.get(surname).push(`${raw}${pos ? " (" + pos + (team && team !== "NA" ? ", " + team : "") + ")" : ""}`);
      if (FANTASY.has(pos) && team && team !== "NA") {
        if (!surnameToFullNorms.has(surname)) surnameToFullNorms.set(surname, new Set());
        surnameToFullNorms.get(surname).add(nn);
      }
    }
  } catch (e) {
    universeStatus = `unavailable: ${e.message}`;
  }
}

// ---- URL liveness -------------------------------------------------------------------
// Conservative on purpose: only 404 / 410 / DNS-failure / connection-refused count as
// DEAD (drop the event). 401/403/429/5xx/timeout are INCONCLUSIVE (bot-blocking, flaky
// server) — kept, noted, never dropped, so a legit ESPN/NFL.com link is not gutted.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function checkUrl(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    try { await res.body?.cancel?.(); } catch {}
    if (res.status === 404 || res.status === 410) return { state: "dead", code: res.status };
    if (res.status >= 200 && res.status < 400) return { state: "ok", code: res.status };
    return { state: "inconclusive", code: res.status };
  } catch (e) {
    const msg = String(e?.cause?.code || e?.code || e?.message || e);
    if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ECONNREFUSED/i.test(msg)) return { state: "dead", code: msg };
    return { state: "inconclusive", code: msg };
  } finally {
    clearTimeout(t);
  }
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- load feed ----------------------------------------------------------------------
const feed = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
const events = Array.isArray(feed.events) ? feed.events : [];

const flags = {
  generated_at: new Date().toISOString(),
  mode: CHECK_ONLY ? "check" : "enforce",
  net: !NO_NET,
  universe: universeStatus,
  summary: { events: events.length, dropped: 0, tags_stripped: 0, tags_flagged: 0, urls_inconclusive: 0, structural: 0 },
  dropped: [],
  stripped_tags: [],
  flagged_tags: [],
  inconclusive_urls: [],
  structural: [],
};

// ---- structural checks (subsumes every old ad-hoc node -e check) --------------------
const REQUIRED = ["date", "type", "headline", "detail", "so_what", "source"];
let prevDate = null, sortOk = true;
const seenHeadline = new Set();
events.forEach((e, idx) => {
  const miss = REQUIRED.filter((k) => !e[k]);
  if (!e.source || !e.source.url) miss.push("source.url");
  if (!Array.isArray(e.players)) miss.push("players[]");
  if (miss.length) flags.structural.push({ index: idx, headline: e.headline || "(no headline)", problem: `missing ${miss.join(", ")}` });
  if (e.headline) {
    if (seenHeadline.has(e.headline)) flags.structural.push({ index: idx, headline: e.headline, problem: "duplicate headline" });
    seenHeadline.add(e.headline);
  }
  if (prevDate && e.date > prevDate) sortOk = false;
  if (e.date) prevDate = e.date;
});
if (!sortOk) flags.structural.push({ index: -1, headline: "(feed)", problem: "events not sorted newest-first" });
if (events.length > 25) flags.structural.push({ index: -1, headline: "(feed)", problem: `${events.length} events exceeds cap of 25` });

// ---- URL liveness -------------------------------------------------------------------
const urlStates = NO_NET
  ? events.map(() => ({ state: "skipped" }))
  : await mapPool(events.map((e) => e.source?.url || ""), 6, (u) => (u ? checkUrl(u) : { state: "skipped" }));

// Circuit breaker: if the URL check finds everything (or a majority) unreachable, that is a
// network blip on the box mid-run, NOT a feed full of dead links. Dropping on it would wipe the
// dashboard. So in that case we drop NOTHING for URL reasons and flag the run as unreliable.
const deadN = urlStates.filter((u) => u.state === "dead").length;
const okN = urlStates.filter((u) => u.state === "ok").length;
const urlCheckUnreliable = !NO_NET && events.length > 0 && deadN > 0 && (okN === 0 || deadN > events.length * 0.5);
if (urlCheckUnreliable) flags.structural.push({ index: -1, headline: "(feed)", problem: `URL check unreliable: ${deadN}/${events.length} unreachable, ${okN} ok — treating as a network blip, NOT dropping any events this run` });

// ---- player-tag checks + item-level enforcement -------------------------------------
const kept = [];
events.forEach((e, idx) => {
  const url = urlStates[idx];
  if (!urlCheckUnreliable && url.state === "dead") {
    flags.dropped.push({ date: e.date, headline: e.headline, url: e.source?.url, reason: `dead source (${url.code})` });
    return; // drop the whole event
  }
  if (url.state === "inconclusive") flags.inconclusive_urls.push({ date: e.date, headline: e.headline, url: e.source?.url, code: String(url.code) });

  const hay = ` ${normName(`${e.headline || ""} ${e.detail || ""} ${e.so_what || ""}`)} `;
  const cleanPlayers = [];
  for (const tag of Array.isArray(e.players) ? e.players : []) {
    const nn = normName(tag);
    if (!nn) continue;
    const last = nn.split(" ").slice(-1)[0];
    const isReal = universeStatus !== "ok" || realNames.has(nn);
    const fullInProse = hay.includes(` ${nn} `);
    const surnameInProse = hay.includes(` ${last} `);

    // AUTO-STRIP — the only certain case: the tagged player is not mentioned anywhere in the
    // item, not even by surname. This is the Dillon-Gabriel mis-file. Everything softer below
    // is flag-only (tag kept), because stripping on a weaker signal gutted 6 legit star tags.
    if (!surnameInProse) {
      flags.stripped_tags.push({ date: e.date, headline: e.headline, tag, reason: "not mentioned in prose (headline/detail/so_what)" });
      continue;
    }
    // FLAG-ONLY — not in the sleeper_id crosswalk. Could be a misspelling OR a fresh signing /
    // rookie the crosswalk hasn't caught up to; dropping would risk losing the exact waiver news
    // that matters, so surface it for a spelling check, keep the tag.
    if (!isReal) {
      const sugg = (suggestBySurname.get(last) || [])
        .sort((a, b) => Number(b[0]?.toLowerCase() === tag[0]?.toLowerCase()) - Number(a[0]?.toLowerCase() === tag[0]?.toLowerCase()))
        .slice(0, 3);
      flags.flagged_tags.push({ date: e.date, headline: e.headline, tag, reason: "not in sleeper_id crosswalk (verify spelling)", suggestion: sugg.length ? sugg.join(" | ") : null });
      cleanPlayers.push(tag);
      continue;
    }
    // STRIP — full name absent but a DIFFERENT same-surname player IS named in full: strong sign
    // the item is really about the other player (the Bijan-vs-Brian-Robinson case). Both full names
    // present (a story about both) leaves fullInProse true above, so this only fires on a true swap.
    if (!fullInProse) {
      const others = [...(surnameToFullNorms.get(last) || [])].filter((f) => f !== nn && hay.includes(` ${f} `));
      if (others.length) {
        flags.stripped_tags.push({ date: e.date, headline: e.headline, tag, reason: `wrong player — prose names "${others.join('", "')}", not this one` });
        continue;
      }
    }
    cleanPlayers.push(tag);
  }
  kept.push(cleanPlayers.length === (e.players || []).length ? e : { ...e, players: cleanPlayers });
});

flags.summary.dropped = flags.dropped.length;
flags.summary.tags_stripped = flags.stripped_tags.length;
flags.summary.tags_flagged = flags.flagged_tags.length;
flags.summary.urls_inconclusive = flags.inconclusive_urls.length;
flags.summary.structural = flags.structural.length;

// ---- write flags (always) + cleaned feed (enforce mode, only if changed) ------------
fs.writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2) + "\n");
const changed = flags.dropped.length > 0 || flags.stripped_tags.length > 0;
if (!CHECK_ONLY && changed) {
  fs.writeFileSync(EVENTS_PATH, JSON.stringify({ ...feed, events: kept }, null, 2) + "\n");
}

// ---- summary ------------------------------------------------------------------------
const s = flags.summary;
const mode = CHECK_ONLY ? "CHECK (no mutation)" : changed ? "ENFORCE (file cleaned)" : "ENFORCE (no changes)";
console.log(`validate-events [${mode}]  net=${!NO_NET}  universe=${universeStatus}`);
console.log(`  events=${s.events}  dropped=${s.dropped}  tags_stripped=${s.tags_stripped}  tags_flagged=${s.tags_flagged}  urls_inconclusive=${s.urls_inconclusive}  structural=${s.structural}`);
for (const d of flags.dropped) console.log(`  DROP   ${d.date}  ${d.reason}  ${d.headline?.slice(0, 70)}`);
for (const t of flags.stripped_tags) console.log(`  STRIP  "${t.tag}"  ${t.reason}  <- ${t.headline?.slice(0, 55)}`);
for (const t of flags.flagged_tags) console.log(`  FLAG   "${t.tag}"  ${t.reason}${t.suggestion ? "  [did you mean: " + t.suggestion + "]" : ""}  <- ${t.headline?.slice(0, 50)}`);
for (const u of flags.inconclusive_urls) console.log(`  URL?   ${u.code}  ${u.url}`);
for (const st of flags.structural) console.log(`  STRUCT ${st.problem}  ${st.headline?.slice(0, 60)}`);
if (!s.dropped && !s.tags_stripped && !s.tags_flagged && !s.urls_inconclusive && !s.structural) console.log("  clean.");
console.log(`  flags -> ${path.relative(ROOT, FLAGS_PATH)}`);
