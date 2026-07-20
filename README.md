# The HBGBs Decision-Support System

Fantasy football decision support for the 2026 season of The HBGBs (10-team Sleeper league). Built July 2026. All Sleeper access is read-only; all analysis is translated into this league's exact scoring.

## What exists

| Piece | What it is |
|---|---|
| `CLAUDE.md` | Session memory: league/roster IDs, scoring quirks, hard rules. Every session reads this first. |
| `league-profile.md` | The rules + how this format distorts consensus value (draft/trade doctrine). |
| `league-tendencies.md` | Six seasons of verified owner dossiers: draft habits, FAAB market prices, trade-partner map, self-scout. |
| `data/raw/` | Raw Sleeper JSON, 2020–2025 (drafts, transactions, rosters, brackets). Refresh: `scripts/fetch-league-data.ps1`. |
| `briefs/` | Dated /brief outputs; each new brief diffs against the previous one. |
| `.claude/commands/` | The four commands below. |
| `site/` | **HBGBs HQ dashboard** — static, zero-cost, read-only. Live standings + season state straight from Sleeper's public API (client-side), an NFL-updates panel fed by the daily `nfl-events` routine, plus waiver-board and latest-brief panels fed by `data/site/*.json` (published by /waivers and /brief). Standings show the playoff cut line (top 6) and inline points-for bars; a header refresh button re-pulls live data. Start: `python scripts/serve.py 8642` from the project root (or the `hbgbs-hq` launch config — it runs the no-cache server), open `http://localhost:8642/site/`. Update `site/config.js` with the new league ID at renewal. **After editing `site/style.css` or `site/app.js`, bump the `?v=N` query on their `<link>`/`<script>` tags in `site/index.html`** so browsers fetch the change. |
| `plans/` | Design docs — **confirmed, pre-build**. [valuation-and-scouting.md](plans/valuation-and-scouting.md): the VORP/replacement + ceiling valuation fixes and the `scouting_brief` commentary layer that feeds a capped `situation.modifier`. |

## Commands

| Command | What it does | When |
|---|---|---|
| `/brief` | Web-sweeps current NFL news (injuries, depth charts, coaching, ADP), ends with "So what for this league," saves to `briefs/YYYY-MM-DD.md`, shows only the diff vs last brief. | Anytime; weekly in preseason |
| `/waivers` | Builds the free-agent pool from Sleeper (rosters + trending + news), ranks targets with FAAB bids priced to this league's real market, names a drop for each. Recommendations only. | Tuesday (before waivers clear Wed) |
| `/startsit` | Checks lineup vs injuries/designations, matchups, weather; flags only changes that matter. Never touches the lineup. | Thu–Sun |
| `/trade <proposal>` | e.g. `/trade my Kittle + Irving for their Gibbs` — values both sides in league format with counterparty intelligence; ACCEPT/DECLINE/COUNTER. | Anytime before week-12 deadline |

## Automated

- **`nfl-daily-events`** (scheduled task, daily ~8:05 AM): scans NFL news across four lanes (injuries, roles, coaching, market), dedupes against what it already reported, and publishes `data/site/nfl-events.json` — the dashboard's "NFL updates" panel. Runs while the Claude app is open (queued runs fire on next launch). Manage it from the Scheduled section in the sidebar; the panel warns if the feed goes stale (>2 days).

## Weekly rhythm (in season)

- **Tuesday:** `/waivers` — claims process Wednesday morning (1-day clear).
- **Thursday:** `/startsit` before TNF lock for Thursday players.
- **Sunday morning:** `/startsit` again for late-breaking designations and weather.
- **Anytime:** `/brief` for the landscape; `/trade` when an offer arrives (best windows: Sept–Oct; deadline week 12).
- **Preseason:** `/brief` weekly through camp; `/waivers` works in dry-run mode (stash watchlist).

## Maintenance

1. **At league renewal** (not yet renewed as of 2026-07-17): update the 2026 league ID in `CLAUDE.md`, re-verify settings against the new league object, and update `$leagueId` in `scripts/fetch-league-data.ps1`.
2. **After the 2026 draft:** refresh `data/raw/` and ask for a draft-recap update to `league-tendencies.md` (does everyone's 2026 behavior match their dossier?).
3. **Command-file gotcha:** in `.claude/commands/*.md`, a dollar sign followed by a digit is a positional-arg placeholder and gets stripped — write FAAB amounts as "12 dollars", never "$12".

## Ground rules (non-negotiable, encoded in CLAUDE.md)

1. Read-only on Sleeper — no waiver claims, lineup changes, trades, or drops are ever executed; the connected MCP is read-only by construction.
2. No stale player analysis — every player-facing claim is grounded in live Sleeper data or current, dated web sources, or it's flagged as unverified.
3. Everything is scored in The HBGBs' format — half-PPR, 2 FLEX, 4-pt pass TDs, the kicker distance/miss bands, and the DEF points-allowed tiers.
