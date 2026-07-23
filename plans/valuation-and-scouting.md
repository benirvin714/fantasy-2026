# Plan — Player Valuation & Scouting Briefs

> Design doc for two dashboard upgrades, settled via a full grilling pass on 2026-07-20.
> Status: **Valuation REDESIGNED 2026-07-20 (§1, 3-layer model). Phases A ($-engine + edge) and B (uncertainty band + rec-confidence) both shipped. Scouting (§2) not yet built.** Build sequence in §6.
> The original VORP-as-value design (Phase 1, shipped then superseded) is preserved in git history; §1 below is the current algorithm.
> Scope note: neither of these is a from-scratch build — both finish and integrate machinery that already exists but is stubbed to `null`.

## 0. The one idea that unifies both

Valuation and commentary are **one loop, not two features**:

> **Asset value** (what a player produces) → **scarcity** → **draft-$** (auction dollars) → compared to the **market's $** at his ADP slot → **edge** (over/undervalued, and by how much) → **recommendation** (TARGET/FAIR/FADE), gated by **confidence** = `min(edge size, how much you trust the asset read)`. A big edge you can't trust (rookie, injury, experts split) is *capped, not acted on*. The `scouting_brief` (Challenge 2) feeds the trust side — role/scheme stability tightens or widens the uncertainty band — and annotates the recommendation. Nothing moves value silently; every edge is decomposed, and every low-confidence call is flagged.

Everything below serves that loop.

---

## 1. Challenge 1 — Valuation & how variables are weighted

### 1.1 The three layers (per player, never fused into one opaque number)

1. **Asset value** — *what he produces.* `rate` (Sleeper proj ÷ 17 = healthy per-game) × **median games** (light PT model, §1.3), **floored at 0**. Position-agnostic, descriptive — *not* the draft sort.
2. **Uncertainty** — *how wrong the median could be.* A $ band (low–median–high) + High/Med/Low tier + drivers, from the PT band + Boris Chen expert disagreement + rookie/role flags. Weekly boom/bust is a **separate** ceiling attribute, not confidence. *(Phase B.)*
3. **Recommendation** — *mispriced, and by how much.* The pipeline below → TARGET/FAIR/FADE, gated by rec-confidence = `min(edge size, asset confidence)`.

### 1.2 The pipeline (asset → edge)

```
 rate × median games   →  asset value (≥ 0)            ① what he produces
 − replacement (scarcity line, knob)  →  marginal (≥0) ② positional scarcity
 → auction draft-$  (normalized, $1 floor)             your price
 vs market-$  (the $ of his ADP slot)                  market price
 → edge = draft-$ − market-$  →  TARGET / FAIR / FADE   ③ over/undervalued + degree
```

- **One currency — $.** Draft edges *and* FAAB waiver bids are both dollars → same engine, both contexts.
- **No negatives.** Asset ≥ 0, marginal ≥ 0, draft-$ ≥ $1. Kills the old "141 players below replacement, Kamara 240th" pile-up that drove the VORP-vs-ADP divergence.
- **Scarcity is visible *and* separable** — its own step, shown as a distinct layer, then folded into the $.
- **Edge in $ (honest magnitude) + picks (draft intuition).** Late-round $1 players correctly compress to ~$0 edge; the pick-gap still shows their divergence.
- **Phase-A stopgap for confidence:** on a TARGET/FADE where Boris Chen *contradicts* the call by ≥15 ranks, a ⚠ flags "you're the outlier" until the real Phase-B cap lands (e.g. Josh Allen $46/rank-10 vs ADP+BC ~24).

### 1.3 Playing-time model (rate vs games, availability as a light band)

Sleeper's projection is `rate × 17` (full health) — `gp` reads 18 for everyone, a placeholder. So: **`rate` = proj ÷ 17**, and **games are modeled here**:
- **Median games stays near-full (~16–17)** — moved down only for *documented* reasons: current injury/PUP status, a chronic multi-year games-missed pattern (regressed at 0.3, vs the old score's 0.6 multiplier), or an age cliff. Deliberately gentle — the old availability multiplier was too drastic.
- **The injury signal lives in the band width** (Phase B), not the median: durable → tight, chronic/PUP → wide, rookie → wide (job not locked). Two players with the same median can have very different bands → the wide-band one gets its rec-confidence capped.

### 1.4 Uncertainty & recommendation-confidence (Phase B)

- **Asset-confidence band** = the Q3 PT band + Boris Chen `best/worst/std_dev` (expert disagreement) + rookie/new-team/committee flags → a $ band (low–median–high) + H/M/L tier + visible drivers.
- **Recommendation** = TARGET/FAIR/FADE (draft) / BID-PASS (waiver) / BUY-HOLD-SELL (trade) from the edge sign + threshold.
- **Rec-confidence = `min(edge strength, asset confidence)`** — the weaker link governs. Big edge + tight band = high-confidence TARGET; big edge + wide band = capped ("edge huge, but role/health unresolved").
- **Single-source noise → uncertainty, not a regressed number.** When Sleeper and Boris Chen disagree, that widens the band and caps confidence — the edge stays visible but honestly flagged. (Phase A previews this with the ⚠.)
- **League-mates** = a separate *actionability* note from `league-tendencies.md` (a rival will snipe this value / FAAB pressure) — annotates the rec, never moves the edge.

### 1.5 Build status & calibration defaults

**Phase A shipped** (`site/draft.js`, client-side — no rebuild; reuses existing board fields): the full pipeline (1.2), the light median-games model (1.3), TARGET/FAIR/FADE + the ⚠ stopgap, and the replacement (scarcity) knob. (Board sort/column layout was later reworked to lead with Boris Chen — see §1.10.) The ceiling-tilt knob was **retired** (ceiling is now a pure display attribute).

Tunable calibration defaults (all constants at the top of `draft.js`): auction budget $200 × 10 teams; edge thresholds **TARGET ≥ +$4 / FADE ≤ −$4** (from the observed edge distribution: median 0, p90 +6, p10 −5); median-games regression 0.3; ⚠ when BC contradicts a rec by ≥15 ranks. Replacement line = starter-basis default (RB30/WR32/QB11/TE11), knob-adjustable to rostered.

**Phase B shipped:** asset-confidence tier = `min(playing-time risk, disagreement)`, where disagreement folds *both* Boris Chen internal spread (std/range) *and* board-vs-consensus outlier-ness in the rec's direction. Rec-confidence = `min(edge strength, asset confidence)` → ●○○/●●○/●●● dots on the badge, with the cap reason and a $ band shown on expand. Calibrated to a sensible spread (of 53 TARGET/FADE calls: ~2 High, ~16 Med, ~35 Low — honestly humble for a single-source board; Cook #4-vs-BC-#35 reads Low, Bijan reads High). Thresholds are all tunable constants.

### 1.6 Migration & how the old pieces map in

- **Replacement model (old §1.3 fix)** → now sets the **scarcity line** in the pipeline (measured on *asset points*, not raw projection). Same starter-basis default + knob.
- **Ceiling / spike-week rate (old §1.4)** → stays as a **separate display attribute** (column + boom/bust badge). The ceiling-*tilt* knob is **retired** — ceiling no longer moves value (it's the "weekly boom/bust" that 1.4 explicitly keeps out of confidence).
- **Availability** → repurposed into the **light median-games model + Phase-B band** (1.3), instead of the removed value multiplier.
- **Situation modifier / `scouting_brief`** → no longer a value multiplier. The `scouting_brief` (§2) feeds the **Phase-B role-stability band** and the **recommendation's actionability note**, not the number.
- **`context.*`** → unchanged: display-only strip.

### 1.7 Draft vs in-season waivers

One engine, two contexts. **Draft (built):** market = ADP/BC, rate = Sleeper season projection.

**Waivers — scaffolding built 2026-07-21, live once the season starts:** `/waivers` now applies the same **asset → worth → edge → verdict + rec-confidence** model against the **FAAB market** (`faab-market.json` bands + rival `price_to_beat` + pressure). `waivers.json` schema + the dashboard render carry `asset` / `rate_basis` / `worth` / `edge` / `confidence` / `confidence_why`; the render degrades gracefully on old data. Action = PURSUE(bid)/WATCH/AVOID(pass); **rec-confidence = min(edge, asset confidence)** where asset confidence = role stability (sustained role vs one-week blip) + sample size. The **one piece that waits for Week 1 is the rate signal**: in-season it reads off the last 3–4 weeks' snap/route/target trend; pre-season it falls back to the projection (`rate_basis` states which). The preseason `waivers.json` was migrated to the schema as a worked example.

### 1.8 Low-tier differentiation (sub-$1 scale) — shipped 2026-07-21

The `$1` floor clipped ~60% of the board to an identical value (below replacement → marginal 0 → $1), leaving the bench undifferentiated and the edge flat. Fix: one **continuous position-relative scale** — integer auction **price ≥ $1**, and below the line a **proximity score = `asset ÷ position-replacement`** ($0.05–0.99). This differentiates the bench without resurrecting the old cross-positional pile-up (it's each player's ratio to *his own* replacement) and fully orders `draftRank` board-wide.

Recommendation driver switches at $1: **`$`-edge above** (TARGET/FAIR/FADE), **pick-gap below**. A key calibration finding: a projection-based board is *structurally conservative on late-round upside* (the market drafts bench players on upside the projection can't see), so the sub-$1 pick-gap is one-directional — **no TARGET below $1**, only **FADE on real overpays** (a below-replacement projection the market spends a pick ≤110 on, ≥25 picks earlier than the board), and **ceiling is the late-round lens**. The FAIR badge is suppressed in the bench tier; the drop-down shows the proximity chain + the board-vs-ADP disparity + ceiling. Tunables: `FADE_ADP=110`, `PICK_FADE=−25`.

### 1.9 Historical-usage panel — shipped 2026-07-22

Replaced the placeholder `context` strip (which read "pending" for every player) in the drop-down.

**Role — load-bearing: stats INFORM, they never MOVE value.** Sleeper's projection already prices raw
target share and age, so feeding usage back in as a value multiplier would double-count it. Usage is
therefore (a) transparent evidence, (b) a **role-stability** input to `confidence()`, (c) a
trajectory/**override** signal. It never touches asset value or the edge.

**Three time-scales**, per position — WR/TE: target share, snap share, catch rate, RZ target share, aDOT,
targets/g · RB: touch share, snap share, touches/g, rush att/g, targets/g, RZ carries · QB: snap share,
pass att/g, rush att/g, rush yds · K/DEF: honest "no usage profile". Plus a **multi-year direction**
('23→'25, paired with age — leads on draft day) and a **within-season trajectory** (last 4 games vs
first 4 of '25). Waivers invert the emphasis in-season.

**Team denominators** (target/touch share) come from a **per-week team fingerprint**: every player on a
team shares an identical `(tm_off_snp, tm_def_snp, tm_st_snp)` triple in a given week, so grouping by it
yields team totals with no roster history and stays correct through mid-season trades. Two source
defects are handled explicitly, not absorbed: **fingerprint collisions** (2 teams posting an identical
triple merge into one ~96-player cluster — detected by size, dropped from share denominators) and
**missing snap data** (2025 wk18 carries `tm_off_snp` for only 4 teams). Hence every season stamps both
`g` (games played, the per-game basis) and `share_g` (share-valid weeks). Validated independently:
Chase 2025 target share = 33.8% reproduced by a separate code path, and a clean cluster is
unambiguously one team.

**Everything is sample-gated** — direction needs 2+ seasons at 8+ games and a delta past a per-position
threshold; the within-season split needs 8+ games; the catch-rate arrow needs 16+ targets in each
block. Under-sampled ⇒ an explicit reason, never a fabricated arrow. (Working as intended: Josh Allen's
−1.5 rush att/g is suppressed to "steady" at 19% relative, under the 25% gate.)

**Confidence integration** — `assetConf = min(playing-time risk, disagreement, role stability)`, where
role stability is the usage read folded **worst-of** with the scouting brief's qualitative
`role_stability` (`locked/committee/in_flux`), degrading gracefully when that's absent. Bars are
calibrated to the board's own 2025 distribution; **QB uses snap share, not pass attempts** (an attempts
bar would wrongly flag run-first starters like Lamar Jackson at 23.2 att/g). Result: 63 stable / 100
some-risk / 37 high-risk / 48 n/a, strictly binding for 7 players (e.g. CeeDee Lamb → Med on a
30→27→23% target-share slide). Rec-confidence spread is unchanged (2 High / 16 Med / 30 Low) — it
informs, it doesn't dominate.

**Override hook** ("⚑ revisit his number") is **deliberately one-directional**: falling usage + a
projection asking ≥15% MORE per game than last season's actual (6 of 248 — e.g. Montgomery, touch share
28→19%, projection +16%). The mirror case was measured and **dropped**: it fired on 35 players
(McCaffrey 0.70×, Gibbs 0.84×, Taylor 0.75×) because projections regress *every* career year, and its
most extreme hits were backups where the projection is right and the raw usage read is naive.

### 1.10 Board layout reworked to lead with Boris Chen — 2026-07-23

Per a shift in draft approach, the board is now organized around the **Boris Chen consensus rank as the
primary source** ("if I had nothing else I could draft off this alone"), with the league's own value math
as the supporting read rather than the headline.

- **Default sort = BC rank.** The metric row reads, left→right: **BC · BC−ADP · ADP · $val · edge · ceil.**
  BC anchors the right-aligned cluster and is rendered prominently; the rest support it.
- **BC−ADP** is a new column: `ADP − BC rank` = how many spots the market lets an expert-ranked player
  fall past the consensus. **+ (blue) = value** (falls to you), **− (red) = reach** (goes ahead of
  consensus). Sortable (biggest value first), null when either input is missing.
- **Sticky column headers.** The header row locks to the top on scroll. The toolbar above is already
  sticky at `top:0`, so the header parks at a **JS-measured `--toolbar-h`** (kept live via
  ResizeObserver + resize/load), guarded to ignore a degenerate 0-width layout that would otherwise
  write a garbage offset.
- **Expanded detail** reorganized into three columns — **Value/BC/Ceiling · Availability+Situation+Risk ·
  Historical usage** — with the "How this value is built" decomposition moved to a **full-width block at
  the bottom** (it's the deep-dive, not the first thing you scan).

The underlying valuation math is unchanged; this is presentation only. Sort toggles: BC / BC−ADP / ADP /
$val / edge. Tunables/labels live in `site/draft.js` (`sortFns`, `headerHTML`, `rowHTML`) and
`site/style.css` (`.dhead` sticky, `.dbcdiff`).

## 2. Challenge 2 — `scouting_brief` (public commentary)

### 2.1 What it is

A new, **distinct per-player field** — *not* merged into `adp_commentary`. It is the **evidence layer** (what the world says) that sits beside the **verdict layer** (`adp_commentary` = what you concluded). Keeping them separate preserves "the market thinks X, but I think Y" — the disagreement the gap system exploits.

Content: 1–5 sentences on external sentiment + scheme fit, **sourced + dated** (scheme-fit first, then sentiment, then watch/risk). It **never moves value or the edge** — it feeds the *confidence band* (via `role_stability`) and flags a human revisit (via `override_flag`). See §2.5.

### 2.2 Shape (reconciled — shipped 2026-07-21)

Generated together, from the same sources, in one pass. The signal fields are **evidence about trust and fit**, not a value multiplier:

```json
"scouting_brief": {
  "prose": "Scheme-fit first, then sentiment, then watch/risk. 1–5 sentences.",
  "role_stability": "locked | committee | in_flux",   // will he hold the job/role
  "scheme_fit": "plus | neutral | minus",             // does the scheme suit him
  "override_flag": false,                              // true = a ROLE/SCHEME DELTA the projection likely hasn't caught → a human revisits his number
  "rationale": "one line: the delta, or why null",
  "sources": [{ "label": "The Athletic", "url": "…", "date": "YYYY-MM-DD", "type": "coach|beat|analyst|player" }],
  "as_of": "YYYY-MM-DD"
}
```

- **prose** renders to the user (detail block + hover-tooltip first sentence), scheme-fit first. Sourced + dated, or `null` — never synthesized from memory.
- **role_stability** is the one signal that touches the model: the valuation side's `roleStability()`/`confidence()` folds it **worst-of** with its own quantitative usage read, so a `committee`/`in_flux` role can *widen the band and cap a recommendation* — but it can **never** move the asset value or the edge.
- **scheme_fit** + **override_flag** are descriptive + the human revisit trigger; they do not enter confidence.

### 2.3 Scope (tiered) + sources

- **Deep** for the top ~50 (where drafts are won, where `adp_commentary` already sits).
- **`null`** below the line — honest "not scouted yet," never faked.
- **On-demand deepening**: `/waivers` and `/trade` scout a deeper player when a live decision pulls him in.
- **Source priority**: coach pressers + team beat writers (scheme-fit half — highest weight) → national analysts (sentiment half) → player quotes (color, not signal).

### 2.4 Production model

**Two phases: seed once, then maintain.**

- **Seed (one-time, pre-draft):** a bulk pass with the existing **`deep-research` skill** (fan-out searches → fetch → *adversarially verify* → cited synthesis) over the top ~50, establishing every baseline brief. The adversarial-verify step *is* the sourcing guarantee. Timing floats with the draft date (2026 league not yet renewed) — target ~2–3 weeks out, once ADP stabilizes.
- **Maintain (ongoing):** folded into the daily `nfl-daily-events` routine. **Retrieval-grounded-or-null** is forced (ground rule #2): synthesis happens *only* from sources fetched/harvested at that moment, cited + dated; **no synthesis from model memory**; no usable sources → `null`. Trigger = **event-driven** (re-synthesize when the harvest flags fresh news — the event *is* the citation) **+ a staggered ~7-of-50/day backstop** for standing scheme-fit drift. Cost is bounded (~7–15 grounded syntheses/day, not 50).

### 2.5 How it feeds the model (reconciled — replaces the old `situation.modifier` bridge)

The valuation redesign **deleted the `situation.modifier` value-multiplier**, so scouting no longer moves the number. The old direction/magnitude → ×-table below is retired. Instead:

- **`role_stability` → confidence band.** The valuation side's `roleStability()` maps `locked→none / committee→some / in_flux→high` severity and folds it **worst-of** with its quantitative usage-stability read (falling back to usage alone when the brief is absent). This can widen the uncertainty band and cap rec-confidence — **never** the asset value or edge.
- **`override_flag` → human revisit.** When scouting sees a genuine role/scheme delta the projection likely hasn't caught (e.g. Achane: McDaniel gone + a rushing QB eating checkdowns/goal-line), a **⚑ "revisit projection"** flags it. A human acts; the board never auto-adjusts.
- **`scheme_fit`** is descriptive prose colour only.

**Value independence (load-bearing):** scouting is the *evidence* layer — it informs *trust* (confidence via `role_stability`), prompts *human* revisits (`override_flag`), and *reads* as prose. It is never a value multiplier. That firewall is what the whole 3-layer model's honesty depends on; the old double-count guard is subsumed by simply not letting scouting touch the number at all.

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
