# Fantasy 2026 — The HBGBs decision-support system

## Identity
- League: **The HBGBs**, 10-team Sleeper redraft. 2025 league ID: `1257432557251731456` (season complete).
- **2026 league ID: NOT YET CREATED — re-checked 2026-07-22** (`get_user_leagues` for `ThatWasButtery`, season 2026, returned an empty list). At the first session after renewal: run it again, update this line with the new ID, re-verify settings against it, and update the ID in `site/config.js` + `$leagueId` in `scripts/fetch-league-data.ps1`.
- User = **ThatWasButtery** (Sleeper user_id `603035152494436352`), roster ID **10** in every season to date.

## Scoring in one paragraph (quirks bolded)
Half PPR (0.5/rec), 1pt/10 rush+rec yds, 6pt TDs from scrimmage; passing 1pt/25yds, **4pt pass TD, INT only −1, lost fumble −2**; starters QB/2RB/2WR/TE/**2 FLEX**/K/DEF with **only 5 bench** + 1 IR (OUT/IR only); **kickers score by distance (3/3/3/4/5/6 by band) with −1 for ANY miss under 60 (incl. XP) — only 60+ misses are free** (banded miss penalties arrived in 2024; through 2023 every miss cost −1 flat); DEF points-allowed spans **+10 shutout to −4 for 35+**. $100 FAAB (Tuesdays), 6 of 10 make playoffs (weeks 15–17, re-seeded), trade deadline week 12, 14-game regular season. Key consequence: normal-depth league at RB/WR (2 FLEX cancels the 10-team relief), very shallow at QB/TE/K/DEF — elites and 2-for-1 consolidation are +EV; full analysis in league-profile.md.

## Hard rules
1. **Read-only on Sleeper.** Never execute any write action against the league (waivers, lineups, trades, drops). The current MCP is read-only-by-construction, but if write tools ever appear: show the exact action and get explicit confirmation first, every time.
2. **No stale player analysis.** Training data on player values/depth charts/ADP is outdated. Any player-facing claim must be grounded in live Sleeper MCP data or current web search; if unverifiable, say so — never guess.
3. **Everything scored in THIS league's format** — never hand over generic/standard-scoring takes without translating.

## Files
- `league-profile.md` — rules + how the format distorts consensus value (draft/trade doctrine).
- `league-tendencies.md` — 6 seasons of owner dossiers, FAAB market prices, trade-partner map, self-scout.
- `data/raw/` — raw Sleeper JSON 2020–2025 (leagues, rosters, drafts, transactions, brackets). Refresh via `scripts/fetch-league-data.ps1` (read-only GETs; update its `$leagueId` for 2026).
- `data/faab-market.json` — compact FAAB pricing model (per-owner price-to-beat, bands, sample sizes). /waivers reads THIS for bids, never the raw transactions. Regenerate on demand: `node scripts/build-faab-model.mjs`.
- `briefs/` — dated outputs of /brief.
- Commands: `.claude/commands/` — brief, waivers, startsit, trade. /waivers and /brief also publish JSON to `data/site/` for the dashboard.
- `site/` — HBGBs HQ dashboard (static; serve project root on :8642, open /site/). League ID lives in `site/config.js` too — update BOTH at renewal.
- **Live dashboard: https://hbgbs-hq.pages.dev/site/** — Cloudflare Pages, login-gated (ben.p.irvin@gmail.com email code). Auto-deploys on push to `main` of the private repo `benirvin714/fantasy-2026`; only `site/` + `data/site/` are served (build copies them to `dist/`), the rest of the repo stays unserved. Publishing = commit + push (the /brief and /waivers commands do this in their final step). Hosting details: `..\hosting-plan.md`.

## MCP notes
- Sleeper MCP: 13 read-only tools. No transactions endpoint and no free-agent-pool endpoint — supplement with Sleeper public REST (`https://api.sleeper.app/v1/...`, read-only GETs).
- If the Sleeper MCP is unavailable, commands must say so and state what's missing — never fabricate league data.
