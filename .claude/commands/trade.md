---
description: Evaluate a proposed trade in HBGBs scoring — accept/decline/counter with reasoning
argument-hint: <proposed trade, e.g. "my Kittle + Irving for their Gibbs">
---

Evaluate this proposed trade for The HBGBs: **$ARGUMENTS**

Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation). **Analysis only — never execute or propose the trade inside Sleeper.**

## Procedure

1. **Parse the trade** from the argument: players/picks/FAAB on each side, and which league team the counterparty is. If ambiguous (player on multiple rosters' radar, unclear counterparty), ask before analyzing.
2. **Sleeper data**: `get_league_rosters` — both full rosters (verify every named player is actually on the stated roster; if not, stop and flag it). Note each team's record, points, positional surpluses/holes, FAAB remaining. If Sleeper MCP is unavailable, say so and ask the user to paste both rosters before continuing.
3. **Current outlook** (web search, dated sources): each key player's role, health, depth-chart security, rest-of-season schedule. No training-data player values — verify current reality.
4. **Value both sides in THIS format** (league-profile.md doctrine):
   - Half-PPR + 2 FLEX math: depth pieces are worth less than public calculators say (replacement is free ~7–8 ppg); elites worth more; 2-for-1s favor the side getting the best player
   - Onesie-position discounts: mid QB/TE have near-zero trade value here; konami QBs are the arbitrage buy; TD-dependent players are underrated by PPR-minded owners
   - Roster-construction fit for BOTH teams (bye overlap, playoff schedule wks 15–17, my 5-man bench)
5. **Counterparty intelligence** (league-tendencies.md; **HBGBs only** — The Panther Pit is in its first season and has no dossiers, so for that league skip this step entirely rather than inventing an owner read): their trade history and habits (e.g. Sladsous has never traded — question a sudden offer; DiaperDutyDaddy deals constantly; DadKing is price-disciplined), their current trajectory, and what THEY think they're getting — use it to judge whether a counter is live.
6. **Verdict**: clear **ACCEPT / DECLINE / COUNTER** with reasoning. If COUNTER, give the specific counter-offer and why it's plausible for that owner. Include what would change the verdict (e.g. injury news pending).

## Degradation
- No web search → verdict from roster-construction + format math only, labeled as lacking current-outlook verification, with reduced confidence.
