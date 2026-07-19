---
description: Rank waiver targets for my roster with FAAB bids and drop candidates (recommendations only)
---

In-season waiver analysis for The HBGBs. Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation). **Recommendations only — never execute a claim.**

## Procedure

1. **Sleeper state**: `get_nfl_state` for season/week. If the Sleeper MCP is unavailable, stop and say exactly what's needed (league ID reachable via MCP or the public REST API) — do not fabricate a pool.
2. **My roster**: `get_league_rosters` (roster ID 10) — current players, and my remaining FAAB (`waiver_budget_used` out of the 100-dollar budget). NOTE: write FAAB amounts as "N dollars" or "FAAB N" in this file — a dollar sign followed by a digit is a positional-argument placeholder in command files and gets stripped at load time.
3. **Build the waiver pool** (no direct free-agent tool exists):
   - Collect ALL rostered player IDs across the 10 rosters → the "taken" set.
   - Candidate sources: `get_trending_players` (adds), web search for this week's waiver-wire articles/snap-count risers, and any player the news pass surfaces.
   - A candidate is in the pool only if NOT in the taken set — verify each via `search_players` or the rosters data. Never recommend a rostered player as an add.
4. **Current-data cross-reference** (web search): snap counts, route participation, injury news creating opportunity, role changes, upcoming schedule. Preseason dry-run mode: treat all unrostered players as the pool and rank stash candidates instead of weekly pickups.
5. **Rank targets** — value in THIS format (half-PPR, 2 FLEX, konami QB, kicker/DEF quirks per league-profile.md). For each target:
   - Why now (evidence + date of source)
   - **Suggested FAAB bid**, using league-tendencies.md market data: routine adds cost 1–12 dollars (67% of claims go uncontested); DadKing caps at 25; frenzy-class RB adds need 60+ or abstain; factor my remaining budget and week (money hoarded past wk14 is dead).
   - Likely competition (which owners, from their tendencies dossiers — e.g. StoneBone69 claims everything cheap, ENOTS overbids RB handcuffs).
   - **A specific drop candidate from my roster** with reasoning; flag if the drop is scoopable by rivals (StoneBone69 especially).
6. **Output**: ranked table + bid plan. End with total FAAB committed if all claims hit, and what remains.
7. **Publish to the dashboard**: write the same ranked targets to `data/site/waivers.json` (schema: `{generated: "YYYY-MM-DD", mode, faab_remaining, note, targets: [{rank, player, pos, team, why, bid, competition, drop}]}`). The HBGBs HQ site (`site/`) renders this file and flags it stale after 7 days.
8. **Push live**: commit and push so the hosted dashboard updates (Cloudflare Pages auto-deploys from GitHub): `git add data/site/waivers.json && git commit -m "Publish waiver board YYYY-MM-DD" && git push`. The live dashboard is https://hbgbs-hq.pages.dev/site/ (login-gated). If the push fails, say so — the local file is written but the live site is stale until pushed.

## Degradation
- No web search → Sleeper-only mode: trending adds + roster math, clearly labeled as lacking role/injury verification.
- No Sleeper MCP → stop; state that roster + pool data is unavailable and ask whether to proceed web-only against a user-provided roster list.
