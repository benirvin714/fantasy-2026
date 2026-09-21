---
description: NFL landscape and rival-leverage briefing translated to a league's scoring; saves dated brief and diffs vs previous
---

Produce a current-NFL-landscape briefing. Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation).

## Scope: the landscape and the rivals, not my roster

As of 2026-09-21 the brief answers **"what is happening around me"**, and nothing else on HQ does.
**"How is my team doing, and what should I do about it"** belongs to the Performance panel
(`plans/valuation-and-scouting.md` §1.32), which is rebuilt twice a day from live numbers, and to the
waiver board and My roster's start/sit colours beneath it. A weekly, LLM-written answer to the same
question is the second opinion that goes stale for six days and eventually disagrees with the first.

So the "So what" section carries exactly two kinds of item:

- **Landscape, translated to this format.** What a news item does to value league-wide in this
  league's scoring and depth: a role change that reorders a position, a scheme change, a market
  move, how fast a wire this deep will clear a name. Written about the league, not about my team.
- **Rival leverage.** How the news weakens or strengthens a rival's roster, and what that does to
  their need, their patience, or their price in a trade. One of my players may be named **only as the
  counterpart** ("pauldag's WR hole is where your RB surplus fits") - the subject is still their need.

And it does NOT carry:

- **Add, drop, claim or bid advice for my roster.** That is the waiver board's, and the Performance
  panel routes to it.
- **My lineup, my injury exposure, or how my team is doing.** That is My roster and Performance.
- **Housekeeping** ("games run Thursday to Monday", "the next brief lands Tuesday").

News that touches one of my players still appears in the landscape sections as news. It simply does
not become a "So what" item about my roster.

## Which league

Takes an optional league argument: `/brief` or `/brief hbgbs` for The HBGBs, `/brief pit` for The
Panther Pit, `/brief clash` for Couples Clash. League facts come from `scripts/lib/leagues.mjs`; do
not hardcode an id.

**Cadence: weekly, Tuesday morning**, run by the `nfl-daily-events` task (step 10) for every league,
gated on the `BRIEF-SLOT` line that `node scripts/nfl-state.mjs` prints. Running it by hand any time
is fine and always works; the gate only governs the scheduled run. It is weekly rather than
twice-daily because that routine's step 1 already scans the same four lanes twice a day, so a
twice-daily brief would re-research news written 20 minutes earlier and its diff would collapse into
the window `nfl-events.json` already covers item by item.

| | hbgbs (default) | pit | clash |
|---|---|---|---|
| League | The HBGBs, 10 teams, roster id 10 | The Panther Pit, 12 teams, roster id **1** | Couples Clash, **14 teams**, roster id **11** |
| **Scoring** | half PPR | half PPR | **FULL PPR** |
| Doctrine | `league-profile.md` | `league-profile.md` **and** `league-profile-pit.md` | `league-profile.md` **and** `league-profile-clash.md` |
| Rival dossiers | `league-tendencies.md` | **none — first season, do not invent owner reads** | **none — first season, do not invent owner reads** |
| Brief file | `briefs/YYYY-MM-DD.md` | `briefs/pit/YYYY-MM-DD.md` | `briefs/clash/YYYY-MM-DD.md` |
| Publish to | `data/site/latest-brief.json` | `data/site/pit/latest-brief.json` | `data/site/clash/latest-brief.json` |

The slot shape is shared by all three, so the structural doctrine transfers. Two things do not, and
the "So what" section is where they bite:

- **Depth.** Startable RB/WR slots run 60 / 72 / **84**. Replacement level falls and the wire thins in
  that order, so the same waiver-relevant news item is worth more in `clash` than in `hbgbs`.
- **Reception value.** `hbgbs` and `pit` are half PPR; **`clash` is full PPR**. A target-share or
  route-participation story is worth roughly double there, and a goal-line/TD-dependence story
  relatively less. Do not write one "So what" and reuse it across leagues — that is the specific
  failure this table exists to prevent.

## Procedure

1. **Establish today's date** and check `get_nfl_state` (season/week/season-type). If the Sleeper MCP is unavailable, note that at the top of the brief and proceed with web-only content — never fabricate Sleeper data.
2. **Pull every roster** (`get_league_rosters`, the chosen league's id per the table above). The rivals' rosters are the point: they are what turns news into leverage. Mine is read too, but only so that a leverage item can name my counterpart and so that my players' news is recognised as such and kept out of "So what" (see Scope).
3. **Web-search current NFL news** — multiple searches, not one. Cover at minimum:
   - Injuries and recoveries with fantasy impact (include practice-report designations in-season)
   - Depth-chart changes: starters named, committees formed/broken, position battles
   - Coaching/scheme changes and their fantasy implications
   - ADP movement / market sentiment shifts since the last brief
   - In preseason: holdouts, trades, rookie camp buzz. In-season: role/snap-count changes.
   Prioritize sources published within the last 7 days; note publication dates. If something can't be verified, either drop it or explicitly mark it unverified.
4. **Write the brief** with sections: `Injuries`, `Depth charts & roles`, `Coaching & scheme`, `Market movement`, and ALWAYS end with **`So what for this league`** — translate every materially relevant item through **the chosen league's** format (2 FLEX, 4pt pass TD, konami-QB premium, DEF tiers — shared; then that league's reception value, **0.5 in hbgbs/pit and 1.0 in clash**, and its FG-miss rule, banded in hbgbs and flat in the other two — see league-profile.md and the league's delta file), and call out rivals by name where the news moves their roster. Follow the Scope section above: landscape and rival leverage only, never advice about my own lineup, health or waiver moves.
5. **Save to the chosen league's brief file** (`briefs/YYYY-MM-DD.md` for hbgbs, `briefs/pit/YYYY-MM-DD.md` for pit, `briefs/clash/YYYY-MM-DD.md` for clash), dated today. If a brief for today already exists, overwrite it but say so.
6. **Diff against the previous brief**: find the most recent earlier file in that league's brief directory. In your chat response, present ONLY what changed since that brief (new items, resolved items, reversals) plus the full "So what for this league" section. If no previous brief exists, present the full brief and say it's the baseline.
7. **Publish to the dashboard**: write the chosen league's brief JSON (`data/site/latest-brief.json` for hbgbs, `data/site/pit/latest-brief.json` for pit, `data/site/clash/latest-brief.json` for clash), schema `{date: "YYYY-MM-DD", so_what: [string, ...]}`, with condensed one-sentence versions of the "So what" items. The panel sits below the Performance panel on HQ, so before publishing re-read every item against Scope: an item that tells me what to do with my own roster is a duplicate of a panel above it and comes out. All three leagues render the panel already, so publishing is the only step: a league with no brief yet shows the standard "no published brief" error until one lands. The panel warns when its brief is more than **10 days** old, which is the weekly cadence plus slack.
8. **Push live**: commit and push so the hosted dashboard updates (Cloudflare Pages auto-deploys from GitHub): stage that league's brief file and its JSON, `git commit -m "Publish brief YYYY-MM-DD"`, `git push`. The live dashboard is https://hbgbs.irvinfamily.com/site/ (login-gated). If the push fails, say so — the local file is written but the live site is stale until pushed.

## Degradation
- No web search available → say so and stop; a brief without current sources is worthless and must not be written from memory.
- No Sleeper MCP → produce the brief but mark roster-relevance flags as unavailable.
