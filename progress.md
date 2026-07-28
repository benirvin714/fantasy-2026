# HBGBs — Progress & Handoff

_Last updated: 2026-07-22. Live dashboard: https://hbgbs-hq.pages.dev/site/ (draft board at `/site/draft.html`)._
_Design of record: [`plans/valuation-and-scouting.md`](plans/valuation-and-scouting.md) — §1 is the **current** valuation algorithm._

## TL;DR — current state

The draft board runs a **3-layer valuation model** (asset → scarcity → auction-$ → market edge → recommendation + confidence), differentiated cleanly from the top of the board to the deepest bench dart. The **historical-usage panel** now backs every drop-down with real share/efficiency evidence, gated trends, and a role-stability input to confidence. The `/waivers` command speaks the same language against the FAAB market (live once the season starts). The **scouting-brief workstream** is forked to its own session and in flight.

## What's built & live

### Valuation redesign — the 3-layer model (replaces the old VORP-as-value board)
- **① Asset value** = `rate` (Sleeper proj ÷ 17) × **median games** (light playing-time model), floored at 0. "What he produces," position-agnostic, descriptive — not the sort.
- **Scarcity → draft-$**: integer **auction price ≥ $1** above the replacement line; a **sub-$1 proximity score** (`asset ÷ position-replacement`, $0.05–0.99) below it — position-relative, so the bench differentiates without the old cross-positional pile-up. `draftRank` is fully ordered board-wide.
- **③ Market edge** = your draft-$ vs the market-$ at the player's ADP slot → **TARGET / FAIR / FADE**. Above $1 the driver is the $-edge (±$4); below $1 it's the board-vs-ADP **pick-gap** — and because a projection-based board is structurally low on late-round upside, there's **no TARGET below $1**, only **FADE on real overpays**, with **ceiling as the late-round lens**.
- **② Rec-confidence** = `min(edge strength, asset confidence)`, shown as `●●●/●●○/●○○` dots + a cap reason. Asset confidence = `min(playing-time risk, expert/consensus disagreement)`.
- **Ceiling** (spike-week rate, from Sleeper weekly 2023–25) is a **separate display attribute**, never a value input. **Availability** is a light median-games input + the Phase-B uncertainty band (no longer a value multiplier). A **scarcity (replacement-basis) knob** slides starters↔rostered.
- **Board leads with Boris Chen** (2026-07-23 rework): default sort = BC rank, and the columns read BC · **BC−ADP** (spots the market lets him fall past consensus; +blue value / −red reach) · ADP · $val · edge · ceil — the at-a-glance decision row. Column headers **lock to the top on scroll** (sticky beneath the sticky toolbar, offset measured live). Sort toggles: BC / BC−ADP / ADP / $val / edge.
- **Drop-down is prioritized, not exhaustive** (2026-07-27): it opens on the four reads that drive a pick — **Why here** and **Scouting** full-width, then a three-column row of **Historical usage · Trends · Boris Chen** — and puts the rest (Value & $ engine, Ceiling, Availability, Situation & risk, "How this value is built") behind compact disclosure buttons, all collapsed by default. **1577px → 523px** on open, about a third of the original height. Nothing was removed and no black box: every field is one click away, section state is board-wide and survives repaints, and it resets compact on reload. K/DEF/rookies render no Trends column and let usage span the gap.
- **Tiers read as slabs** (2026-07-28): every tiered row carries its Boris Chen tier as a 5px left band in **every sort and view**, and a **full-row wash on the BC sort only** — the wash is a grouping device, so it appears only where the tiers run contiguous (elsewhere it's confetti; the footer legend swaps to match). A color rule caps each block on the BC sort (20 of them; the rule self-disables where tiers interleave, as they do among K/DEF at the tail). Hues step by the **golden angle**, so adjacent tiers measure **ΔE 66–167** on the band against a just-noticeable threshold of ~2.3; a period-3 lightness step pushes the hue cycle's near-repeat out past the end of the board and adds a colorblind-safe second axis. Drafted rows drop the wash and keep the band.

### Historical-usage panel (shipped 2026-07-22)
- Replaced the placeholder `context` strip (it read "pending" for every player) with a real per-position usage panel: **recent-season shares/efficiency + a multi-year direction + a within-season trajectory**, all sample-gated. Full spec + calibration: [`plans/valuation-and-scouting.md`](plans/valuation-and-scouting.md) §1.9.
- **Stats inform, they never move value** — the projection already prices raw share and age, so usage feeds only (a) evidence, (b) the **role-stability** leg of `confidence()` (worst-of with the scouting brief's `role_stability`), (c) a one-directional **"⚑ revisit his number"** override flag. Asset value and the edge are untouched.
- Team-level denominators come from a **per-week team fingerprint** (`tm_off_snp|tm_def_snp|tm_st_snp` is identical across a team's players), so no historical roster data is needed and mid-season trades stay correct. Collided clusters and 2025-wk18's missing snap data are detected and excluded, which is why each season stamps both `g` and `share_g`.

### Data integrity
- **`situation.facts` now match players by explicit `players[]` tags** on each `nfl-events.json` item (not surname substrings). Fixed the "Bijan showing Egbuka/Zac-Robinson news" class of bug across the whole board. The `nfl-daily-events` scheduled routine emits the tag going forward; existing events were backfilled.

### Waivers
- `/waivers` applies the same 3-layer model against the **FAAB market** (`data/faab-market.json` bands + rival `price_to_beat` + pressure): asset → worth → edge → PURSUE/WATCH/AVOID + rec-confidence. `waivers.json` schema + the dashboard waiver panel carry the new fields (graceful fallback for old data); the preseason board is migrated as a worked example.

## Designed & confirmed, NOT yet built

- **Scouting-brief workstream** — forked to its own session via [`plans/scouting-fork-prompt.md`](plans/scouting-fork-prompt.md). `scouting_brief` = prose (analyst/coach/player sentiment + scheme fit) + `{role_stability, scheme_fit, override_flag}`. `role_stability` feeds confidence (worst-of with the historical-stats read); scheme_fit is descriptive + override-trigger. Never moves value. Deep-research seed over the top ~50, retrieval-grounded-or-null.

## Next steps (rough priority)

1. **Finish the scouting fork** — in flight in its own session (`plans/scouting-fork-prompt.md`). It produces `scouting_brief.role_stability`, which `confidence()` **already consumes** (worst-of with the usage read) and degrades gracefully while it's absent — no further valuation-side work needed when it lands.
2. **Waiver-side usage lens (in-season, Week 1+)**: the same usage pipeline exists at build time; `/waivers` should read the **recent** weeks (waivers lead with the current trend, the inverse of the draft view's multi-year lead) — plus fold event-driven scouting synthesis into `nfl-daily-events`.
3. **At 2026 league renewal** — **re-checked 2026-07-22: still not created** (`get_user_leagues` returned empty). When it exists: update the league ID in **`CLAUDE.md`** and **`site/config.js`**, re-verify settings, update `$leagueId` in `scripts/fetch-league-data.ps1`, and refresh `data/raw/`.
4. **Optional**: `context.*` (contract year, draft capital, win total, playoff SOS) is still `null` in the board and **no longer rendered anywhere** — the usage panel replaced the strip that displayed it. Either fill it or drop the field.

## Key files & tunables

- **`site/draft.js`** — the whole client-side valuation engine (asset/scarcity/$/edge/confidence + rendering). Tunable constants at top: `EDGE_TARGET/FADE=±4`, `FADE_ADP=110`, `PICK_FADE=−25`, `BC_DIVERGE=15`, auction `BUDGET`, `STARTER_RANK`/`ROSTERED_RANK`.
- **`scripts/build-draft-board.mjs`** — build-time data layer (projections re-scored to league format, ceiling metric, **historical usage + gated trends**, availability, `players[]`-tag matching). Regenerate: `node scripts/build-draft-board.mjs`. Usage gates are constants near the usage block: `MIN_SEASON_G`, `TREND_BLOCK`, `DIR_METRIC`, `TREND_METRIC`, `CR_MIN_TGT`, `MERGED_CLUSTER`.
- **`.claude/commands/waivers.md`** — the in-season waiver command.
- **`plans/valuation-and-scouting.md`** — design of record (§1 valuation is current; §2 scouting; §1.8 low-tier).
- **`~/.claude/scheduled-tasks/nfl-daily-events/SKILL.md`** — the daily news routine (outside the repo).

## Watch-outs

- Publishing = commit + push to `main` (Cloudflare auto-deploys `site/` + `data/site/`). The `nfl-daily-events` routine also commits daily, so `git pull --rebase` before pushing if needed.
- The valuation is **single-source (Sleeper projection)** by design; divergence from Boris Chen is surfaced as *low confidence*, not blended away. That's why so few edges are high-confidence — it's honest, not broken.
