---
description: NFL landscape briefing translated to a league's scoring; saves dated brief and diffs vs previous
---

Produce a current-NFL-landscape briefing. Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation).

## Which league

Takes an optional league argument: `/brief` or `/brief hbgbs` for The HBGBs, `/brief pit` for The
Panther Pit. League facts come from `scripts/lib/leagues.mjs`; do not hardcode an id.

| | hbgbs (default) | pit |
|---|---|---|
| League | The HBGBs, 10 teams, roster id 10 | The Panther Pit, 12 teams, roster id **1** |
| Doctrine | `league-profile.md` | `league-profile.md` **and** `league-profile-pit.md` |
| Rival dossiers | `league-tendencies.md` | **none — first season, do not invent owner reads** |
| Brief file | `briefs/YYYY-MM-DD.md` | `briefs/pit/YYYY-MM-DD.md` |
| Publish to | `data/site/latest-brief.json` | `data/site/pit/latest-brief.json` |

The scoring doctrine is shared (42 of 50 keys identical, same slot shape). The depth doctrine is
not: 12 teams means 72 startable RB/WR slots against 60, so replacement level is lower and the wire
is thinner. Translate through the right one.

## Procedure

1. **Establish today's date** and check `get_nfl_state` (season/week/season-type). If the Sleeper MCP is unavailable, note that at the top of the brief and proceed with web-only content — never fabricate Sleeper data.
2. **Pull the user's current roster** (the chosen league's id and roster id per the table above) so the brief can flag which news items touch the user's players and league rivals' players (rosters via `get_league_rosters`).
3. **Web-search current NFL news** — multiple searches, not one. Cover at minimum:
   - Injuries and recoveries with fantasy impact (include practice-report designations in-season)
   - Depth-chart changes: starters named, committees formed/broken, position battles
   - Coaching/scheme changes and their fantasy implications
   - ADP movement / market sentiment shifts since the last brief
   - In preseason: holdouts, trades, rookie camp buzz. In-season: role/snap-count changes.
   Prioritize sources published within the last 7 days; note publication dates. If something can't be verified, either drop it or explicitly mark it unverified.
4. **Write the brief** with sections: `Injuries`, `Depth charts & roles`, `Coaching & scheme`, `Market movement`, and ALWAYS end with **`So what for this league`** — translate every materially relevant item through HBGBs format (half-PPR, 2 FLEX, 4pt pass TD, konami-QB premium, kicker distance bands, DEF tiers — see league-profile.md), and call out items touching the user's roster or a rival's roster by name.
5. **Save to the chosen league's brief file** (`briefs/YYYY-MM-DD.md` for hbgbs, `briefs/pit/YYYY-MM-DD.md` for pit), dated today. If a brief for today already exists, overwrite it but say so.
6. **Diff against the previous brief**: find the most recent earlier file in that league's brief directory. In your chat response, present ONLY what changed since that brief (new items, resolved items, reversals) plus the full "So what for this league" section. If no previous brief exists, present the full brief and say it's the baseline.
7. **Publish to the dashboard**: write the chosen league's brief JSON (`data/site/latest-brief.json` for hbgbs, `data/site/pit/latest-brief.json` for pit), schema `{date: "YYYY-MM-DD", so_what: [string, ...]}`, with condensed one-sentence versions of the "So what" items. **A league only shows the panel once this file exists**: `site/index.html` marks the brief section `data-league-only="hbgbs"`, so the first time you publish a `pit` brief, change that attribute (or drop it) or the panel will not render there.
8. **Push live**: commit and push so the hosted dashboard updates (Cloudflare Pages auto-deploys from GitHub): stage that league's brief file and its JSON, `git commit -m "Publish brief YYYY-MM-DD"`, `git push`. The live dashboard is https://hbgbs.irvinfamily.com/site/ (login-gated). If the push fails, say so — the local file is written but the live site is stale until pushed.

## Degradation
- No web search available → say so and stop; a brief without current sources is worthless and must not be written from memory.
- No Sleeper MCP → produce the brief but mark roster-relevance flags as unavailable.
