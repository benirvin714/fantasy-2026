# HBGBs — Progress & Handoff

_Last updated: 2026-07-22. Live dashboard: https://hbgbs-hq.pages.dev/site/ (draft board at `/site/draft.html`)._
_Design of record: [`plans/valuation-and-scouting.md`](plans/valuation-and-scouting.md) — §1 is the **current** valuation algorithm._

## TL;DR — current state

The draft board runs a **3-layer valuation model** (asset → scarcity → auction-$ → market edge → recommendation + confidence), differentiated cleanly from the top of the board to the deepest bench dart. The `/waivers` command speaks the same language against the FAAB market (live once the season starts). Two pieces are **designed and confirmed but not yet built**: the historical-stats panel and the scouting-brief workstream (the latter forked to its own session).

## What's built & live

### Valuation redesign — the 3-layer model (replaces the old VORP-as-value board)
- **① Asset value** = `rate` (Sleeper proj ÷ 17) × **median games** (light playing-time model), floored at 0. "What he produces," position-agnostic, descriptive — not the sort.
- **Scarcity → draft-$**: integer **auction price ≥ $1** above the replacement line; a **sub-$1 proximity score** (`asset ÷ position-replacement`, $0.05–0.99) below it — position-relative, so the bench differentiates without the old cross-positional pile-up. `draftRank` is fully ordered board-wide.
- **③ Market edge** = your draft-$ vs the market-$ at the player's ADP slot → **TARGET / FAIR / FADE**. Above $1 the driver is the $-edge (±$4); below $1 it's the board-vs-ADP **pick-gap** — and because a projection-based board is structurally low on late-round upside, there's **no TARGET below $1**, only **FADE on real overpays**, with **ceiling as the late-round lens**.
- **② Rec-confidence** = `min(edge strength, asset confidence)`, shown as `●●●/●●○/●○○` dots + a cap reason. Asset confidence = `min(playing-time risk, expert/consensus disagreement)`.
- **Ceiling** (spike-week rate, from Sleeper weekly 2023–25) is a **separate display attribute**, never a value input. **Availability** is a light median-games input + the Phase-B uncertainty band (no longer a value multiplier). A **scarcity (replacement-basis) knob** slides starters↔rostered.
- Default sort = draft-$ (toggles: edge / ADP / BC). Every player's drop-down shows the full decomposition + justification — no black box.

### Data integrity
- **`situation.facts` now match players by explicit `players[]` tags** on each `nfl-events.json` item (not surname substrings). Fixed the "Bijan showing Egbuka/Zac-Robinson news" class of bug across the whole board. The `nfl-daily-events` scheduled routine emits the tag going forward; existing events were backfilled.

### Waivers
- `/waivers` applies the same 3-layer model against the **FAAB market** (`data/faab-market.json` bands + rival `price_to_beat` + pressure): asset → worth → edge → PURSUE/WATCH/AVOID + rec-confidence. `waivers.json` schema + the dashboard waiver panel carry the new fields (graceful fallback for old data); the preseason board is migrated as a worked example.

## Designed & confirmed, NOT yet built

- **Historical-stats panel** (replaces the placeholder `context` strip in the drop-down): target/snap/touch share, catch rate, aDOT, red-zone usage + a **multi-year direction** and a **within-season trajectory**, all sample-gated (default "steady," no fake trends). Role: **evidence + confidence + trajectory/override — never moves value** (the projection already prices raw share/age). Feeds confidence via the shared "role-stability" slot + an override hook. **Draft leans multi-year, waivers lean the recent trend.** Build touches `build-draft-board.mjs` (new stat computation — needs team-level totals) + `draft.js`. Full spec: `plans/valuation-and-scouting.md` (added during the grill) — implement next.
- **Scouting-brief workstream** — forked to its own session via [`plans/scouting-fork-prompt.md`](plans/scouting-fork-prompt.md). `scouting_brief` = prose (analyst/coach/player sentiment + scheme fit) + `{role_stability, scheme_fit, override_flag}`. `role_stability` feeds confidence (worst-of with the historical-stats read); scheme_fit is descriptive + override-trigger. Never moves value. Deep-research seed over the top ~50, retrieval-grounded-or-null.

## Next steps (rough priority)

1. **Build the historical-stats panel (B)** — the confirmed, self-contained next build.
2. **Run the scouting fork** — hand `plans/scouting-fork-prompt.md` to a fresh session (coordinate: both it and the valuation session edit `draft.js`/`build-draft-board.mjs`).
3. **In-season (Week 1+)**: wire the waiver **recent-snap-trend rate** into `/waivers`, and fold event-driven scouting synthesis into the `nfl-daily-events` routine.
4. **At 2026 league renewal** (not created as of last check): run `get_user_leagues` (ThatWasButtery, 2026), update the league ID in **`CLAUDE.md`** and **`site/config.js`**, re-verify settings, and update `$leagueId` in `scripts/fetch-league-data.ps1`.

## Key files & tunables

- **`site/draft.js`** — the whole client-side valuation engine (asset/scarcity/$/edge/confidence + rendering). Tunable constants at top: `EDGE_TARGET/FADE=±4`, `FADE_ADP=110`, `PICK_FADE=−25`, `BC_DIVERGE=15`, auction `BUDGET`, `STARTER_RANK`/`ROSTERED_RANK`.
- **`scripts/build-draft-board.mjs`** — build-time data layer (projections re-scored to league format, ceiling metric, availability, `players[]`-tag matching). Regenerate: `node scripts/build-draft-board.mjs`.
- **`.claude/commands/waivers.md`** — the in-season waiver command.
- **`plans/valuation-and-scouting.md`** — design of record (§1 valuation is current; §2 scouting; §1.8 low-tier).
- **`~/.claude/scheduled-tasks/nfl-daily-events/SKILL.md`** — the daily news routine (outside the repo).

## Watch-outs

- Publishing = commit + push to `main` (Cloudflare auto-deploys `site/` + `data/site/`). The `nfl-daily-events` routine also commits daily, so `git pull --rebase` before pushing if needed.
- The valuation is **single-source (Sleeper projection)** by design; divergence from Boris Chen is surfaced as *low confidence*, not blended away. That's why so few edges are high-confidence — it's honest, not broken.
