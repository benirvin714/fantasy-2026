# Handoff — Historical-stats panel + 2026 league renewal (fresh session)

You're picking up **two next-steps** for the HBGBs fantasy dashboard: **(1)** build the historical-stats
panel, and **(4)** the 2026 league-renewal maintenance. A parallel **"Player Data" session** owns the
scouting brief (`plans/scouting-fork-prompt.md`) — see the coordination note at the bottom; you two share
files.

## Orient first
- Project: `C:\Users\ben-i\OneDrive\Documents\AI\Fantasy 2026`. **Read `CLAUDE.md`** (hard rules: read-only
  Sleeper; no stale analysis — grounded in live sources or flagged; everything in the league's exact format).
- **Read `progress.md`** and **`plans/valuation-and-scouting.md`** §1 (the current 3-layer valuation model).
- What's live: the draft board runs asset → scarcity → auction-$ → edge → recommendation + rec-confidence,
  all client-side in `site/draft.js`; `confidence()` builds the uncertainty band from playing-time risk +
  expert/consensus disagreement. Its **playing-time/role-risk** component is your integration socket.

---

## TASK 1 — Historical-stats panel

**The design was fully grilled and confirmed. Do NOT re-litigate it; build it.**

**Role (load-bearing): stats INFORM, they never MOVE value.** Sleeper's projection already prices raw
target share and age (verified: Chase 32.6% share → proj 257; Evans age-32 decline → proj 173), so feeding
those back in as a value multiplier is a double-count. Stats become: **transparent evidence** + a
**confidence input** + a **trajectory/override** signal.

**Replaces the placeholder `context` strip** in the drop-down (currently all "pending" — a strict upgrade).
Same data also informs the waiver view.

**Panel — per position, three time-scales (all computable from Sleeper season 2023–25 + weekly):**
| Position | Recent-season (2025) | Multi-year direction (’23→’25) | Within-season trend (late vs early ’25) |
|---|---|---|---|
| WR / TE | target share, catch rate, snap share, red-zone tgt share, aDOT | target-share ↑/flat/↓ | targets/g + catch-rate arrow |
| RB | snap share, touch share (carries+tgts), rush att/g, targets/g, goal-line carries | touch-share ↑/flat/↓ | touches/g arrow |
| QB | rush att/g + rush yds (konami), pass att/g | rush-rate ↑/flat/↓ | rush att/g arrow |
| K / DEF | — none | — | — |

Stat keys available: `rec_tgt`, `off_snp` + `tm_off_snp` (→ snap share), `rec_air_yd` (→ aDOT), `rec_rz_tgt`,
`rec_drop`, `rec_ypt`/`rec_ypr`. **Target share needs team-level totals** (sum `rec_tgt` across each team's
players per season — this is the real build cost).

**Trajectory is GATED** (kills the James-Cook-0.92→0.44 mirage): volume floors + significance thresholds +
sample stamps, **defaulting to "steady," never a fake arrow**. Within-season = last 4 games vs first 4;
catch-rate trend only when target volume clears a floor; RB = touches (not catch rate). Multi-year = the
position's share metric across ’23–’25, paired with age.

**Context weighting:** the **draft view leads with multi-year** (season bet) and its confidence/override
lean on it; the **waiver view leads with the current recent trend**. Keep the draft's within-season lens
visible (last season's late trajectory = the sophomore-breakout signal) but *below* the multi-year baseline.

**Confidence integration (the ONE place stats touch the model):** usage stability feeds the **"role-stability"
slot** in `confidence()` — stable multi-year high usage / sustained recent role → tightens; volatile/unproven
→ widens — folded **worst-of** with the scouting brief's qualitative `role_stability` (from `scouting_brief`
in `data/draft-research.json`, if present; **fall back gracefully to usage-stability alone when it's absent**).
Plus an **override hook**: when the context-appropriate trend clearly contradicts the projection, raise a
"revisit his number" flag. **`scheme_fit`/raw share never touch confidence or value.**

**Pipeline:** compute at **build time** in `scripts/build-draft-board.mjs` (season + weekly → per-player
share/efficiency/trend, stored in `draft-board.json`); render in `site/draft.js` (replace the `context`
strip). The `/waivers` command references current recent weeks in-season (later).

**Verify** in-browser (serve on :8642, `/site/draft.html`): the panel shows real stats + gated trends,
confidence shifts sensibly for a stable-vs-volatile usage profile, honest "no data" for rookies/K/DEF,
no console errors. Rebuild the board (`node scripts/build-draft-board.mjs`) and bump the `?v=` cache-busters.

---

## TASK 4 — 2026 league renewal (do when the league is created)

The 2026 HBGBs league was **not created** as of last check. At the first session after renewal:
1. `get_user_leagues` for username `ThatWasButtery`, season 2026 → get the new league ID.
2. Update the league ID in **`CLAUDE.md`** and **`site/config.js`** (both).
3. Re-verify scoring/roster settings against the new league object (they've been stable for years, but confirm).
4. Update `$leagueId` in `scripts/fetch-league-data.ps1`, and refresh `data/raw/`.

---

## Constraints & coordination
- **Value independence** is the load-bearing rule of the whole redesign — stats inform confidence + flag
  overrides; they never move the asset value or the edge.
- **Honesty**: sourced/computed or "no data," never a guess or a fabricated trend.
- **Shared files with the Player Data (scouting) session** — you both edit `scripts/build-draft-board.mjs`
  and `site/draft.js` (its `detailHTML`). **You own `confidence()`**; scouting only *produces* the
  `role_stability` data (in `scouting_brief`), which you read. Keep edits additive/localized, `git pull
  --rebase` before pushing, and ideally don't run both sessions editing the same file simultaneously.
- **Publish**: commit + push to `main` (Cloudflare auto-deploys). Trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
