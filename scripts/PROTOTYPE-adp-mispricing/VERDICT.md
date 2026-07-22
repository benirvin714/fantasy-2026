# VERDICT — ADP mispricing prototype

**Status: answered. Throwaway. This branch exists as a primary source; nothing here belongs on `main`.**

## The question

Does the national fantasy ADP market misprice players in a way that is (a) systematic,
(b) explainable by covariates knowable in August, and (c) persistent enough to survive
walk-forward validation?

## The answer

**No at the player level. No at the positional level except TE — and the RB/WR result
that looked strongest turned out to be an artifact of my own assumption.**

## Data (all free, read-only, no auth)

| layer | source | coverage |
|---|---|---|
| price | FantasyFootballCalculator `/api/v1/adp/half-ppr?teams=12` | 2018–2024 + 2026 live. **2025 absent.** Each year is a tight late-August snapshot (`meta.start_date`/`end_date`) — this is the leak control, and it's why FFC beat MFL here despite smaller samples |
| payoff | Sleeper `/v1/stats/nfl/regular/{year}` | back to 2009; `pts_half_ppr`, `gp`, `gms_active` |
| meta | Sleeper `/v1/players/nfl` | position, `birth_date`, `search_full_name` |

Rejected: MyFantasyLeague ADP (2014–2026, real drafts, larger samples) — its `DAYS`
window parameter is **inert**, verified identical output at DAYS=1/30/unset, so it can
only give season-cumulative ADP contaminated by in-window news. No leak control.

Panel: **1,160 skill player-seasons**, match rate 98–99.4%, 17 misses (all nicknames:
Hollywood Brown, Will Fuller V, Nyheim Hines). K/DEF excluded throughout.

## Findings

**1. Market error is per-game production, not availability.** At RB/WR/TE, corr(total
error, per-game error) ≈ 0.81–0.86 vs corr(total error, games error) ≈ 0.64–0.68 →
~62% production, ~38% availability. The 38% is a *floor*: players who missed the whole
season have no PPG and drop out of the correlation. QB splits roughly evenly (0.53).

**2. No player-level edge.** Train 2018–21 (n=713) → test 2022–24 (n=447) on log(ADP),
age, rookie flag, prior PPG, prior GP, and market disagreement (`stdev/adp`):

```
in-sample R²             0.012   (only priorGP had |t|>2, at 3.0)
out-of-sample Spearman  -0.048
tercile spread          -0.072   vs residual sd 0.427
per season: 2022 -0.066   2023 -0.031   2024 -0.025
```

Negative in every test season — the third predicted cheapest did *worse*. Dead.

**3. TE is underpriced; RB/WR is an artifact.** Pooled VORP curve, mean residual by
position, across five replacement-level assumptions:

| assumption | QB | RB | WR | TE |
|---|---|---|---|---|
| baseline QB12/RB30/WR42/TE12 | −0.11 (−1.3) | −0.17 (−4.0) | +0.16 (+4.6) | +0.20 (+3.5) |
| no-flex QB12/RB24/WR36/TE12 | +0.03 (0.4) | −0.27 (−6.3) | +0.15 (+4.4) | +0.35 (+6.1) |
| **flex-RB QB12/RB36/WR36/TE12** | −0.13 (−1.4) | **+0.03 (0.7)** | **−0.02 (−0.6)** | +0.18 (+3.2) |
| deep-TE QB12/RB30/WR42/TE18 | −0.14 (−1.6) | −0.19 (−4.5) | +0.14 (+4.0) | +0.37 (+6.5) |

RB and WR **both flip sign and lose significance** when the flex is assumed RB-filled.
That result is a function of a parameter I picked, not a market fact.

TE survives every assumption *and* is positive in all 7 individual seasons
(+0.28, +0.06, +0.20, +0.08, +0.20, +0.30, +0.26) with no decay. WR decays hard
(0.26 → 0.06 by 2024), consistent with the market closing it.

**4. The drafted pool is a poor map of the outcome at QB/TE.** Share of actual top
finishers with no ADP at all: QB top-12 ran 25–42% undrafted in 2022–24; TE top-12
ran 17–42% undrafted every year. RB/WR: 0–17%. Every residual above is blind to these
players.

## Known limitations (do not cite the numbers above without these)

- **Stage 7 is not walk-forward validated.** Sign-stability across 7 seasons is the
  only out-of-sample evidence for the TE result.
- **VORP is normalized by the pooled season sd, which is itself config-dependent.**
  This is why the 2QB row (dropped from the table above) mechanically compresses every
  non-QB position toward zero. Normalize per-position or on a fixed scale before
  trusting cross-config comparisons.
- Raw season points ignore weekly lineup decisions, streaming, and in-season pickups.
- FFC ADP is **mock-draft-derived**. Mockers face no real cost. The 2018–24 overlap
  with MFL would measure that bias directly; not done here.
- 2022 FFC has only 124 rows (~10 rounds), so that season's panel is truncated early.

## Next step

The flex-allocation assumption is now the load-bearing unknown — it decides whether
RB/WR mispricing exists at all. It is **measurable from real draft-and-roster data**
rather than assumed. Settle that before adding a single covariate to the player-level
model, which just failed its walk-forward.

## What would graduate to `main`

Only `mispricing.mjs` (LOESS, OLS, spearman, tercile spread — all pure), and only if a
finding survives the flex question. Nothing has earned that yet.
