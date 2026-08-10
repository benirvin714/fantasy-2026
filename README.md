# Agentic decision-support system

An agent harness for a rules-heavy domain, built so its recommendations can be *checked* rather than trusted. The design problem: a general model asked a domain question will answer in generic terms, from training data of unknown age, with a confidence it hasn't earned. Every layer here exists to close one of those three gaps.

| Layer | Where | What it does |
|---|---|---|
| **Command workflows** | `.claude/commands/` | Four slash commands, each a written spec rather than a prompt: which sources to pull, how to weigh them, what the output must contain, and what the command is forbidden to do. |
| **Encoded domain rules** | `CLAUDE.md`, `league-profile.md` | The scoring system and its second-order consequences, written down once, loaded every session. No answer is ever produced in generic terms. |
| **Quantitative models** | `scripts/measure-*.mjs`, `scripts/build-*.mjs` | Six seasons of raw league JSON reduced to measured priors (positional value ladder, FLEX usage, draft-pick expectation, FAAB clearing prices) instead of borrowed consensus. Zero dependencies, Node builtins only. |
| **Deterministic validators** | `scripts/validate-*.mjs` | Gates that run before any automated output publishes. Unsourced, stale, or out-of-range items are quarantined, not printed. |
| **Published surface** | `site/`, `data/site/` | Static dashboard on zero-cost hosting behind an auth gate. Commands write JSON, the page reads it, publishing is a git push. |

Three constraints run through all of it, and they're the part that generalizes: **read-only by construction** (the system recommends, a human executes), **no stale claims** (a fact is grounded in live data or it's labeled unverified), and an **honesty contract** in the data layer (a field that can't be derived is `null` with a stated reason, never a plausible-looking guess).

## Applied to

The HBGBs, a 10-team half-PPR Sleeper fantasy football league, 2026 season. Built July 2026. The format has enough scoring quirks (2 FLEX, 4-point passing TDs, banded kicker misses, a 5-man bench) that off-the-shelf rankings are actively wrong for it, which is what makes it a real test of the architecture rather than a demo of one.

## The evidence layer

The priors aren't tuned by feel. [`league-tendencies.md`](league-tendencies.md) is six seasons of raw Sleeper JSON (900 draft picks, ~2,100 completed transactions, 22 trades, every playoff bracket) reduced to per-owner behavioral priors, with every figure recomputed from source and cross-validated: FAAB totals reconcile to 100% against Sleeper's own `waiver_budget_used`, including the season where budget itself was traded.

The test of whether a system like this is measuring anything is what it says about the person running it. Two findings from the self-scout section:

> You drafted the league's first K and/or first DEF in five of six drafts, as early as round 10, and no run ever followed. That's roughly one wasted mid-round pick per year.

> Serial frenzy runner-up: $45 on Achane (won at $85), $35 on Ford (won at $66), $26 on Guerendo (won at $73). In this league's frenzies, bid $60+ or abstain.

Neither is a flattering result, and neither came from a hunch. Both fall out of `scripts/` reading `data/raw/`, so any line in that file can be walked back to the JSON it came from.

## What exists

| Piece | What it is |
|---|---|
| `CLAUDE.md` | The always-loaded context file (Claude Code reads it at the start of every session, ahead of any prompt): league/roster IDs, scoring quirks, hard rules. This is where the domain gets encoded so no session can forget it. |
| `league-profile.md` | The rules + how this format distorts consensus value (draft/trade doctrine). |
| `league-tendencies.md` | Six seasons of verified owner dossiers: draft habits, FAAB market prices, trade-partner map, self-scout. |
| `data/raw/` | Raw Sleeper JSON, 2020–2025 (drafts, transactions, rosters, brackets). Refresh: `scripts/fetch-league-data.ps1`. |
| `briefs/` | Dated /brief outputs; each new brief diffs against the previous one. |
| `.claude/commands/` | The four commands below. |
| `site/` | **HBGBs HQ dashboard** — static, zero-cost, read-only. Live standings + season state straight from Sleeper's public API (client-side), an NFL-updates panel fed by the daily `nfl-events` routine, plus waiver-board and latest-brief panels fed by `data/site/*.json` (published by /waivers and /brief). Standings show the playoff cut line (top 6) and inline points-for bars; a header refresh button re-pulls live data. Start: `python scripts/serve.py 8642` from the project root (or the `hbgbs-hq` launch config — it runs the no-cache server), open `http://localhost:8642/site/`. Update `site/config.js` with the new league ID at renewal. **After editing `site/style.css` or `site/app.js`, bump the `?v=N` query on their `<link>`/`<script>` tags in `site/index.html`** so browsers fetch the change. |
| `plans/` | Design docs — **confirmed, pre-build**. [valuation-and-scouting.md](plans/valuation-and-scouting.md): the VORP/replacement + ceiling valuation fixes and the `scouting_brief` commentary layer that feeds a capped `situation.modifier`. |
| [`progress.md`](progress.md) | The engineering log: what shipped, what it cost, and why each call was made. Start here if you want the reasoning rather than the inventory (see below). |

### Why `progress.md` is worth opening

It's where the decisions get shown rather than asserted. Three examples of the house style:

- **Color as an encoding, not decoration.** Draft-board tier bands step their hues by the golden angle, so adjacent tiers measure ΔE 66–167 against a just-noticeable threshold of about 2.3. A period-3 lightness step adds a second, colorblind-safe axis and pushes the hue cycle's near-repeat past the end of the board. The full-row wash appears only on the sort where tiers run contiguous, because everywhere else it's confetti.
- **Geometry that got validated before it got trusted.** Snake-draft math is measured from three seasons of real draft metadata and checked against the actual 2025 picks. The ±5-pick slack is labeled in the UI as a rule of thumb rather than a computed probability, because that's what it is.
- **Subtraction treated as work.** A player drop-down went from 1577px to 523px with no field removed and no black box: everything is one click away, section state survives repaints. There's a matching entry for a highlight that was cut after it lit 44 of 248 rows and failed its own wallpaper test.

The **Watch-outs** section at the bottom is the honest part. It records why so few recommendations carry high confidence: the valuation is deliberately single-source, and divergence from an outside ranking is surfaced as low confidence instead of blended away. That's a design decision with a cost, written down as a cost.

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
