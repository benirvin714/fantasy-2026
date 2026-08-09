---
description: NFL landscape briefing translated to HBGBs scoring; saves dated brief and diffs vs previous
---

Produce a current-NFL-landscape briefing for The HBGBs league. Read CLAUDE.md rules first (read-only Sleeper; no stale data; league-format translation).

## Procedure

1. **Establish today's date** and check `get_nfl_state` (season/week/season-type). If the Sleeper MCP is unavailable, note that at the top of the brief and proceed with web-only content — never fabricate Sleeper data.
2. **Pull the user's current roster** (roster ID 10; use the 2026 league ID from CLAUDE.md — if still not renewed, use the most recent roster and say so) so the brief can flag which news items touch the user's players and league rivals' players (rosters via `get_league_rosters`).
3. **Web-search current NFL news** — multiple searches, not one. Cover at minimum:
   - Injuries and recoveries with fantasy impact (include practice-report designations in-season)
   - Depth-chart changes: starters named, committees formed/broken, position battles
   - Coaching/scheme changes and their fantasy implications
   - ADP movement / market sentiment shifts since the last brief
   - In preseason: holdouts, trades, rookie camp buzz. In-season: role/snap-count changes.
   Prioritize sources published within the last 7 days; note publication dates. If something can't be verified, either drop it or explicitly mark it unverified.
4. **Write the brief** with sections: `Injuries`, `Depth charts & roles`, `Coaching & scheme`, `Market movement`, and ALWAYS end with **`So what for this league`** — translate every materially relevant item through HBGBs format (half-PPR, 2 FLEX, 4pt pass TD, konami-QB premium, kicker distance bands, DEF tiers — see league-profile.md), and call out items touching the user's roster or a rival's roster by name.
5. **Save to `briefs/YYYY-MM-DD.md`** (today's date). If a brief for today already exists, overwrite it but say so.
6. **Diff against the previous brief**: find the most recent earlier file in `briefs/`. In your chat response, present ONLY what changed since that brief (new items, resolved items, reversals) plus the full "So what for this league" section. If no previous brief exists, present the full brief and say it's the baseline.
7. **Publish to the dashboard**: write `data/site/latest-brief.json` (schema: `{date: "YYYY-MM-DD", so_what: [string, ...]}`) with condensed one-sentence versions of the "So what" items. The HBGBs HQ site (`site/`) renders this file.
8. **Push live**: commit and push so the hosted dashboard updates (Cloudflare Pages auto-deploys from GitHub): `git add briefs/ data/site/latest-brief.json && git commit -m "Publish brief YYYY-MM-DD" && git push`. The live dashboard is https://hbgbs.irvinfamily.com/site/ (login-gated). If the push fails, say so — the local file is written but the live site is stale until pushed.

## Degradation
- No web search available → say so and stop; a brief without current sources is worthless and must not be written from memory.
- No Sleeper MCP → produce the brief but mark roster-relevance flags as unavailable.
