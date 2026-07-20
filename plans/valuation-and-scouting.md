# Plan — Player Valuation & Scouting Briefs

> Design doc for two dashboard upgrades, settled via a full grilling pass on 2026-07-20.
> Status: **Phase 1 (valuation fixes) shipped 2026-07-20; Phases 2–4 (scouting) not yet built.** Build sequence in §6.
> Scope note: neither of these is a from-scratch build — both finish and integrate machinery that already exists but is stubbed to `null`.

## 0. The one idea that unifies both

Valuation and commentary are **one loop, not two features**:

> Independent VORP surfaces a **gap** (your value rank vs the market's ADP) → a big gap is not a buy signal, it's a **question: why do I disagree with the market?** → the `scouting_brief` (Challenge 2) has to answer it → if the answer is a role/scheme delta the projection missed, it sets a capped `situation.modifier` and the gap closes on its own; if the answer is "no reason," the gap is either **real alpha** (act on it) or a **projection error** (fix it with an override). Nothing moves value silently, and every disagreement with the market is explained before it's trusted.

Everything below serves that loop.

---

## 1. Challenge 1 — Valuation & how variables are weighted

### 1.1 The engine (unchanged spine)

```
value = VORP × availability × situation
```

Multiplicative, because availability and situation are *proportional* adjustments to production-over-replacement. Validated subtlety: the haircut multiplies **VORP, not raw points** — when your player misses games you backfill from the rich RB/WR waiver wire at ~replacement, so the discount correctly applies to value *over* replacement. Current code already does this. Keep it.

### 1.2 The weighting philosophy

Don't hard-code false-precise weights. **Expose the two contestable weights as knobs, bound the soft ones, and zero-weight anything that would double-count.**

| Variable | Treatment | Rationale |
|---|---|---|
| Projection (base) | Sleeper stat line re-scored to league format; **calibrate** against Boris Chen consensus (big divergence → hand-review); per-player **overrides** in the overlay for the top ~30 | Free base kept; sharper signal used as a sanity flag, not an auto-blend |
| Market (ADP / Boris Chen) | **Zero weight in the number.** Stays a display axis; `gap = ADP − valueRank` is the actionable signal | Blending the market in shrinks the gap toward zero — deletes the edge the tool exists to find |
| Replacement level | **Fixed** (see 1.3) + exposed as a **sensitivity knob** | Current baseline mis-measures RB; the "right" rank is a judgment call, so make it visible |
| Ceiling / variance | **Display axis + tunable ceiling-tilt knob** (see 1.4) | League doctrine says ceiling > floor; mean-VORP is blind to it |
| Availability | Bounded multiplier (history × age-curve × current-status), injury-type component hand-researched | Pre-existing, reasonable; unchanged |
| Situation | Bounded multiplier ×0.90–1.10, **fed by the scouting_brief** (see 2 + M3) | Only deltas the projection missed; capped so soft narrative can't swamp hard math |
| `context.*` (contract, rookie capital, win total, playoff SOS) | **Display-only strip.** Never silent multipliers | Already in the projection (win total, rookie capital), too noisy (contract), or uncomputable now (SOS). Reaches value only *through the human* via overrides + situation |

### 1.3 The replacement fix (the load-bearing change)

**Problem found in the live board:** replacement is computed as the Nth-best *preseason* projection per position. Sleeper projects backup RBs at ~0 (they only play on injury), so RB replacement collapses (#46 RB ≈ 74 pts) while WR replacement is a real floor (#47 WR ≈ 135 pts). Result: **RB VORP is systematically inflated** relative to WR — the top-RB-vs-top-WR value gap on the board is partly a projection artifact, not real scarcity.

**Fix:** redefine replacement as *"the streamer you'd actually start"* — a backup who has *become* a starter, not a backup projected as a backup — applied **consistently across positions** so RB and WR measure the same real-world thing. Candidate approaches (calibrate at build): a starter-adjusted rank (~RB30 rather than RB46), or a floor on the projection pool so near-zero backup projections can't set the baseline. Then **expose the replacement rank N as a knob** so sensitivity is visible rather than a hidden hard-coded guess.

### 1.4 The ceiling axis (biggest doctrine-vs-formula gap closed)

`league-profile.md` §10: *"floor matters less, ceiling matters more — draft for spike weeks."* The mean-VORP formula can't see variance. Fix, in two visible pieces:

1. **Spike-week rate** — build from free Sleeper *weekly* stats 2023–25: per player, how often they post a top-N positional week. This is the signal that actually wins H2H matchups here.
2. **Render + control** — a display column + boom/bust badge (like the gap column), **plus a tunable ceiling-tilt knob** that blends `ceiling-VORP` into the ranking. Default = pure mean-VORP (clean, defensible); dial up to weight spike-week upside.

---

## 2. Challenge 2 — `scouting_brief` (public commentary)

### 2.1 What it is

A new, **distinct per-player field** — *not* merged into `adp_commentary`. It is the **evidence layer** (what the world says) that sits beside the **verdict layer** (`adp_commentary` = what you concluded). Keeping them separate preserves "the market thinks X, but I think Y" — the disagreement the gap system exploits.

Content: 1–5 sentences on external sentiment + scheme fit, **sourced + dated**. Doubles as the **audit trail** for any `situation.modifier` nudge.

### 2.2 Shape (M2): prose + signal sidecar

Generated together, from the same sources, in one synthesis pass:

```json
"scouting_brief": {
  "prose": "Scheme-fit first, then sentiment, then watch/risk. 1–5 sentences.",
  "signal": {
    "direction": "positive | neutral | negative",
    "magnitude": "none | slight | moderate",
    "rationale": "one line: the delta vs what the projection already assumes"
  },
  "sources": [
    { "label": "The Athletic", "url": "…", "date": "YYYY-MM-DD", "type": "coach | beat | analyst | player" }
  ],
  "as_of": "YYYY-MM-DD"
}
```

- **prose** renders to the user (detail block + hover tooltip). Coverage enforced by content rules (must address scheme fit + sentiment when sources exist), not visible sub-headers — readable, not robotic.
- **signal** is machine-read by the build script to set `situation.modifier` (M3). Born with the prose, so the two can never disagree.

### 2.3 Scope (tiered) + sources

- **Deep** for the top ~50 (where drafts are won, where `adp_commentary` already sits).
- **`null`** below the line — honest "not scouted yet," never faked.
- **On-demand deepening**: `/waivers` and `/trade` scout a deeper player when a live decision pulls him in.
- **Source priority**: coach pressers + team beat writers (scheme-fit half — highest weight) → national analysts (sentiment half) → player quotes (color, not signal).

### 2.4 Production model

**Two phases: seed once, then maintain.**

- **Seed (one-time, pre-draft):** a bulk pass with the existing **`deep-research` skill** (fan-out searches → fetch → *adversarially verify* → cited synthesis) over the top ~50, establishing every baseline brief. The adversarial-verify step *is* the sourcing guarantee. Timing floats with the draft date (2026 league not yet renewed) — target ~2–3 weeks out, once ADP stabilizes.
- **Maintain (ongoing):** folded into the daily `nfl-daily-events` routine. **Retrieval-grounded-or-null** is forced (ground rule #2): synthesis happens *only* from sources fetched/harvested at that moment, cited + dated; **no synthesis from model memory**; no usable sources → `null`. Trigger = **event-driven** (re-synthesize when the harvest flags fresh news — the event *is* the citation) **+ a staggered ~7-of-50/day backstop** for standing scheme-fit drift. Cost is bounded (~7–15 grounded syntheses/day, not 50).

### 2.5 The bridge (M3): sidecar → `situation.modifier`

**Discrete lookup table** (deterministic + auditable, not a free-floating LLM number):

| direction \ magnitude | slight | moderate |
|---|---|---|
| positive | ×1.03 | ×1.07 |
| neutral | ×1.00 | ×1.00 |
| negative | ×0.97 | ×0.93 |

Hard clamp **[0.90, 1.10]** (safety net the table never reaches). `null` brief → `null` modifier → ×1.

**The double-count guard (the #1 correctness rule):** the sidecar rates `direction/magnitude` as the **delta vs what the projection already assumes**, *not* the raw goodness of the news. "Coach confirms he's the workhorse" when Sleeper already projects him the workhorse = `neutral`, not positive. The synthesis step is fed the projection's implied role as an explicit baseline and rates the gap against it. Getting this wrong would silently re-count role expectations already in the projection and destroy value independence — so it's the thing to test hardest.

**Governance:** automated (table lookup off the sidecar), bounded by the clamp, fully transparent — `rationale + sources + as_of` always render beside any non-1.0 modifier. Seed pass gets adversarial verification; ongoing updates lean on clamp + transparency. No mandatory human gate. Stale brief → modifier *holds* until re-synthesized (staleness flag prompts refresh); no time-decay.

### 2.6 Render + storage

- **Where:** draft board **and** waiver board — expanded detail block + **hover tooltip** on the collapsed row (first sentence + freshness dot; progressive disclosure so board density survives draft-day scanning).
- **Honesty on screen:** inline source links + as-of date on every brief; "⚠ fresh news since this brief" flag when `nfl-events` postdates `as_of`; honest `null` below the tier line.
- **Storage:** `data/draft-research.json` (durable overlay — survives ADP rebuilds, same home as `adp_commentary`). `build-draft-board.mjs` merges it into `draft-board.json`.

---

## 3. Data-schema deltas (concrete)

**`data/draft-research.json`** — per player, add `scouting_brief` (§2.2 shape).

**`build-draft-board.mjs`** — (a) merge `scouting_brief` through to the board; (b) read `scouting_brief.signal` → table (§2.5) → set `situation.modifier` + carry `rationale/sources/as_of` into the `situation` object; (c) new build step: fetch weekly stats 2023–25 → compute `ceiling.spike_week_rate` per player.

**`site/draft.js`** — (a) replacement recompute per §1.3 + expose N knob; (b) ceiling-tilt knob blending mean-VORP ↔ ceiling-VORP; (c) render `scouting_brief` (detail block + tooltip); (d) render `context.*` display strip.

**Waiver board** — render `scouting_brief` for scouted free agents (shared overlay field).

---

## 4. What already exists (don't rebuild)

- VORP engine, multiplicative stack, per-position replacement, Boris Chen overlay, ADP-gap decomposition — `site/draft.js`, `scripts/build-draft-board.mjs`.
- `adp_commentary` (verdict layer, 106/248) + `clean_researched` sweep — `data/draft-research.json`.
- `nfl-events.json` harvester (daily routine, four lanes, dedup, sourced `so_what`) + `situationFacts()` player matching.
- The `deep-research` skill (seed pass) and the honesty contract (null-not-guess) the whole thing rides on.

## 5. Open items / risks (resolve at build)

- **Double-count guard is the top risk.** Validate the seed pass actually rates delta-vs-baseline, not absolute sentiment — spot-check signals against known already-priced situations before wiring the bridge.
- **Replacement recalibration** needs a numbers pass (candidate N per position, validated against the board's face-validity).
- **Spike-week threshold** (top-5? top-12 positional week?) — pick and sanity-check the resulting boom/bust labels.
- **Daily synthesis cost** — measure actual token burn in Phase 4; confirm within zero-cost tolerance, else fall back to thinner retrieval.
- **Availability injury-type component** stays hand-researched (pre-existing gap, unchanged by this plan).
- **Seed timing** depends on the 2026 league being renewed + ADP stabilizing.

## 6. Build sequence

**Phase 1 — Valuation fixes ✅ SHIPPED 2026-07-20:** replacement fix + basis knob (starters↔rostered, default starters); ceiling pipeline (Sleeper weekly 2023-25 → spike-week rate) + display column/badge + tilt knob; `context.*` display strip (honest pending). Files: `scripts/build-draft-board.mjs`, `site/draft.{js,html}`, `site/style.css`. Verified in-browser (no console errors; both knobs re-rank live; t=1 reproduces the old board exactly). *Delivered value before a single brief exists.*

**Phase 2 — Scouting seed:** bulk `deep-research` pass over top-50 → `scouting_brief` (prose + sidecar) into the overlay; render on draft board + waiver board (detail + tooltip).

**Phase 3 — Wire the bridge:** build script reads sidecar → table → `situation.modifier` + rationale render. *Now value reflects commentary, capped and audited.*

**Phase 4 — Maintenance automation:** fold event-driven + staggered synthesis into `nfl-daily-events`; staleness flags; cost telemetry.

*Rationale for the order: valuation improvements are self-contained and pay off immediately; the commentary layer seeds before it's wired to value; the bridge only turns on once briefs exist and the guard is validated; automation comes last, once the manual seed has proven the pipeline.*
