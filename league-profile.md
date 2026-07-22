# League Profile — The HBGBs

> Data pulled 2026-07-17 from Sleeper (league ID `1257432557251731456`, 2025 season, complete).
> **The 2026 renewal does not exist yet** — when the commissioner renews, the new league ID must be recorded (check `get_user_leagues` for ThatWasButtery / season 2026). Settings below have been stable for years but re-verify against the 2026 league object once it exists.
> You: **ThatWasButtery**, roster ID **10** (every season), team "Njigba, please."

## The rules, in plain language

- **10 teams**, snake draft, 15 rounds, full redraft (a `max_keepers=1` setting exists but no keeper has ever been used in six seasons — treat as pure redraft).
- **Starters (10):** 1 QB, 2 RB, 2 WR, 1 TE, **2 FLEX** (RB/WR/TE), 1 K, 1 DEF.
- **Bench: only 5 spots**, plus 1 IR slot (OUT/IR designations only — Doubtful/Suspended don't qualify, tightened in 2022).
- **Scoring — half PPR with quirks:**
  - Receptions 0.5; rushing/receiving yards 1 pt per 10; all TDs from scrimmage 6.
  - Passing: 1 pt per 25 yards, **4-pt passing TDs**, INT only −1. Lost fumble −2.
  - Kickers: FG 0–39 = 3, 40–49 = 4, 50–59 = 5, 60+ = 6; XP = 1; **every miss under 50 (including XPs) = −1, misses from 50+ = 0** (this structure since 2024).
  - DEF: sack 1, INT 2, fumble recovery 2, TD 6, safety 2, block 2; points-allowed table from **+10 for a shutout down to −4 for 35+**.
- **Waivers: $100 FAAB**, processed Tuesdays, 1-day clear. Free agency after clears.
- **Playoffs: 6 of 10 teams**, weeks 15–17, bracket re-seeds. 14-game regular season (weeks 1–14).
- **Trade deadline: week 12** (moved from 10 in 2024). Draft-pick trading enabled (3 rounds); FAAB is tradeable and has actually been traded.

## How this format distorts standard player value

Public rankings mostly assume 12 teams, 1 FLEX, full or half PPR, deeper benches. This league breaks those assumptions in specific, exploitable ways. (The numbers below are replacement-level values, not player projections. Where marked **measured**, they come from six seasons of actual production re-scored in this format — see `data/positional-ladder.json` and `data/flex-split.json`; anything still labelled an estimate is structural math from the scoring rules and has not been validated.)

### 1. It's a normal-depth league at RB/WR and a very shallow league everywhere else

The single most important calculation: 2 RB + 2 WR + 2 FLEX × 10 teams = **60 startable RB/WR slots — identical to a 12-team, 1-FLEX league** (24+24+12). The second FLEX exactly cancels the depth relief you'd expect from 10 teams. Meanwhile QB/TE/K/DEF demand drops from 12 starters to 10, with almost no bench room for backups (50 bench spots league-wide must cover byes for 70 skill starters).

Consequences:
- **RB/WR valuations from 12-team boards carry over mostly intact**, and stay startable deep (~RB30/WR32 are weekly FLEX starters).
- **Mid-tier QB/TE/K/DEF are nearly worthless.** QB13–16, TE12–15, top-12 kickers, and the best DEF matchups sit on waivers all season. Only ~160 players are rostered vs ~192 in a 12-team league, and the cuts all come from the onesie positions.
- **Elite players are worth more than consensus everywhere**, because the gap between elite and free is the only durable edge when mid-tier is free.

### 2. Half PPR: reception haircut, TD premium

A reception = 0.5 pt = exactly 5 yards. Full-PPR boards price it at 10. An 85-catch possession receiver loses ~2.5 ppg vs full-PPR expectations; a two-down workhorse RB loses ~1.3. So relative to full-PPR sources: **RBs shift up about half a round; empty-volume slot WRs and pass-catching-specialist RBs are the most overrated archetypes; TD-dependent red-zone players are underrated.**

### 3. QB: wait — unless he runs

4-pt passing TDs and 1/25 yards compress passing value (an elite pure-pocket season ≈ 18 ppg). But QB rushing scores at RB rates: 1 yd rushing = 2.5 yds passing, and a rushing TD = 1.5 passing TDs. A QB with 700 rush yards + 7 rush TDs adds ~112 points — the equivalent of +28 passing TDs. With only 10 starting slots against ~32 NFL starters, streamed pocket QBs give ~16–18 ppg for free.

**Rule: never spend a top-2-round pick on any QB. A top rushing QB is worth rounds 3–5 (+5–7 ppg over the streamer). A pocket QB is a round 8–12 pick or a pure stream. Never roster two QBs.**

### 4. TE: elite at a discount, or punt — never the middle

Half PPR compresses TE scoring, and streaming replacement is higher than 12-team boards assume — **measured at TE10, not ~TE12** (`data/flex-split.json`: TE fills just 2.2% of FLEX slots, so barely more than ten TEs start league-wide in any week). Better replacement shrinks the elite premium: an elite TE delivers a **measured +3.6 to +5.9 ppg** in the onesie slot (`data/positional-ladder.json`), not the ~+6–7 previously estimated. A real weapon, but only at value (round 3-ish, never a round-1–2 reach; see the self-scout in [league-tendencies.md](league-tendencies.md)). **The TE5–9 band is the format's clearest trap**: a round 5–9 pick to beat the free streamer by 1–2 ppg. Punting costs almost nothing.

**And elite TE is a coin flip, not an asset.** Measured season-by-season, the best TE in football was worth +112, +57, +125, +52, +58, +87 over replacement (2020–25) — a 2.4× spread against elite RB's 1.33×. In three of six seasons the TE1 returned ~+55. This used to conflict with §10's draft-for-ceiling rule, which would have read that volatility as upside. **That conflict is now resolved in this section's favour: §10's ceiling premium was tested and retracted.** Variance does not buy playoff berths, so elite TE's 2.4× swing is uncompensated risk rather than a feature — punt-TE stands, and stands more firmly than before. (Weakly consistent: the third of team-seasons drawing the most scoring from the TE slot averaged 6.20 wins and 60% playoff rate, against 7.13 and 73% for the bottom third — but TE share is an outcome, not a strategy, so treat that as colour, not evidence.)

### 5. Kickers: the scoring inverts football logic

**The scoring changed in 2024**: through 2023 every miss cost −1 flat; from 2024 the miss penalty is banded and `fgmiss_50_59 = −1`. Only **60+** misses are free, not 50+. (Verify at renewal — this changed once already.)

Expected value per attempt, **measured** over 2024–25 (all NFL kickers, current settings): FG 20–29 ≈ 2.92, FG 30–39 ≈ 2.75, FG 40–49 ≈ 2.92, **FG 50–59 ≈ 3.26 (highest band)**, FG 60+ ≈ 2.79, XP ≈ 0.92 (barely anything, with downside). A 52-yard attempt is worth more than a chip shot; five XPs are worth less than two mid-range FGs.

**Winning profile: big leg + coach who attempts long FGs + offense that stalls between the 25 and 40. Trap profile: XP-machine on an elite TD offense.** But the big-leg edge is **thin, not free**: 50–59 beats the short bands by ~0.35–0.5 per attempt, not by a free roll. And 60+ is *not* the jackpot the free miss suggests — at a measured 46.4% make rate it returns 2.79, no better than a 30-yarder. The band to want is 50–59, not "as long as possible".

### 6. DEF: stream by opponent, don't pay for a name

The points-allowed table spans 14 points with 3-point cliffs (13 vs 14 allowed, 34 vs 35). One garbage-time TD swings 3+ points, so weekly DEF scoring is variance- and matchup-driven. Opponent implied total predicts the bracket better than defense quality does. Stream against bad offenses; keep one DEF roster spot weeks 1–13; a second DEF is only justified in weeks 14–16 to pre-buy playoff matchups.

### 7. Draft capital, in order

Season-long value over replacement (14-week regular season). **Measured** from six seasons re-scored in this format (`data/positional-ladder.json`), against replacement ranks measured from actual FLEX usage (QB10 / RB28 / WR32 / TE10). Two figures per position: value over a replacement you draft and start all year, and over perfect-hindsight weekly streaming. **True value sits between them** — a single number here would be a choice disguised as a measurement.

| | measured (draft repl.) | measured (stream repl.) | old structural est. | |
|---|---|---|---|---|
| elite RB | **+168** | +166 | +154 | understated |
| elite WR | **+139** | +122 | +133 | held up |
| elite TE | **+82** | +51 | +98 | overstated |
| elite rushing QB | **+88** | +39 | +98 | overstated |
| elite pocket QB | **+66** | +16 | +56 | held up |
| best DEF | — | — | ~+28 | **unvalidated** |
| best K | — | — | ~+21 | **unvalidated** |

K and DEF are not measured: Sleeper's DEF touchdown keys don't map cleanly onto the scoring settings, so a total would silently undercount. Left as estimates rather than guessed.

**Streaming gain by position** (weekly replacement minus draft replacement): RB **+2**, WR +18, TE +32, QB **+50**. Streaming is worth nothing at RB and a great deal at QB — the quantitative case for the no-backup-QB/TE rule below, and for RB being the one position where a bench spot earns its keep.

*Caveat on the whole table: "elite" is the ex-post #1 finisher, whom nobody can draft. These measure the prize, not the expected return on taking the consensus RB1.*

- **Rounds 1–3: elite RB/WR only** (RB lean vs full-PPR boards — measurement supports a *clearer* lean than "modest": +168 vs +139, and RB is the position where replacement is genuinely unavailable, streaming gain +2 vs WR's +18), or an elite TE falling to value — though the TE1 was a ~+55 season in three of the last six, so treat that branch as a lottery ticket, not a plan.
- **Rounds 4–7: RB/WR volume.** You need 4–5 weekly startables; FLEX demand keeps the scarcity curve as steep as a 12-team league. The WR25–45 band is flat — don't pay round-4 prices for WRs separated by ~1 ppg from round-7 WRs.
- **Rounds 8–12: QB (if not a faller earlier), upside bench.** Bench spots are for ceiling lottery tickets and at most one handcuff (to *your own* elite RB). No backup QB/TE, ever.
- **Last two rounds: K and DEF. Always.** (Six years of league data confirm nobody follows an early K/DEF pick — see tendencies doc.)

### 8. Trades: always consolidate

The roster spot you open in a 2-for-1 refills from waivers at ~7–8 ppg for free, so **getting the best player in any 2-for-1 is systematically +EV**, and public trade calculators (calibrated for 12-team depth) will overprice the depth you send away.

- **Sell high:** RB3/WR4 "solid depth," mid-tier QBs and TEs, name-brand defenses, possession receivers to full-PPR-minded managers, handcuffs to the manager who rosters the starter.
- **Buy cheap:** top-12–15 overall players via depth packages, elite rushing QBs (1QB deflates their price; their VORP is real), TD-dependent players discounted by PPR thinking, injured elites (IR slot + free replacements make stashing nearly costless).
- **Timing:** depth trades best in September before rivals internalize how rich waivers are; consolidate early — elites get pricier as the playoff race tightens.

### 9. FAAB doctrine ($100)

Because most adds have free equivalents, routine bids should be $0–3 (this league's actual market clears even lower — see tendencies doc). Reserve **$40–60+ for the 1–2 true league-winner events per season** (a handcuff promoted to workhorse). Money hoarded past week 14 is nearly worthless.

### 10. Small edges

- Lost fumble (−2) costs double an INT (−1): use fumble rate as a tiebreaker against high-touch RBs and sack-prone scrambling QBs; do **not** fade volume passers for INTs.
- ~~6-of-10 playoff field (60%): floor matters less, ceiling matters more. Draft and trade for spike weeks.~~ **RETRACTED — tested and unsupported** (`data/ceiling-vs-floor.json`, 60 team-seasons). Holding scoring level constant, week-to-week variance has no detectable effect on wins (t = −0.85) or on making the playoff field (t = +0.26). Every sign that does appear is *negative*, not positive. What predicts a playoff berth is scoring level and nothing else: mean weekly score t = 6.86, schedule-independent all-play% t = 8.13, and variance adds nothing on top of either. **Score more points; don't chase spike weeks to make the field.**
  - The stated reason ("60% field") is a claim about *qualifying*, and that is exactly what fails. A separate argument — that variance helps inside the weeks 15–17 tournament — is untested and **untestable here**: n = 6 champions. Do not treat this retraction as covering the playoff round.
  - Power: n = 60 detects large effects only. Read this as "no ceiling premium large enough to draft on", not "variance proven irrelevant". Even taking the point estimate at face value, spanning the entire observed spread in weekly sd (14.5 → 30.8) is worth −0.75 wins over a season.
- 2-pt conversions (2 pts) mildly favor goal-line backs and rushing QBs on go-for-2 coaching staffs.
