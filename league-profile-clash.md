# League Profile — Couples Clash (delta)

> **League ID `1403499370376179712`**, 2026, read live 2026-09-09. You: **ThatWasButtery**, roster ID
> **11**, team "AI Coming for your Jobs". First season — `previous_league_id` is null, there is no
> archive, and nothing in this file is inferred from another league's history.
> 14 teams, 15-round snake from **slot 8**, draft complete, league status `in_season`.
>
> **Source note.** These settings came from a Flaim `get_league_info` read, not a direct Sleeper GET —
> the session that wrote this file could not reach `api.sleeper.app` (see CLAUDE.md, MCP notes).
> `scoring_settings` and `roster_positions` are verbatim and complete. **`playoff_teams`,
> `playoff_week_start`, `playoff_seed_type`, `waiver_budget` and the waiver day are NOT known** and are
> deliberately absent from `data/raw/league-clash-2026.json` rather than copied from the other two
> leagues. Fill them in on the first local run.

**Read [`league-profile.md`](league-profile.md) first.** This is a delta. On **43 of 50 scoring keys**
the two leagues are identical, and the roster shape is byte-identical, so most of that file — the
4-pt passing TD, the konami rushing-QB premium, stream the DEF, consolidate in trades — carries over
unchanged. But the two keys that differ include the single most load-bearing number in fantasy
scoring, so **§2 of `league-profile.md` does not carry over. It inverts.**

## What is actually different

| | HBGBs | Couples Clash |
|---|---|---|
| Teams | 10 | **14** |
| Starters | QB/2RB/2WR/TE/2FLEX/K/DEF | identical |
| Bench | 5 | identical |
| IR | 1 | **2** |
| **Receptions** | **0.5 (half PPR)** | **1.0 — FULL PPR** |
| Everything else scoring | — | identical on 43 of 50 keys |
| FG misses | banded; **60+ misses are free** | **flat `fgmiss: -1` — every miss costs, at any distance** |
| Trade deadline | week 12 | **none — `trade_deadline: 99`** |
| Playoffs | 6 of 10, week 15, re-seeded | **not verified — see the source note** |
| FAAB | $100, Tuesdays | **not verified** |
| History | six seasons, 10 owners | **none; 13 of 14 owners are new to this repo** |

## 1. Full PPR, which is most of the delta

A reception is worth **1.0 here and 0.5 in the HBGBs**. That is a 10-yard swing per catch between the
two formats, and it is the reason a player cannot be carried across leagues on the same number.

**The first consequence is procedural: public rankings are finally right.** `league-profile.md` §2
exists to undo the half-PPR haircut on consensus boards. Here there is nothing to undo — the
mainstream full-PPR board is this league's board, and any adjustment you make out of HBGBs habit is
an error in a consistent direction.

**The second is that `data/site/draft-board.json` is wrong for this league and must never be read
raw.** Its `projection.pts` is HBGBs arithmetic. Applied here it understates a 100-catch receiver by
**50 points over a season** and a 30-catch back by 15 — not noise, several rounds of draft capital.
This is exactly why `scripts/lib/leagues.mjs` sets `board_scored: false` for this league: every
rostered player is re-priced from raw stat lines in these settings. The board's league-agnostic half
— ADP, Boris Chen tier, scouting brief, bye week, availability — is still shared and still correct.

**The third is that the archetype ordering changes, not just the totals.** Scaling everyone up by
their catch count is not a uniform lift, and these move against each other:

1. **Pass-catching RBs go from the format's most overrated archetype to a live one.** `league-profile.md`
   §2 names them as overrated *because of the haircut*. Remove the haircut and a 60-catch committee
   back gains **+30 points** on the season while a 25-catch early-down grinder gains +12.5. In a lineup
   with 2 FLEX, that 18-point gap is a startable difference. **Do not carry the HBGBs read on this
   archetype into this league.** It is the single most common way this file will get ignored.
2. **Volume beats efficiency, and by a fixed amount you can compute.** A 100-catch, 12.0-yard receiver
   and a 70-catch, 17.1-yard receiver post the same 1,200 yards. Half PPR separates them by 15 points;
   full PPR separates them by **30**. The low-aDOT target hog is underpriced by anyone eyeballing
   yardage.
3. **Elite TE gets the biggest premium of the three leagues** — both differences push the same way. A
   85-catch TE gains +42.5 points, and there are 14 startable TE slots here instead of 10. `[Likely]`,
   direction certain, magnitude not measured: `league-profile.md` §4's measured +3.6 to +5.9 ppg is an
   HBGBs number off `data/positional-ladder.json`, and porting it here would be another league's
   arithmetic wearing this league's label. Re-measure before spending on it.
4. **QB value falls in relative terms.** QBs earn nothing from receptions, so every other position's
   totals inflate around them while a QB's stay put. The 14-team count pushes back the other way (14
   starting slots against ~32 NFL starters instead of 10), and `[Guessing]` on the net — the two
   effects are the same order of magnitude and nobody has measured either here. What survives from
   `league-profile.md` §3 unchanged is the *rule*: never a top-2-round QB, never roster two.
5. **TD-dependence is worth less.** Half PPR's TD premium (§2) is a relative statement — TDs matter more
   when catches matter less. Here catches matter fully, so the red-zone-only specialist loses ground
   to the volume receiver he was being compared against.

Kickers and defenses score identically in both leagues, so in a format where everyone else's totals
rose, **both are relatively cheaper here than in the HBGBs.** Stream them, harder.

## 2. Fourteen teams: the deepest RB/WR pool in the system

The calculation `league-profile.md` §1 turns on, run for each league:

| | RB/WR startable slots | Rostered players |
|---|---|---|
| HBGBs (10 teams) | 60 | 150 |
| Panther Pit (12) | 72 | 180 |
| **Couples Clash (14)** | **84** | **210** (+ up to 28 on IR) |

**84 is deeper than a 16-team, 1-FLEX league** (80 slots). There is no shallower way to read this
league. Concretely:

- **Replacement level is far lower than anything else in this repo.** A player who is a fringe FLEX in
  the HBGBs is a comfortable weekly starter here, and the gap is bigger than the 10→14 team jump
  suggests, because the second FLEX multiplies it.
- **The waiver wire is genuinely thin.** 60 more players are rostered from the same NFL pool than in
  the HBGBs, and they come disproportionately out of the RB/WR tail — precisely where in-season value
  is normally found. Expect the wire to be worse than it looks and price accordingly once the FAAB
  settings are known.
- **Elite players are worth more, not less.** Same argument as the Pit, one notch harder: the lower the
  replacement level, the wider the gap between a first-round asset and the free alternative.
  `league-profile.md` §8's consolidation doctrine is at its strongest here.
- **Onesies: 14 startable QB, TE, K and DEF.** The HBGBs leaves QB13-16 and TE12-15 on waivers all
  season; that band is gone here. Punt-and-stream still works — it is just no longer free.
- **`[Likely]` the FLEX runs WR-heavy**, since full PPR favours the position that catches more and 84
  slots reach deep into both pools. Not measured: `data/flex-split.json` is six seasons of HBGBs
  half-PPR data and its 2.2%-of-FLEX TE figure should not be quoted for this league. `scripts/measure-flex-split.mjs`
  is the way to settle it once there is a season of results.

Bench pressure per team is **unchanged at 8 skill starters against 5 bench spots** — that squeeze is a
property of the roster shape, and the roster shape is the same in all three leagues.

## 3. Two IR slots, not one

A second IR spot is worth more here than the same spot would be in the HBGBs, for the reason above: the
player you would otherwise cut to make room is not replaceable off this wire. Treat it as a sixth bench
spot that only accepts OUT/IR designations, and keep it filled.

## 4. No trade deadline

`trade_deadline: 99` means trading stays open all season, playoffs included. Two things follow:

- **Sellers have no forced deadline**, so the usual week-10-to-12 fire sale never has to happen, and the
  buyer's leverage that comes with it never arrives. Do not wait for a market that this league's rules
  do not create.
- **Trades during the playoffs are legal here.** That is a real strategic option and also a live
  league-politics hazard in a 14-team league of people who mostly know each other. Anything proposed
  after the regular season should be defensible to the whole league on its face, not just to the two
  teams in it.

## 5. Kickers: every miss costs

Same rule as the Panther Pit — flat **−1 for any missed FG at any distance**, plus −1 for a missed XP as
all three leagues do. The HBGBs bands its penalties and lets a missed 60+ go free. Measured in the Pit
this was worth 2 to 3 points across a full season on totals near 100 to 115, and it changed no ranking;
the same arithmetic applies here. Do not pay up for an "accurate" kicker.

The projection caveat from `league-profile-pit.md` §2 applies verbatim and in this league's favour:
Sleeper publishes only `fgmiss_40_49` and `fgmiss_50p`, so a *banded* rule can never be scored exactly
from it and a flat one can. This league's kicker numbers are the more honest of the two.

## 6. No history, and what stands in for it

There is no `league-tendencies.md` for this league, no FAAB market model, no trade archive. Thirteen of
the fourteen owners have never appeared in this repo. Everything downstream branches on that rather
than borrowing — see `league-profile-pit.md` §4, which describes the identical situation and the
identical handling: a **Moves** column instead of a trade-appetite band, an **unpriced** waiver board,
and trade proposals that still work because they are pure lineup arithmetic.

One addition specific to this league: **`data/faab-market.json` is 10-team half-PPR HBGBs pricing and
would be wrong here twice over** — wrong team count and wrong scoring. A 14-team league chasing a much
thinner pool will clear higher than either existing model, so borrowing would understate every bid in a
consistent direction. Wait for this league's own bids.

## 7. The roster you actually drafted

From the completed draft feed (2026-09-09), roster 11 came out of 15 rounds holding **8 RB, 2 WR, 2 TE,
1 QB, 1 K, 1 DEF**. Two structural notes, both facts about slot counts rather than player evaluations —
any claim about whether a specific player is good needs live grounding under hard rule 2:

- **Two WRs against two mandatory WR slots is zero cover.** One bye week or one inactive forces a FLEX
  RB into a WR slot, which the lineup rules do not allow — the slot simply goes empty or takes a
  waiver body. This is the roster's binding constraint, not its RB surplus.
- **It is an RB-heavy build in the format least friendly to one.** Both FLEX slots will run RB by
  default, in a full-PPR league where receptions are the point and `[Likely]` the FLEX market is WR.
  Six rostered RBs sit behind two starting slots.

The surplus is real and it is tradeable, and with no trade deadline there is no clock on fixing it.
`/trade` will price it in this league's settings once the build has run.

## 8. What to write down as the season runs

The same list `league-profile-pit.md` §5 carries — who bids and on what, who answers offers at all, who
churns the wire — plus two questions unique to this league: **whether anyone trades in the playoffs**
now that the rules allow it, and **the actual FLEX position split under full PPR**, which is the number
that would let §1 and §2 above stop saying `[Likely]`.
