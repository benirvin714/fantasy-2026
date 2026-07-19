---
description: Rank waiver targets with my-team impact verdicts, history-priced FAAB bids, and rival-need pressure (recommendations only)
---

In-season waiver analysis for The HBGBs. Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation). **Recommendations only — never execute a claim.**

NOTE: write FAAB amounts in this file and in outputs as "N dollars" or "FAAB N" — a dollar sign followed by a digit is a positional-argument placeholder in command files and gets stripped at load time.

## Procedure

1. **Sleeper state**: `get_nfl_state` for season/week. If the Sleeper MCP is unavailable, stop and say exactly what's needed (league ID reachable via MCP or the public REST API) — do not fabricate a pool.
2. **All rosters, one call**: `get_league_rosters` (the league ID in CLAUDE.md). From this single call take: my roster (roster ID 10), my remaining FAAB (`waiver_budget_used` out of 100), every rival's roster + remaining FAAB, and any in-season injury designations on rostered players (`player_info.status`).
3. **Build the waiver pool** (no direct free-agent tool exists):
   - Collect ALL rostered player IDs across the 10 rosters → the "taken" set.
   - Candidate sources: `get_trending_players` (adds), web search for this week's waiver-wire articles/snap-count risers, and any player the news pass surfaces.
   - A candidate is in the pool only if NOT in the taken set — verify each via `search_players` or the rosters data. Never recommend a rostered player as an add.
4. **Current-data cross-reference** (web search): snap counts, route participation, injury news creating opportunity, role changes, upcoming schedule. Preseason dry-run mode: treat all unrostered players as the pool and rank stash candidates instead of weekly pickups.
5. **Rival-need map** (token-cheap — no extra web research):
   - Read `data/site/nfl-events.json` (local, curated daily) and cross-reference its injury/role/trade items against rival rosters: an item hitting a rival's starter marks that rival NEEDY at that position now.
   - Injury designations from the step-2 rosters data add to the same map (Out/IR starters = acute need).
   - ONE extra REST call: `https://api.sleeper.app/v1/league/<id>/transactions/<week>` for the current and previous week — intra-league trades/drops reveal fresh holes (traded away a WR → WR-needy) and who is actively churning.
6. **Price and rank targets** — value in THIS format (half-PPR, 2 FLEX, konami QB, kicker/DEF quirks per league-profile.md). For pricing, read **`data/faab-market.json`** — do NOT re-read league-tendencies.md and NEVER re-aggregate data/raw for pricing (that is what the model file is for; regenerate it with `node scripts/build-faab-model.mjs` only when a new season's transactions accumulate). For each target produce:
   - **why**: the league-wide case (evidence + source date).
   - **my_team_impact** + **verdict** (PURSUE / WATCH / AVOID): would he crack my starting 10 (which slot/FLEX)? What does he add vs my incumbent (ceiling/floor/role)? Bye coverage? What does the drop cost me? AVOID is a first-class answer — a trending name that doesn't fit my roster gets an explicit avoid-with-reason.
   - **pressure** (low / medium / high): from the step-5 need map — rivals with an acute need at this position AND money raise pressure; needy-but-broke rivals are named but don't raise the price.
   - **Suggested bid**: start from the model's bands (routine_uncontested 1-3; contested_routine 8-12; frenzy_floor 60+). Raise to clear the specific interested rivals' `price_to_beat` — but apply the model's **small-sample rule**: if that rival's `n_contested` is below 8, ignore their price_to_beat and use the league band, saying so. Cap by my remaining budget and the calendar (money is near-dead after week 14). One-line rationale naming who is priced in ("12 dollars — clears StoneBone69 volume claims; ENOTS is broke at 6 left").
   - **drop**: a specific drop candidate from my roster; flag if the drop is scoopable (StoneBone69 especially).
7. **Output**: ranked table + bid plan. End with total FAAB committed if all claims hit, and what remains.
8. **Publish to the dashboard**: write `data/site/waivers.json` with schema `{generated: "YYYY-MM-DD", mode, faab_remaining, note, targets: [{rank, player, pos, team, why, my_team_impact, verdict: "pursue"|"watch"|"avoid", pressure: "low"|"medium"|"high", bid, competition, drop}]}`, then commit that file ("Publish waivers YYYY-MM-DD"), pull --rebase, push (report failures plainly; never force-push). The HBGBs HQ site renders it and flags it stale after 7 days.

## Degradation
- No web search → Sleeper-only mode: trending adds + roster math + rival-need map from local data, clearly labeled as lacking role/injury verification.
- No Sleeper MCP → stop; state that roster + pool data is unavailable and ask whether to proceed web-only against a user-provided roster list.
- No `data/faab-market.json` → say so and price from bands stated in league-tendencies.md's FAAB section, flagged as unmodeled.
