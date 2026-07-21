# Fork prompt — Scouting workstream (paste into a fresh session)

You own the **scouting + information-gathering workstream** for the HBGBs fantasy-football
dashboard. A parallel session owns **valuation** (the draft/waiver boards). Build the
`scouting_brief` feature end-to-end. Stay in your lane (constraints at the bottom).

## Orient first
- Project: `C:\Users\ben-i\OneDrive\Documents\AI\Fantasy 2026`. **Read `CLAUDE.md`** (hard rules:
  read-only on Sleeper; **no stale player analysis** — every claim grounded in live web sources or
  flagged; everything translated to the league's exact format).
- **Read `plans/valuation-and-scouting.md` §2** for the scouting design — **BUT §2.2 and §2.5 are
  SUPERSEDED**: they describe a `situation.modifier` value-multiplier that the valuation redesign
  deleted. The reconciled design below is authoritative. **Update §2 to match** as part of your work.
- What already exists: valuation is a 3-layer model (asset → scarcity → auction **draft-$** → market
  **edge** → recommendation + **rec-confidence**), all in `site/draft.js`. Its `confidence()` builds
  an uncertainty band from playing-time risk + expert/consensus disagreement — that's your one
  integration socket. `data/draft-research.json` already holds `adp_commentary` per player id (your
  sibling field; follow its overlay pattern). `data/site/nfl-events.json` is a curated, `players[]`-tagged
  news feed (produced by the `nfl-daily-events` scheduled task).

## What a `scouting_brief` is
The **evidence layer** — *what the world says* about a player + how he fits his team's scheme this
season — sitting **beside** `adp_commentary` (*your verdict*). 1–5 sentences, **sourced + dated**.

## Deliverable (do all four)

**1. Seed the data.** Use the **`deep-research` skill** to fan out over the **top ~50 players** by
draft value / ADP (read them from `data/site/draft-board.json` — it has id, name, draftDollar/adp).
For each, produce a brief: **what analysts, coaches, and players are saying + scheme fit.** Prose is
**scheme-fit first, then sentiment, then watch/risk.**
- **Retrieval-grounded-or-null**: synthesize ONLY from sources you fetch *this session*. No training
  memory (it's stale). No usable source → `null` (honest "not scouted yet"), never faked.
- **Source weight**: coach pressers + team beat writers (scheme fit — highest) → national analysts
  (sentiment) → player quotes (color).

**2. Emit the structured signal** with the prose (same pass, same sources):
```json
"scouting_brief": {
  "prose": "1–5 sentences, scheme-fit first",
  "role_stability": "locked | committee | in_flux",   // will he hold the job/role
  "scheme_fit": "plus | neutral | minus",             // does the scheme suit him
  "override_flag": false,                              // true = a genuine ROLE/SCHEME DELTA the projection likely hasn't caught → a human should revisit his number
  "rationale": "one line: the delta, or why null",
  "sources": [{ "label": "The Athletic", "url": "…", "date": "YYYY-MM-DD", "type": "coach|beat|analyst|player" }],
  "as_of": "YYYY-MM-DD"
}
```

**3. Store** it in `data/draft-research.json`, keyed by Sleeper player id, beside `adp_commentary`
(durable overlay — survives board rebuilds).

**4. Wire it in (additive + minimal — see constraints):**
- `scripts/build-draft-board.mjs`: merge `scouting_brief` through to `draft-board.json` exactly like
  the existing research overlay merges `adp_commentary`/`risk_flags`.
- `site/draft.js` → `confidence()`: add `role_stability` as an input to the **playing-time/role-risk**
  component, **worst-of** with the existing injury/rookie risk. Map `locked → none` (can *upgrade* a
  crude `rookie` penalty), `committee → some`, `in_flux → high`. If `scouting_brief` is absent/null,
  behavior is **unchanged** (today's rookie/injury fallback). **`scheme_fit` does NOT enter
  `confidence()`.**
- `site/draft.js` render: show the **prose** (detail block + hover-tooltip first sentence), the
  **sources + `as_of`**, a "⚠ fresh news since brief" flag when `nfl-events` postdates `as_of`, and a
  **⚑ override flag** ("scouting: role/scheme delta — revisit projection") when `override_flag`. Honest
  `null` ("not scouted yet") below the top ~50.
- Bump the `?v=` cache-busters on `draft.js`/`style.css` in `draft.html` after editing.

## Hard constraints
- **Honesty**: sourced + dated, or `null`. Never synthesize from memory. The `deep-research` skill's
  adversarial-verify step is your sourcing guarantee.
- **Value independence (load-bearing)**: scouting **NEVER** moves the asset value or the edge. It only
  (a) informs the confidence *band* via `role_stability`, (b) sets `override_flag` for the human, (c)
  renders as descriptive prose. Do not resurrect a value multiplier.
- **Stay in your lane**: you may ADD the `scouting_brief` field, the *minimal* `role_stability` hook in
  `confidence()`, and its render. Do **NOT** restructure the valuation engine ($-pipeline, edge/rec
  math) — the other session owns it and is actively editing `draft.js` / `build-draft-board.mjs`. Keep
  edits small and localized; `git pull --rebase` before pushing and expect to replay onto their commits.
- **Verify** in-browser (serve on :8642, open `/site/draft.html`): briefs render, sources link,
  confidence shifts sensibly for a scouted `in_flux` vs `locked` player, honest nulls, no console
  errors. Then **publish**: commit + push to `main` (Cloudflare auto-deploys). Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Deferred (NOT this session)
The **maintain automation** — folding event-driven scouting synthesis into the `nfl-daily-events`
routine (event-driven + staggered, retrieval-grounded). Leave as a documented follow-up once the seed
proves the format.

## Timing
The 2026 league isn't renewed yet (as of 2026-07-21), but ADP is live on the current board — seed
against current ADP now; refresh closer to the actual draft.
