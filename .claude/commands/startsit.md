---
description: Review my current lineup vs matchups, injuries, weather; flag changes worth making (never sets lineup)
---

Start/sit review for The HBGBs. Read CLAUDE.md rules first. **Recommendations only — NEVER attempt to set the lineup** (the MCP is read-only; even if a write path existed, lineup changes are the user's to make).

## Procedure

1. **Sleeper state**: `get_nfl_state` → current week. If offseason, say start/sit doesn't apply and stop. If Sleeper MCP unavailable, stop and say what's missing.
2. **My lineup**: `get_league_rosters` roster 10 — current starters vs bench, plus IR. `get_matchups` for this week → my opponent's roster; note their projected strengths for risk-calibration (favored → prefer floor; underdog → prefer ceiling).
3. **Current-data checks** (web search, dated sources):
   - Injury designations for every player on my roster (Q/D/O, practice participation); game-time-decision risk and pivot plans for late games
   - Matchups: opposing defense vs position, implied totals/spreads
   - Weather for outdoor games (wind matters most — especially for my K and any deep-ball-dependent players)
   - Kicker check per league-profile.md: distance-band scoring favors big-leg/long-attempt volume; flag if my kicker's matchup (dome/wind/offense stalling zone) argues for a stream
   - DEF check: opponent implied total is the predictor; flag a better stream if mine faces a high total
4. **Flag changes worth making** — only differences that matter (~1+ ppg expected or meaningful floor/ceiling logic), each with: who sits, who starts, reasoning in THIS league's scoring, and confidence. If the current lineup is already right, say so plainly.
5. **Bye/lock warnings**: any starter on bye or already locked, and Thursday-game deadlines.

## Degradation
- No web search → say the injury/weather layer is unavailable; give matchup-free roster-logic only, clearly labeled.
- No Sleeper MCP → ask the user to paste their lineup; proceed web-only against that.
