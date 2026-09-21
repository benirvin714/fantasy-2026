---
description: Write the roster room's trade reads - per proposal, will this owner accept, and how to pitch it (only the reads the work order lists)
---

The roster room's trade search finds deals where BOTH optimal lineups rise. It cannot say whether the
other owner would accept one. This command writes that judgment, one short read per proposal, into
each league's `trade-reads.json`, which the roster room shows under the proposal. Design of record:
`plans/valuation-and-scouting.md` §1.35. Read CLAUDE.md's hard rules first (read-only Sleeper; no stale
player analysis). **Recommendations only: never propose, accept or message anything on Sleeper.**

## Procedure

1. **Get the work order.** Run exactly this, from the project directory:

   ```
   node scripts/trade-reads.mjs
   ```

   It covers every league in the registry. For each one it has already **removed** reads whose proposal
   no longer exists and reads that a later news event has overtaken, and it prints a `KEY` block for
   every proposal that needs a read now, with the context below. If every league says "nothing to write
   for this league", stop: there is nothing to do, and that is the common case.

2. **Write one read per listed KEY, and no others.** Carried-forward reads are left exactly as they are;
   the work order decides the list, so never add to it and never trim it. Each read goes in that league's
   file (`data/site/trade-reads.json` for hbgbs, `data/site/pit/trade-reads.json`,
   `data/site/clash/trade-reads.json`, i.e. `<out_dir>/trade-reads.json` from `scripts/lib/leagues.mjs`),
   under `reads["<KEY>"]`, exactly as printed:

   ```json
   {"partner": "DiaperDutyDaddy", "roster_id": 2,
    "give": ["Bhayshul Tuten"], "get": ["Brock Purdy"],
    "verdict": "likely" | "coin_flip" | "long_shot",
    "text": "one or two sentences, at most 320 characters",
    "evidence": "the owner behaviour the verdict rests on, one line",
    "as_of": "YYYY-MM-DD (today)"}
   ```

   Set the file's top-level `generated` to today and `league` to the league key. If the file does not
   exist yet, create it as `{"generated": ..., "league": ..., "reads": {...}}`.

3. **The verdict: will he accept it as proposed?**
   - `likely`: he trades (his appetite and dossier say so) AND the deal gives him something he visibly
     needs or costs him something he visibly does not (a position in his weak spots; a bench piece he
     cannot start, like a second starting QB in a one-QB league).
   - `long_shot`: he does not trade (a `cold` or `dead` appetite, "not a trade outlet", no trades in
     years), or the deal takes away something he is short of.
   - `coin_flip`: everything between, AND the default whenever the evidence is thin.
   - **The evidence rule.** `likely` and `long_shot` must carry `evidence` citing what the owner has
     actually done: his trade count, a dossier line, his standing, his roster need. No evidence, no
     verdict: write `coin_flip`. In a league with **no owner history** (the work order says so), you may
     only write `likely` or `long_shot` for a partner who has made a move this season; otherwise it is
     `coin_flip`, and the gate below rejects anything else.

4. **The text: how he takes it, then how to pitch it.** Lead with his side of it (what the deal does for
   his lineup and his season), then the pitch: what to lead with, and when. One or two sentences.
   - **Current data beats the dossier.** The dossiers were written before the season and some of their
     "current roster" lines are already out of date (on 2026-09-21 one still called a 5th-seeded team
     the league's worst roster, and another quoted last season's 4-10). His trade HISTORY transfers; a
     read of his roster or standing comes from the work order's `standing`, `strength` and `weak spots`.
   - Say what the deal does in this league's terms: a projected-points gain, a slot it fills. Do not
     assert anything about a player that is not in the work order or the news it printed. If a claim
     about a player would need fresh sourcing, leave it out; the read is about the owner.
   - Name only this league's owners. No em-dashes (house style).

5. **Gate it.** Run:

   ```
   node scripts/trade-reads.mjs --check
   ```

   **Exit 0**: done. **Exit 1**: fix every `ERROR` line (a missing evidence line, a verdict the evidence
   rule forbids, text over 320 characters) and run it again. Do not stop on a failing file: the page
   renders what is in it.

6. **Publishing.** Inside the twice-daily routine, `npm run stage:publish` carries every league's
   `trade-reads.json`, so do not commit here. Run by hand, stage the league files you wrote and commit
   ("Trade reads YYYY-MM-DD").

## Degradation
- No roster room for a league: the work order skips it. Nothing to write.
- A proposal whose partner has no dossier and no moves: `coin_flip`, with text on the deal's merits for
  him. That is the honest answer, not a failure.
