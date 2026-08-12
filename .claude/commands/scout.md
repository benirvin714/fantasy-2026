---
description: Pre-draft scouting sweep — fill scouting_brief for the next batch of unscouted draft-board players; resumable
---

Scout the next batch of skill players for the draft board, filling the `scouting_brief` evidence layer for players who don't have one yet. This is the pre-draft sweep: run it repeatedly, each run covers one bounded batch, until coverage is complete. Read CLAUDE.md rules first (read-only Sleeper; **no stale player analysis — every claim grounded in current web sources or null**; league-format translation).

**Batch size:** default 10 players. If the invocation names a number (e.g. `/scout 20`), use that.

## What a brief is (read the spec before writing one)
Skim `plans/valuation-and-scouting.md` §2. The essentials:
- `scouting_brief` is the **evidence layer** (what analysts/coaches/players say + scheme fit), separate from `adp_commentary` (your verdict). It feeds the confidence band (via `role_stability`) and flags a human revisit (via `override_flag`). **It never moves value or the edge.**
- Schema (§2.2), written per player:
```json
"scouting_brief": {
  "prose": "Scheme-fit first, then sentiment, then watch/risk. 1-5 sentences.",
  "role_stability": "locked | committee | in_flux",
  "scheme_fit": "plus | neutral | minus",
  "override_flag": false,
  "rationale": "one line: the role/scheme delta, or the key cap, or why null",
  "sources": [{ "label": "…", "url": "…", "date": "YYYY-MM-DD", "type": "coach | beat | analyst | player" }],
  "as_of": "YYYY-MM-DD"
}
```
- **Source priority (§2.3):** coach pressers + team beat writers (the scheme-fit half — highest weight) → national analysts (sentiment half) → player quotes (color, not signal). Aim for at least one coach/beat source per brief where one exists.
- **`override_flag` = true only** when scouting sees a genuine role/scheme delta the projection likely hasn't caught (e.g. a new OC who trims his role, a QB change that eats his checkdowns). It is the human-revisit trigger, not a general "risk" flag. Default false.

## Procedure
1. **Get the batch + current flags:** run `node scripts/validate-scouting.mjs --worklist 10 --drip 10 --drip-rank 180` (use the requested batch size). It prints coverage, the next N unscouted skill players **in ADP order**, the re-scout queue, and a **DRIP** work order. **If coverage still shows players missing, your batch = the worklist.** Once coverage is complete (100%) the worklist is empty and **your batch = the DRIP list** instead: the re-scout-queue players most worth refreshing now, which are news, ADP drift, and the pre-draft **thin_source** quality sweep of the 100-200 range (briefs resting on analyst-only sourcing with no beat/coach). Fold in any **dead source** the validator flags.
2. **Research each player** — multiple searches, not one, prioritizing the last ~30 days and noting dates:
   - **Scheme fit (highest weight):** coach/coordinator statements, the team's beat writers — is his role locked, a committee, or in flux; any scheme change (new OC/system), depth-chart competition, projected touches/targets.
   - **Sentiment:** national analysts (outlook, riser/faller, why).
   - **Color:** player's own quotes.
   - **Beat-first bar for ADP ≥ 100 (where this sweep has been weakest, ~85% analyst-only):** at least one source MUST be a team beat writer, a coach or coordinator statement, or a camp/practice report. National-analyst blurbs (CBS, PFF, FantasyPros, Yahoo) are secondary sentiment, not the basis. If real searching turns up no beat or coach source for a late player, say so in the rationale and mark the brief sentiment-only rather than dressing up analyst consensus as a role read.
3. **Synthesize the brief** per the schema above: scheme-fit-first prose (1-5 sentences, concrete — name the OC, the scheme, the competition), the three signal fields, a one-line rationale, real dated sources, `as_of` = today.
   - **Path-to-role lead for ADP ≥ 100:** open the prose with the trigger, not a label: whose snaps he would take, what opens the role (an injury ahead of him, a camp battle, a snap trend), and what he becomes if it happens. A bare "committee back" is the starting point, not the read.
   - **Honesty contract (hard rule, matters most in the late rounds where sourcing is thin):** every claim comes from what you fetched **this run**, cited and dated. If you cannot find real current sources for a player, set `prose`/`role_stability`/`scheme_fit` to `null` with a `rationale` saying why — **never synthesize from training memory**. A thin, honest `null` beats a plausible guess. The user specifically wants the late-round briefs honest, not padded.
4. **Write to `data/draft-research.json`:** for each player, upsert `players["<sleeper_id>"].scouting_brief`. **Preserve** that player's existing `injury_history` / `risk_flags` / `adp_commentary` — only add or replace `scouting_brief`. If the id has no entry yet, create `players["<id>"] = { "scouting_brief": { … } }` and let the build derive the rest. Do **not** overwrite an existing non-null brief unless step 1 flagged it (dead source / stale) and you're refreshing it.
5. **Validate:** run `node scripts/validate-scouting.mjs`. Fix everything it flags **for players in your batch** — a dead source URL (find a live replacement that supports the claim, or drop that source; if the claim loses its only source, soften or null it), an illegal enum value, a missing date. Re-run until your batch is clean. Pre-existing flags on players outside your batch can wait for their own run.
6. **Rebuild the board:** `node scripts/build-draft-board.mjs` (merges the new briefs into `data/site/draft-board.json`). *(Running several batches back-to-back in one sitting? You can do this rebuild + step 7 once after the last batch instead of every batch.)*
7. **Publish** (same order and rules as the daily routine — commit before pull; on a rebase conflict keep your merged version; report failures plainly, never force-push):
   - `git add data/draft-research.json data/site/draft-board.json`
   - `git commit -m "Scout batch: <N> players (<covered>/<pool> briefs)"` (fill in the counts from the validator)
   - `git pull --rebase` then `git push`
8. **Report:** coverage progress (e.g. "23/200, +10 this batch"), the players you scouted with a one-line read each, **any player you left `null` and why** (honest thin-sourcing), and the validator's clean result. Remind that the sweep is resumable — run `/scout` again for the next batch. The live dashboard: https://hbgbs.irvinfamily.com/site/

## Degradation
- **No web search** → stop and say so. A brief without current sources is worthless and must not be written from memory.
- **A player with no findable current sources** → write a `null` brief with a rationale and move on; do not block the rest of the batch, and do not guess.
- **Validator or build fails** → report it and do not push a broken board. The local research file is still written.
