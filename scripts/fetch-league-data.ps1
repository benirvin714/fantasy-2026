# Read-only pull of Sleeper public API data for The HBGBs league chain.
# Writes raw JSON to data/raw/. No writes to Sleeper — GET requests only.
$ErrorActionPreference = 'Stop'
$root = "C:\Users\ben-i\OneDrive\Documents\AI\Fantasy 2026"
$raw = Join-Path $root "data\raw"
New-Item -ItemType Directory -Force $raw | Out-Null

$api = "https://api.sleeper.app/v1"
$leagueId = "1257432557251731456"

# Walk the previous_league_id chain to collect all seasons of this league
$chain = @()
$cur = $leagueId
while ($cur) {
    $lg = Invoke-RestMethod "$api/league/$cur"
    $chain += [pscustomobject]@{ league_id = $cur; season = $lg.season; name = $lg.name; status = $lg.status; prev = $lg.previous_league_id }
    $lg | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "league-$($lg.season).json")
    $cur = $lg.previous_league_id
}
Write-Host "League chain:"
$chain | Format-Table season, league_id, name, status | Out-String | Write-Host

foreach ($entry in $chain) {
    $id = $entry.league_id
    $season = $entry.season

    # Transactions, weeks 1-18
    $allTx = @()
    foreach ($wk in 1..18) {
        try {
            $tx = Invoke-RestMethod "$api/league/$id/transactions/$wk"
            if ($tx) { $allTx += $tx }
        } catch {}
    }
    $allTx | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "transactions-$season.json")
    Write-Host "Season ${season}: $($allTx.Count) transactions"

    # Rosters + users (for past seasons; current already have via MCP)
    Invoke-RestMethod "$api/league/$id/rosters" | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "rosters-$season.json")
    Invoke-RestMethod "$api/league/$id/users" | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "users-$season.json")

    # Playoff brackets
    try {
        Invoke-RestMethod "$api/league/$id/winners_bracket" | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "winners-bracket-$season.json")
    } catch {}

    # Drafts + picks
    try {
        $drafts = Invoke-RestMethod "$api/league/$id/drafts"
        foreach ($d in $drafts) {
            $d | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "draft-meta-$season.json")
            Invoke-RestMethod "$api/draft/$($d.draft_id)/picks" | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $raw "draft-picks-$season.json")
        }
        Write-Host "Season ${season}: draft data saved"
    } catch { Write-Host "Season ${season}: no draft data" }
}

Write-Host "Done. Files in $raw"
Get-ChildItem $raw | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB)}} | Format-Table | Out-String | Write-Host