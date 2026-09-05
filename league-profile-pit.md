# League Profile — The Panther Pit (delta)

> **League ID `1401363352046825472`**, 2026, verified live 2026-09-04 against the Sleeper object.
> You: **ThatWasButtery**, roster ID **1**. First season — `previous_league_id` is null, there is no
> archive, and nothing in this file is inferred from another league's history.
> 12 teams, 15-round snake, drafted 2026-09-04, all 12 rosters full.

**Read [`league-profile.md`](league-profile.md) first.** This is a delta, not a replacement. The two
leagues are scoring-identical on **42 of 50 keys** and have a **byte-identical roster shape**, so
almost the whole doctrine in that file — half-PPR reception haircut, the 4-pt passing TD, the konami
rushing-QB premium, elite-TE-or-punt, stream the DEF, consolidate in trades — applies here unchanged.
What follows is only what differs.

## What is actually different

| | HBGBs | Panther Pit |
|---|---|---|
| Teams | 10 | **12** |
| Starters | QB/2RB/2WR/TE/2FLEX/K/DEF | identical |
| Bench + IR | 5 + 1 | identical |
| Scoring | half-PPR, 4-pt pass TD, INT −1, fum −2 | identical on 42 of 50 keys |
| FG misses | banded; **60+ misses are free** | **flat `fgmiss: -1` — every miss costs, at any distance** |
| FAAB | $100, Tuesdays | identical |
| Playoffs | 6 of 10, week 15, `playoff_seed_type: 1` | 6 of 12, week 15, **`playoff_seed_type: 0`** |
| Trade deadline | week 12 | identical |
| History | six seasons | **none** |

## 1. The depth math, which is the whole delta

`league-profile.md` §1 turns on one calculation: 2 RB + 2 WR + 2 FLEX × 10 teams = **60 startable
RB/WR slots**, identical to a 12-team 1-FLEX league, because the second FLEX exactly cancels the
relief you would expect from 10 teams.

Run the same arithmetic here and it lands somewhere else entirely:

- **72 startable RB/WR slots** (2+2+2 × 12). That is *deeper than a 14-team, 1-FLEX league*, which
  fields 70. This is one of the deeper RB/WR pools you can construct without going to 14 teams.
- **180 rostered players** against the HBGBs' 150. The NFL pool is the same size, so **replacement
  level is materially lower.**
- Onesies: **12 startable QB, TE, K and DEF** against 10.

What that changes, in order of how much it should move a decision:

1. **The last startable RB/WR moves from roughly RB30/WR32 to roughly RB36/WR38.** A player who is
   a fringe FLEX in the HBGBs is a comfortable one here. Do not read a Pit bench through HBGBs eyes.
2. **The waiver wire is thinner, and the difference is larger than the team count suggests.** 30 more
   rostered players come out of the same pool the HBGBs leaves on the wire, and they come
   disproportionately from the RB/WR tail, which is exactly where in-season value gets found.
3. **Elite players are worth more, not less.** Lower replacement level widens the gap between a
   first-round asset and the waiver alternative. `league-profile.md` §8's "always consolidate"
   doctrine is *stronger* here, not weaker.
4. **The mid-tier onesie relief is smaller.** The HBGBs leaves QB13-16 and TE12-15 on waivers all
   season. Here it is QB13+ and TE13+, a narrower band, so the "punt the position and stream" play
   has a slightly worse floor. It is still correct; it is just less free.

Bench pressure per team is **unchanged**: 8 skill starters against 5 bench spots either way. The
squeeze is a property of the roster shape, not the league size, and the roster shapes are identical.

## 2. Kickers: every miss costs

The HBGBs bands its miss penalties and lets a missed 60+ go free. The Pit charges a flat **−1 for
every missed FG at any distance**, plus −1 for a missed XP as both leagues do.

In practice this is small and it is worth knowing exactly how small: measured against the shared
draft board on 2026-09-04, every Pit kicker prices **2 to 3 points lower across a full season** than
the same kicker in the HBGBs, on totals around 100 to 115. It changes no ranking. Do not let it
justify paying up for a "accurate" kicker; the position is still a stream.

**A caveat that belongs here rather than in a footnote.** Sleeper's projection only publishes
`fgmiss_40_49` and `fgmiss_50p`, so a *banded* miss rule can never be scored exactly from it. The
Pit's flat rule can, which is why the Pit's kicker numbers are, if anything, the more honest of the
two. The HBGBs board currently ignores 50+ misses entirely and is under-penalising its own kickers by
about 2 points. See the note in `scripts/build-roster-room.mjs`.

## 3. Playoff seeding

The HBGBs runs `playoff_seed_type: 1` and re-seeds its bracket. The Pit runs **`playoff_seed_type: 0`**.
`[Likely]` that means a fixed bracket with no re-seed, which would make the 1 seed's path less
protected than in the HBGBs. **Not verified** — confirm against the bracket before this matters, which
is not until week 15.

## 4. No history, and what stands in for it

There is no `league-tendencies.md` for this league, no FAAB market model, no trade archive. Six of
the twelve owners are names that have never appeared in this repo.

Everything downstream branches on that rather than borrowing:

- **The roster room** shows a **Moves** column — completed transactions this season, live from
  Sleeper — instead of a trade-appetite band. Zero for everyone until somebody churns.
- **The waiver board** ships **unpriced**. Every other field is real; `bid` says so rather than
  guessing. Do not price it from `data/faab-market.json`: that model is 10 teams, and a 12-team
  league chasing a thinner pool with the same $100 will clear **higher**, so borrowing it would
  understate every bid in a consistent direction.
- **Trade proposals** still work, because they are pure lineup arithmetic and need no history. The
  first run after the draft returned **zero** proposals clearing the two-sided bar, which is the
  correct answer in a deeper league with less surplus, not a failure.

Once the Pit has accumulated its own 2026 bids, point `build-faab-model.mjs` at them and the pricing
layer turns on with no other change.

## 5. What to write down as the season runs

The 2027 version of this file wants what six seasons gave the HBGBs. Worth logging as you see it:
who bids aggressively and on what, who answers trade offers at all, who drafted a backup QB, who
churns the wire weekly. None of it is knowable yet, and guessing at it now would be exactly the
fabrication the rest of this system is built to avoid.
