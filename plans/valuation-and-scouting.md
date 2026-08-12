# Plan — Player Valuation & Scouting Briefs

> Design doc for two dashboard upgrades, settled via a full grilling pass on 2026-07-20.
> Status (2026-08-09): **Valuation redesigned 2026-07-20 (§1, 3-layer model); Phases A ($-engine + edge) and B (uncertainty band + rec-confidence) both shipped. Scouting (§2) shipped too** — `/scout` has covered the whole 200-player skill pool, and `role_stability` is feeding `confidence()`. Build sequence in §6.
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
  the bottom** (it's the deep-dive, not the first thing you scan). *(Superseded by §1.11.)*

The underlying valuation math is unchanged; this is presentation only. Sort toggles: BC / BC−ADP / ADP /
$val / edge. Tunables/labels live in `site/draft.js` (`sortFns`, `headerHTML`, `rowHTML`) and
`site/style.css` (`.dhead` sticky, `.dbcdiff`).

### 1.11 Drop-down prioritized, depth put behind disclosures — 2026-07-27

The expanded row had grown to everything-at-once. Reordered around the four reads that actually drive a
pick, with the rest one click away.

- **Always visible, in priority order:** **Why here** (`adp_commentary`) and **Scouting** full-width, then
  a three-column row: **Historical usage** (the season table) · **Trends** (multi-year direction,
  within-season trajectory, catch-rate arrow, last-season actual vs projection, role stability) ·
  **Boris Chen (fftiers)**. BC moved out of the shared $-engine column into its own block — it's the
  primary board, so it shouldn't be buried beside internals. Splitting trends out of the usage block
  reclaimed the dead space left by the ~310px-wide season table.
- **No-trends positions stay full-bleed:** K/DEF and rookies have no trend data, so no Trends column is
  rendered at all and the usage block spans the vacated track (`.dstats-wide`, wide viewports only)
  rather than leaving the row a third empty.
- The repeated "never moves value" caption moved to the column label's tooltip — identical boilerplate
  on every player, and it cost ~5 lines of height once the column narrowed. The on-screen label still
  says "evidence only", so the honesty contract holds.
- **Behind disclosure buttons** (all collapsed on open): Value & $ engine · Ceiling · Availability &
  injury · Situation & risk flags · How this value is built. Closed buttons sit in one compact wrapping
  row; the opened one takes the full row and drops its body beneath, so only one block of depth is on
  screen at a time.
- **State is per-SECTION, not per-player** (`openSect`), so a section you open follows you player to
  player and survives any repaint (take / sort / filter). It resets compact on reload — the default is
  the whole point.
- Measured effect: a top-player drop-down went **1577px → 769px** (disclosures) **→ 523px** (three-column
  row) — about a third of the original height. Nothing was removed; every field is still one click away,
  and the honest-`null` rendering is unchanged.

Files: `statsHTML` / `detailHTML` / `bcHTML` / `section()` in `site/draft.js`; `.dsects` / `.dsect*` /
`.dstats-wide` in `site/style.css`.

### 1.12 Tier blocks — full-row color, golden-angle hues — 2026-08-09

The first pass at tier color (a 3px stripe + a faint pill, 47° hue step) was deliberately quiet and read
as too quiet: neighbouring tiers sat a shade apart and the grouping didn't register. Rebuilt so a Boris
Chen tier reads as a **slab**, not a hint.

- **Full-row wash + a 5px left band**, on two different scopes. The near-solid band (plus the T-pill)
  carries each row's tier in **every sort and view** — a tier-2 player buried in an ADP-sorted list still
  shows his color. The background wash (alpha 0.17) is a **grouping** device, so it only appears where
  the tiers actually run contiguous: the **BC sort on the value board** (`washOn()`). Everywhere else the
  tiers interleave and a wash reads as confetti, not grouping. The board footer swaps its legend line to
  match. Untiered players (outside the fftiers top-200) render transparent but keep the same 5px inset so
  columns stay aligned with the tiered rows.
- **Hue steps by the golden angle (137.5°)**, not a small fixed step. Consecutive tiers land on opposite
  sides of the wheel. Measured on the composited DOM colors: adjacent tiers are **ΔE 66–167** on the band
  (ΔE ~2.3 is the just-noticeable threshold) and ΔE 11–27 on the wash. The old 47° step also wrapped to a
  near-repeat every 8 tiers.
- **Lightness carries two corrections.** A per-hue compensation (HSL blue looks far darker than HSL
  yellow at equal L) keeps the wash the same visual weight tier to tier; then a **period-3 step** rides on
  top, so the 8-tier hue near-repeat only becomes a true repeat at 24 tiers — past the end of the board.
  It also gives every neighbour a second, non-hue axis of difference for a colorblind read. Worst
  8-apart band pair still measures ΔE 13.
- **Block-capping rules** (`tierStarts()`): a row gets a rule in its tier's color when it opens a run of
  2+ same-tier rows *and* that tier hasn't appeared earlier. Both tests are **local**, which is what makes
  it survive the real data — under the BC sort tiers 1–19 are perfectly contiguous and each gets its rule
  (20 total), while the tail interleaves (K and DEF carry their own tier scales and land among deep skill
  players) and correctly gets none. A single global "is this list tier-ordered?" test threw away all 19
  clean rules to punish that tail. Under every other sort the runs are length 1 and 0–2 rules survive.
- **Drafted rows drop the wash but keep the band** — the row is spent, and the unwashed gap is itself a
  signal, while the band keeps the block visually unbroken. The expanded detail sits on its own opaque
  `--surface-2`, so the wash never bleeds into a wall of text.

Files: `tierColor()` / `tierStarts()` / `washOn()` / `rowHTML` in `site/draft.js`; `.drow` custom-property block,
`.tier-start`, `.drow:not(.dhead):hover`, `.drow.taken` in `site/style.css`.

### 1.13 Target rail — the on-the-clock shortlist — 2026-08-09

A sticky column beside the board holding the players you actually want, answering one question during
a draft: **of my targets, who goes next, and do I have time?**

- **Add/remove** with a ☆/★ button in its own column on every row (a second, deliberately quieter
  control beside the drafted ✓ — starring is cheap and reversible, marking drafted is the consequential
  one). Also removable with `×` from the rail itself. State in `localStorage` under
  `hq-draft-2026-targets`.
- **Cleared when he's picked** by **filtering, not deleting**: the stored set keeps every star, and the
  rail renders only the ones not marked drafted. That's what makes the clearing survive a mis-click —
  un-mark him and he's back in the list, in place. Drafted targets aren't silently swallowed either;
  a `N gone: <s>name</s>` line stays at the bottom, because during a draft "who sniped my guy" is
  information.
- **Distance is measured from a live pick counter**, `taken.size + 1`. The drafted button is already
  the thing you press on every pick, so the counter costs no extra bookkeeping — but it is only as
  good as those marks, so the rail **states the pick number it counts from** (`pick #33 · round 4 ·
  counting 32 drafted marks`) instead of hiding the assumption inside a number.
- **Four away-states**, loudest first: `N past ADP` (accent green — the market is letting him fall,
  the best news on the board), `on the clock` (amber), `N picks · R.R rd` inside one round (amber),
  anything further out stays quiet. No ADP renders an honest "no ADP", never a fabricated distance.
- **Sorted by ADP ascending**, so the top of the rail is whoever the market takes first.
- **Bye column**, right-aligned so it reads as a column across rows. `p.bye` is **derived at build
  time from the NFL schedule**, not hand-kept: Sleeper's player objects carry no bye week, so
  `byeWeeks()` in `build-draft-board.mjs` pulls `api.sleeper.app/schedule/nfl/regular/<season>` and
  takes each team's bye as the week it appears in no game. It **validates before shipping** (32 teams,
  exactly one bye each) and returns `{}` on any failure, so every player gets `bye: null` and the
  column says "bye –" rather than the board carrying a plausible-looking wrong number. 2026 came
  back 32/32, weeks 5–14.
  - **Collisions are called out**: when two or more *live* targets share a week the chip turns amber
    and names the others. That's the reason a shortlist wants a bye column at all. Counted over live
    targets only, so drafting one recomputes the rest and un-drafting brings the warning back.
- **The board carries the same column** (last cell of the metric cluster, after `ceil` — it's a
  roster-construction attribute, not a value read, so it doesn't displace BC at the head). Its
  tooltip escalates through the same three states as the rail, naming which targets share the week.
  - **But it takes no color, and that's measured.** A collision highlight was built here first and
    cut: a bye belongs to the TEAM, so "two targets already off this week" is true of every player on
    the 2–6 teams sharing it — with two week-11 targets starred it lit **44 of 248 rows**. That's the
    same wallpaper bar `REVISIT_UP` was calibrated against. The rail keeps its amber because there
    it's 2 rows out of ~8, where a shared week really is the exception.
  - The 8-cell cluster pushed half the rows onto a third wrapped line at 375px (121px → 149px), so
    the mobile `min-width`s (tuned for a roomier desktop cluster) were trimmed. Eight cells now fit
    the two lines seven used, landing at **115px, shorter than before the column existed**, with no
    cell narrower than its longest rendered string.
- **The snake read (draft slot).** Pick your seat from the rail's `draft slot` selector and it lists
  the picks you still hold and answers, per target, whether he reaches one. Geometry is **measured,
  not assumed**: `draft-meta-2023..25.json` are identical (10 teams, 15 rounds, snake,
  `reversal_round: 0`), and `pickNoFor()` is validated against `draft-picks-2025.json` — slot 3 held
  #3, #18, #23, #38, #43, which is exactly what it emits. Reversal rounds are **deliberately not
  implemented**; if the league ever turns one on, a silently-wrong pick number would be worse than
  none, so re-check `draft-meta` at renewal.
  - Three buckets against `ADP_SLACK = 5` (half a round): `lasts to #38` / `coin flip #38` /
    `gone by #38`. The slack is a **stated rule of thumb**, and the tooltip says so. The board carries
    no ADP variance, and Boris Chen's expert rank spread is a different quantity that must not be
    borrowed as one, so anything finer would be invented precision.
  - **The question shifts by one turn when the pick is yours.** At your own pick "does he survive to
    my next pick" is moot, so the chips pivot to the wheel: `back at #43` / `coin flip #43` /
    `now or never`. The clock line flips to a `YOU'RE UP` chip at the same moment.
  - Two honest special cases: a player who has **already outlasted his ADP** gets `5 to #43` with a
    tooltip saying ADP has been falsified and the wait is a judgment call, not `gone by` (he's
    demonstrably not gone); and at your final pick the chip reads `your last pick`.
  - With no slot set the rail **makes no claim at all** rather than guessing a seat.
- **Independent of the board's own filters** — position filter, sort, view, and hide-drafted don't
  touch it. It's your list, not a view of the board. It does inherit each player's Boris Chen tier
  band, so a target's color matches his row.
- Layout: `.draft-cols` is one column by default with the rail ordered **first** (below a 250-row
  board nobody would scroll to it); at ≥1040px it becomes `1fr / 292px` and the rail goes sticky under
  the measured toolbar height with internal scroll. `.draft-main` widened 1100 → 1440px, which leaves
  the board column at ~1069px, so row density is unchanged.

Files: `paintTargets()` / `survivalHTML()` / `pickNoFor()` / `myPicksFrom()` / `ROUNDS` / `ADP_SLACK` /
the `star` + `untarget` + `draft-slot` handlers / `TGT_KEY` in `site/draft.js`; `byeWeeks()` and the
`bye:` field in `scripts/build-draft-board.mjs`; the
`.draft-cols` grid, `.tgt*` block, `.drow .star`, and the widened `.drow` grid in `site/style.css`;
the `<aside class="panel targets">` in `site/draft.html`. Note `section.panel, aside.panel` — the
original element+class selector wouldn't have matched an `<aside>` at all.

### 1.14 Player search — toolbar combobox — 2026-08-09

Sits right of the scarcity knob. Type a name, the list filters live, picking a match lands you on
that player with his drop-down already open, and every match carries a star.

- **Ranking**: any word starting with the query is one tier, broken by draft-value rank; mid-word
  hits sort below. Ranking first names above surnames was tried and cut — it put Chase Brown and
  Chase McLaughlin over Ja'Marr Chase on "chase", which is consistent and obviously not the intent.
  Normalization keeps word boundaries (`Ja'Marr Chase` → `jamarr chase`), so both `chase` and
  `jamarr` hit and `ja'marr` and `jamarr` are the same query. Two-character minimum, 8 results.
- **Jumping relaxes what hides him.** "Take me to him" is a promise, so the position filter,
  hide-drafted and hide-risk-flagged step aside as needed, and a note under the field **says which
  control moved** — a filter silently resetting itself is worse than the filter being on. The row
  expands and takes a static outline (`.drow.found`, dropped after 2.6s) so it reads the same under
  `prefers-reduced-motion`, which kills every animation on this page.
- **Scroll is smooth only for short hops.** A jump across the tiers view is ~10,500px and takes ~2s
  smooth, which is a delay with a blur in it and long enough that the landing outline can expire
  before you arrive. Past two viewport heights it goes instant: 2s → 180ms measured.
  `scroll-margin-top` on `.drow` is `--toolbar-h + 46px`, so the row clears the sticky column header
  rather than parking under it.
- **The star does not navigate or close the list**, since you're often adding two or three names off
  one search. `e.stopPropagation()` in that branch is load-bearing, not defensive: re-rendering the
  list detaches the clicked button, so the document's outside-click handler would walk an orphaned
  node, get `null` from `closest(".srchwrap")`, and read its own click as a click outside.
- Full combobox keyboard: ↓/↑ cycle, Enter selects, Escape clears. `role="combobox"` +
  `aria-expanded` + `aria-activedescendant`; the star is a **sibling** of `role="option"`, not a
  child, with a `role="presentation"` wrapper so the listbox still owns its options directly.
- Closing is its own state, not "zero results" — after you pick someone the input holds his full
  name, and a shared path would pop the list back open saying "No player matches that" about the
  name you just chose.

Files: `searchFor()` / `renderSearch()` / `closeSearch()` / `gotoPlayer()` / `setGroup()` / `normS`
in `site/draft.js`; `.srch*` block, `.drow.found`, `.drow { scroll-margin-top }` in `site/style.css`;
`.srchwrap` in `site/draft.html`.

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

### 2.7 Pre-draft sourcing bar for the draftable core, ADP 50-180 (2026-08-11)

A quality audit of the 100-200 ADP range (the "informed and fluid" late rounds) found coverage complete and briefs fresh, but **~85% rested on national-analyst blurbs with no beat writer or coach quote** (7/51 in the 100-150 band and 6/39 in 150-200 had any beat/coach source; every brief sampled was exactly two `analyst` sources). That inverts §2.3's source priority exactly where role reads are hardest. Three changes close it, none of which touch value:

- **Beat-first bar (ADP ≥ 50).** `/scout` and the daily SKILL now require at least one beat, coach, or camp-report source for a late brief, or an explicit sentiment-only note in the rationale. Analyst blurbs are secondary, never the basis. A late player with no findable beat source is marked sentiment-only, not dressed up.
- **`thin_source` re-scout trigger.** `validate-scouting.mjs` flags an in-range brief (ADP 50-180) whose sources include no coach/beat type and whose `as_of` predates the bar's adoption date (`--beat-bar-since`, default 2026-08-11). It is the fourth re-scout reason after news / adp_drift / stale_backstop, **demoted below all three** in the drip so a hot news item is never starved, with **one drip slot per run reserved** (`--drip-thin`, default 1) so the sweep still makes steady automated progress. It self-terminates: one upgraded attempt advances `as_of` past the bar date and the player never re-triggers, even where beat coverage genuinely does not exist. The daily drip runs `--drip-rank 180` in the pre-draft window so the back half of the range is reachable.
- **Path-to-role convention + QUALITY metric.** In-range prose leads with the trigger (whose snaps, what opens the role, what he becomes) rather than a bare committee label. `validate-scouting.mjs` prints a `QUALITY` line counting analyst-only briefs across ADP 50-200 so the upgrade is measurable, not just coverage %. The 100-200 band ran first (77 briefs upgraded, 0 dead sources); the sweep then extended down through 50-100 (rounds 5-10) with `THIN_MIN_ADP` lowered to 50.

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
