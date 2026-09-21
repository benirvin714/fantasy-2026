# Roster performance module (HQ) - decision log

_Agreed in a grilling session, 2026-09-21, and shipped the same day. **What shipped is described in
`plans/valuation-and-scouting.md` §1.32, which is the design of record.** This file is kept as the
record of why each call went the way it did, including the two that were reversed (Q2 and Q11), so
the next person does not relitigate them from scratch._

## What it is
A panel at the top of in-season HQ's left column, above NFL updates, in all three leagues. It says
how my roster is doing relative to the league, why, and which existing action addresses the gap.

## Decisions
| # | Decision |
|---|---|
| Q1 | "Performance" = results displayed first, projection as the luck check. |
| Q2 | ~~Verdict weight on results = `games / (games + k)`.~~ **Superseded by Q14.** k was calibrated as agreed and the calibration killed the blend. |
| Q9 | All three leagues. (The borrowed-k half of this is moot after Q14: nothing borrows k because nothing uses it.) |
| Q11 | ~~Blended rank + basis.~~ **Revised by Q14:** headline = **Standing** (record, seed, games from the playoff line) and **Strength** (projected rank), side by side, plus one sentence naming the largest gap between them. No categorical labels (every bucket boundary is a cliff). |
| Q14 | **No blend. Standing and strength are read separately.** `scripts/calibrate-perf-k.mjs` on HBGBs 2020-25 (760 team-checkpoints): leakage-free k = 51 (results weight 7% at wk 4, 20% at wk 13; per-season refits 38-207), and against a rest-of-season projection k is unbounded (projection alone is optimal in all six refits). Rest-of-season error: results-only 15.6 pts/g, projection-only 11.8 / 10.1. Weekly SD ~22.6 vs true-strength SD ~6.1, and Sleeper's in-season projections already absorb play to date. So results get the question they own outright (standing: wins decide seeding) and projection gets the one it predicts (strength). k survives as a documented finding in `data/perf-k.json`, not an input. |
| Q8 | Metrics row: record · PF rank · all-play record (schedule luck) · scored vs projected (performance luck) · lineup efficiency (optimal vs scored). |
| Q13 | Always expanded, fixed shape. Each metric expands to week-by-week detail (all-play W-L per week; scored vs projected per week; bench points left per week + the swap that would have scored them), using the draft board's compact disclosure pattern. On HQ, not the roster room. |
| Q12 | A week counts only when ESPN marks every game final (`status.type.completed`). A partial week shows my score, my opponent's, and players left to play, marked in progress. Nothing derived (standing, all-play, proj gap, efficiency) includes it. |
| Q3 | Byes: rolling 3-week look-ahead. |
| Q4 | Plus: any bye in a week after the league's trade deadline is pinned from now until the deadline passes. Deadline-based, never a hardcoded week. Couples Clash (`trade_deadline: 99`) never pins. |
| Q5 | A bye triggers only when the replacement-aware loss (best bench player OR best current free agent at that position) exceeds a threshold set from the league's own distribution (e.g. p75 of replacement-aware bye losses, computed at build). Streamable K/DEF/QB byes stay quiet. Accepted: this can un-pin Week 13 if the wire genuinely covers it. |
| Q6 | Recommendations are routed, never generated: up to 3, each naming the gap it closes and pulling the best existing action (top matching `waivers.json` target, or top `roster-room.json` trade proposal). If nothing addresses a gap, say so explicitly. |
| Q7 | Deterministic. Built inside the twice-daily `npm run build:leagues`; no LLM. |
| Q10 | Follow-up, separate: narrow `/brief` to NFL landscape + rival leverage and drop its my-roster lines. **Done 2026-09-21**: a Scope section in `.claude/commands/brief.md`, and the HQ panel renamed "Around the league". |
| Q15 | **Waiver-board blind spots are named, never recommended.** When a free agent the waiver board does not list at all (any verdict) beats the best routed action for the same gap by 5+ season points, the panel says so as a diagnostic about the board. Positional gaps only: a flagged bye is already measured after the best free pickup. Raised by Bo Nix, a free agent projecting above Mahomes. As built it compares gains, not costs, so on 2026-09-21 it stays quiet on Nix (+9) against Tuten-for-Hurts (+23.8) even though the trade costs the roster's one trade chip; that is a known limit, left as agreed. |

## Build status
- **Step 1 (k calibration): done 2026-09-21.** `scripts/calibrate-perf-k.mjs` -> `data/perf-k.json`, with the history it read cached in `data/raw/matchups-YYYY.json` and `data/raw/proj-weekly-YYYY.json` (~1.7MB total). Outcome is Q14.
- **Steps 2-4 done 2026-09-21**: the `performance` block in each league's `roster-room.json` (`scripts/lib/performance.mjs` + the build), the HQ panel, and the docs. Verified in the browser for all three leagues and at 375px. Playoff counts and deadlines are read from the live league object: HBGBs 6/10 and week 12, Pit 6/12 and week 12, Clash 7/14 and no deadline.
- **Unexercised path:** the no-final-week state (week 1 before kickoff) is coded but could not be seen live, since every league was past it at ship time.

## Build-time calls (not re-asked)
- Output lives in a new block in each league's `roster-room.json` (that build already holds week data, optimal lineups and proposals).
- The Pit's trade deadline is read from the live league object.
- Docs move in the same commit: new `plans/valuation-and-scouting.md` subsection, `progress.md` stamp + body, `CLAUDE.md` files entry.

## Reference numbers at design time (2026-09-21, HBGBs, season-projection per game)
Bye-week lineup loss, bench-only (NOT yet replacement-aware): wk5 16.9 (QB empty), wk6 8.3 (K empty),
wk10 12.8 (DEF empty), wk13 11.1 (no empty slot), wk14 2.8. League-wide, 67 team-bye-weeks:
median 6.2, p75 11.1, p90 19.2, max 26.1. Caleb Douglas has `bye: null` - a source gap to handle,
not a zero.
