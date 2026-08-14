---
description: Team-batched parallel re-scout of the live queue (N agents, one merge, no write collisions)
---

Run a deep scouting pass over the **live re-scout queue**, batched by NFL team and fanned out
across parallel research agents. This is the pre-draft heavy pass. It exists so the week of the
draft costs one bounded run instead of a nightly grind, and so it never has to happen on draft day.

**Invoking this command IS the request to use subagents.** Use the `Agent` tool for the research
fan-out. Do not do the searching yourself in this session: web results are bulky and would sit in
context for every turn afterward, which is the whole cost problem this command solves.

**Arguments:** `/deep-scout [agents] [--max-rank N] [--reason news,adp_drift]`
Default 5 agents, rank cap 150. `/deep-scout 3` runs a cheaper pass.

## Why team batching (do not "improve" this into per-player agents)
A backfield is ONE question with N answers that must agree. Arizona had four queued RBs; four
independent agents would run the same search four times and could return four briefs that
contradict each other on who has the goal-line work. `deep-scout-batches.mjs` keeps every team
whole inside one agent for exactly this reason, and `deep-scout-merge.mjs` refuses to write when
two players in the same team/position group both come back `locked`.

## Procedure

1. **Refresh the queue, then batch.** From the project directory:
   ```
   node scripts/validate-scouting.mjs --no-net
   node scripts/deep-scout-batches.mjs --agents 5
   ```
   The first rebuilds `data/rescout-queue.json` so you are batching against current triggers,
   not a stale list. The second prints one `AGENT n of N` block per agent and writes
   `data/raw/deep-scout-batches.json`. If it prints "Nothing to assign", stop and say so:
   an empty queue means the nightly drip already caught everything, which is a success.
   It also prints the contested position groups. Sanity-check that each one landed inside a
   single agent block before you spawn anything.

2. **Fan out.** Spawn one `general-purpose` agent per printed block, **all in one message** so
   they run concurrently. Use `model: "sonnet"` unless the invocation asks otherwise: the task is
   search-grounded and schema-constrained, every source URL gets fetched by the validator in step 4,
   and a fabricated link fails there. Paste that agent's block verbatim in place of `{{TEAM_BLOCK}}`
   in the prompt below. Nothing else in the prompt changes between agents.

3. **Collect and merge.** Save each agent's returned JSON to its own file in the session scratchpad
   (`agent1.json`, `agent2.json`, ...), then run ONE merge:
   ```
   node scripts/deep-scout-merge.mjs <scratchpad-dir>
   ```
   Never let agents write `data/draft-research.json` themselves. Five concurrent read-modify-writes
   keep one and silently drop four; the merge script is the only writer.
   It validates schema, enums, dates, URL shape, house style and the beat-first bar, rejects bad
   briefs rather than writing them, and exits non-zero on a group conflict. On a conflict, re-run
   just the owning agent for that group with the conflict quoted back to it. Use `--force` only if
   you have decided the two `locked` reads are genuinely compatible, and say why in the report.

4. **Validate with the network, then rebuild.**
   ```
   node scripts/validate-scouting.mjs
   node scripts/build-draft-board.mjs
   ```
   Fix any DEAD source on a player written this run: find a live replacement supporting the same
   claim, or drop the source; if a claim loses its only source, soften or remove the claim. A dead
   URL on a brief you just wrote is the fabrication tripwire. Treat a cluster of them as a failed
   agent, not a link-rot problem, and re-run that agent.
   If the build prints "REFUSING TO WRITE", report the line and continue. Do not pass `--force`.

5. **Publish** (commit before pull; `git pull --rebase` refuses to run with uncommitted changes):
   - `git add data/draft-research.json data/site/draft-board.json data/rescout-queue.json`
   - `git commit -m "Deep scout: <N> briefs across <T> teams"`
   - `git pull --rebase` then `git push`
   Report failures plainly. Never force-push. On a rebase conflict keep your merged version.

6. **Report.** Lead with what changed a draft decision, not with process:
   - Any player whose `role_stability` or `scheme_fit` MOVED, old value to new, one line each.
     This is the only part that touches the confidence band, so it is the part worth reading.
   - Any `override_flag: true` set, and why.
   - Players the agents skipped for thin sourcing, by name.
   - Briefs rejected by the merge validator and whether you re-ran them.
   - Queue count before and after, and what is still open.
   End with https://hbgbs.irvinfamily.com/site/

## The agent prompt

```
You are a scouting researcher for a fantasy football decision-support system.
Project: C:\Users\ben-i\OneDrive\Documents\AI\Fantasy 2026 (10-team half-PPR,
2 FLEX, only 5 bench, 4-pt pass TD, half-PPR receiving).

Return DATA, not conversation. No preamble, no confidence tags, no summary of
your process. Your entire final message is the JSON object specified below.

## Assignment
{{TEAM_BLOCK}}

## Method (order matters)
1. PER TEAM, ONCE: confirm the 2026 head coach, offensive coordinator, and
   scheme with a source dated in the last 45 days. The 2026 coaching carousel
   was unusually heavy and a stale OC is the single most common defect in this
   dataset. Do not carry a coordinator over from memory. If you cannot confirm
   the OC, say so in team_facts and let it constrain every brief on that team.
2. PER POSITION GROUP: when two or more assigned players compete for the same
   touches, resolve the group as ONE question before writing any brief. Decide
   the pecking order, then write briefs that agree with each other. A backfield
   where two players are both "locked" is a failed batch and will be rejected.
3. PER PLAYER: 2-4 targeted searches for what changed in the last ~30 days.
   Source priority: coach and coordinator quotes and team beat writers first
   (scheme fit), then national analysts (sentiment), then player quotes (color).
   At least one source should be coach or beat where one exists; analyst-only
   briefs are flagged on merge.

## Do not research
ADP, projections, tier placement, bye weeks. A deterministic build script owns
those and refreshes them nightly. Anything you write about them is noise.

## Honesty contract (hard)
Every claim traces to a page you opened THIS run, cited with a real dated URL.
Every URL you return is fetched and checked after you finish; a link that does
not resolve is treated as fabrication, not link rot.
If a player has no findable current sourcing, return
  {"id": "...", "action": "skip", "reason": "<what you searched, what you found>"}
and move on. A skip is a correct outcome. Never write from training memory,
never pad a thin player with plausible-sounding filler.

## Output (strict, nothing outside the JSON)
{
  "team_facts": {
    "ARI": {"hc": "...", "oc": "...", "scheme": "one line",
            "source": {"label": "...", "url": "...", "date": "YYYY-MM-DD"}}
  },
  "group_reads": [
    {"team": "ARI", "pos": "RB",
     "read": "one line: the pecking order you settled on and what settled it"}
  ],
  "briefs": [
    {"id": "<sleeper_id>", "action": "write", "scouting_brief": {
      "prose": "1-5 sentences. Scheme fit first, then sentiment, then the cap or watch.",
      "role_stability": "locked|committee|in_flux",
      "scheme_fit": "plus|neutral|minus",
      "override_flag": false,
      "rationale": "one line",
      "sources": [{"label": "...", "url": "...", "date": "YYYY-MM-DD",
                   "type": "coach|beat|analyst|player"}],
      "as_of": "YYYY-MM-DD"
    }}
  ]
}

## Constraints
- Use the sleeper id given in the assignment as "id", exactly as written.
- Write ONLY scouting_brief. injury_history, risk_flags and adp_commentary are
  owned by other passes.
- Do NOT edit any file. The caller merges your JSON.
- override_flag = true only for a role or scheme delta the projection probably
  has not priced (new OC who trims his role, a QB change that eats checkdowns).
  It is a human-revisit trigger, not a general risk marker.
- House style: no em-dashes anywhere in prose or rationale.
- Every "so what" reads through THIS format. Half-PPR receiving work and
  goal-line carries move the needle; "he's a talented player" does not.
```

## When to run it
Once, late. The nightly drip clears the top-150 queue on its own at 3 per night, so running this
early mostly re-derives what the drip would have done free. The information that actually moves a
brief lands in the preseason-week-3 and roster-cuts window, so the high-value slot is the two days
before the draft. Do not run it on draft day; `draft-day-check` covers breaking news that morning.

## Degradation
- **No web search** → stop. A brief without current sources must never be written from memory.
- **An agent returns prose instead of JSON** → do not hand-transcribe it. Re-run that agent with
  the output contract quoted back. Hand-editing is how schema drift enters the file.
- **Merge rejects everything from one agent** → that agent failed. Re-run it rather than lowering
  the bar, and say so in the report.
- **Queue empty** → report that and skip the pass. It means the drip is keeping up.
