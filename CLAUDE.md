# Fantasy 2026 — The HBGBs decision-support system

## Identity
- League: **The HBGBs**, 10-team Sleeper redraft. 2025 league ID: `1257432557251731456` (season complete).
- **2026 league ID: `1386608052991447040`** (renewed; verified 2026-07-22 via `get_league_info` + `get_user_leagues`). draft_id `1386608053004017664`, status pre_draft. Settings re-verified against the live object and **unchanged from prior years**: half-PPR scoring quirks (4-pt pass TD, INT −1, fum_lost −2, kicker distance bands, DEF tiers), roster QB/2RB/2WR/TE/2FLEX/K/DEF + 5 BN + 1 IR, 6 playoff teams, wk-15 playoffs, wk-12 trade deadline, $100 FAAB, max_keepers=1 (unused). `site/config.js`, `scripts/fetch-league-data.ps1`, and `league-profile.md` updated to this ID.
- User = **ThatWasButtery** (Sleeper user_id `603035152494436352`), roster ID **10** in every season to date.

## Scoring in one paragraph (quirks bolded)
Half PPR (0.5/rec), 1pt/10 rush+rec yds, 6pt TDs from scrimmage; passing 1pt/25yds, **4pt pass TD, INT only −1, lost fumble −2**; starters QB/2RB/2WR/TE/**2 FLEX**/K/DEF with **only 5 bench** + 1 IR (OUT/IR only); **kickers score by distance (3/3/3/4/5/6 by band) with −1 for ANY miss under 60 (incl. XP) — only 60+ misses are free** (banded miss penalties arrived in 2024; through 2023 every miss cost −1 flat); DEF points-allowed spans **+10 shutout to −4 for 35+**. $100 FAAB (Tuesdays), 6 of 10 make playoffs (weeks 15–17, re-seeded), trade deadline week 12, 14-game regular season. Key consequence: normal-depth league at RB/WR (2 FLEX cancels the 10-team relief), very shallow at QB/TE/K/DEF — elites and 2-for-1 consolidation are +EV; full analysis in league-profile.md.

## Hard rules
1. **Read-only on Sleeper.** Never execute any write action against the league (waivers, lineups, trades, drops). The current MCP is read-only-by-construction, but if write tools ever appear: show the exact action and get explicit confirmation first, every time.
2. **No stale player analysis.** Training data on player values/depth charts/ADP is outdated. Any player-facing claim must be grounded in live Sleeper MCP data or current web search; if unverifiable, say so — never guess.
3. **Everything scored in THIS league's format** — never hand over generic/standard-scoring takes without translating.
4. **Docs track reality, in the same commit as the work.** A handoff doc that contradicts itself is worse than no doc: it reads as authoritative and sends the next reader down a dead end. Concretely, when you ship anything:
   - Move **`progress.md`**'s `Last updated:` stamp to the date you're actually committing. If you edited the body, the stamp moves. No exceptions.
   - Anything in **Next steps** that the work just completed comes **out of the list** — don't leave "not yet built" next to a section describing it working.
   - **One canonical dashboard URL: `https://hbgbs.irvinfamily.com/site/`.** The `hbgbs-hq.pages.dev` address still resolves and is still gated, but it appears in prose **only** as "the old URL also works" (currently just the Files entry below). If you're adding a link, use the custom domain. Files that carry it today: `progress.md` (header), `CLAUDE.md` (below), `.claude/commands/brief.md`, `.claude/commands/scout.md`.
   - Same discipline for the design of record, `plans/valuation-and-scouting.md`: new behavior gets its numbered subsection, and a claim that stops being true gets corrected rather than layered over.

## Files
- `league-profile.md` — rules + how the format distorts consensus value (draft/trade doctrine).
- `league-tendencies.md` — 6 seasons of owner dossiers, FAAB market prices, trade-partner map, self-scout.
- `data/raw/` — raw Sleeper JSON 2020–2025 (leagues, rosters, drafts, transactions, brackets). Refresh via `scripts/fetch-league-data.ps1` (read-only GETs; update its `$leagueId` for 2026).
- `data/faab-market.json` — compact FAAB pricing model (per-owner price-to-beat, bands, sample sizes). /waivers reads THIS for bids, never the raw transactions. Regenerate on demand: `node scripts/build-faab-model.mjs`.
- `briefs/` — dated outputs of /brief.
- Commands: `.claude/commands/` — brief, waivers, startsit, trade, scout. /waivers and /brief also publish JSON to `data/site/` for the dashboard.
- `site/` — HBGBs HQ dashboard (static; serve project root on :8642, open /site/). League ID lives in `site/config.js` too — update BOTH at renewal. The Draft Day page (`/site/draft.html`) **syncs live with a Sleeper draft**: paste a draft ID, hit connect, and it marks picks off itself (`?draft=<id>` overrides the stored ID), raises an on-deck prep panel at ≤3 picks away, and fills a roster grid as your picks land. `?at=<pickNo>` replays a finished draft to that pick. Specs: `plans/valuation-and-scouting.md` §1.15–§1.17.
- `scripts/draft-live.mjs` — live draft state as a compact CLI snapshot (on-the-clock, recent picks, position runs, best available, all 10 rosters). `node scripts/draft-live.mjs [--real|<draft_id>]`.
- **Sleeper REST is Cloudflare-cached and WILL serve stale data** (`stale-while-revalidate=300`; measured 41 picks vs 65 on the same endpoint mid-draft). Any read of a fast-changing endpoint must add a unique cache-busting query param. Applies to anything new that hits `api.sleeper.app`.
- **Live dashboard: https://hbgbs.irvinfamily.com/site/** (custom domain, added 2026-07-27; the old `https://hbgbs-hq.pages.dev/site/` still works and is still gated) — Cloudflare Pages, login-gated (ben.p.irvin@gmail.com email code). Auto-deploys on push to `main` of the private repo `benirvin714/fantasy-2026`; only `site/` + `data/site/` are served (build copies them to `dist/`), the rest of the repo stays unserved. Publishing = commit + push (the /brief and /waivers commands do this in their final step). Hosting details: `..\hosting-plan.md`.

## MCP notes
- Sleeper MCP: 13 read-only tools. No transactions endpoint and no free-agent-pool endpoint — supplement with Sleeper public REST (`https://api.sleeper.app/v1/...`, read-only GETs).
- If the Sleeper MCP is unavailable, commands must say so and state what's missing — never fabricate league data.
