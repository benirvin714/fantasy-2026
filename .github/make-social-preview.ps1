# Render the GitHub social preview card for benirvin714/fantasy-2026.
# 1280x640 (GitHub's recommended size), palette lifted from site/style.css so the
# card and the dashboard read as one system. No dependencies beyond System.Drawing.

Add-Type -AssemblyName System.Drawing

$OutPath = Join-Path $PSScriptRoot 'social-preview.png'
$W = 1280
$H = 640
$M = 88          # safe margin; LinkedIn crops 2:1 down toward 1.91:1

# --- palette (site/style.css) ---------------------------------------------
function C([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$bg      = C '#0b0f0c'
$surface = C '#111710'
$border  = C '#22301f'
$text    = C '#e6ede4'
$dim     = C '#9db199'
$faint   = C '#82977e'
$accent  = C '#63bf5a'
$moss    = C '#8fae6d'

# --- fonts ----------------------------------------------------------------
$fams = (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name
$sans = if ($fams -contains 'Segoe UI') { 'Segoe UI' } else { 'Arial' }
$mono = if ($fams -contains 'Cascadia Mono') { 'Cascadia Mono' } else { 'Consolas' }

$px = [System.Drawing.GraphicsUnit]::Pixel
$fTitle   = New-Object System.Drawing.Font($sans, 62, [System.Drawing.FontStyle]::Bold, $px)
$fLead    = New-Object System.Drawing.Font($sans, 27, [System.Drawing.FontStyle]::Regular, $px)
$fEyebrow = New-Object System.Drawing.Font($mono, 20, [System.Drawing.FontStyle]::Regular, $px)
$fStatNum = New-Object System.Drawing.Font($mono, 25, [System.Drawing.FontStyle]::Bold, $px)
$fStatLbl = New-Object System.Drawing.Font($mono, 25, [System.Drawing.FontStyle]::Regular, $px)

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

$tf = [System.Drawing.StringFormat]::GenericTypographic   # tight metrics, no side bearing

function Brush($c) { New-Object System.Drawing.SolidBrush($c) }
function Draw([string]$s, $font, $color, [single]$x, [single]$y) {
  $b = Brush $color
  $g.DrawString($s, $font, $b, $x, $y, $tf)
  $b.Dispose()
}
function Width([string]$s, $font) {
  return $g.MeasureString($s, $font, [int]::MaxValue, $tf).Width
}

# --- background: near-black with a soft panel wash toward the top ----------
$g.Clear($bg)
$washRect = New-Object System.Drawing.Rectangle(0, 0, $W, 400)
$wash = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $washRect, [System.Drawing.Color]::FromArgb(255, $surface), [System.Drawing.Color]::FromArgb(0, $bg), 90.0)
$g.FillRectangle($wash, $washRect)
$wash.Dispose()

# hairline grid, very low contrast, echoes the dashboard's data-panel feel
$penGrid = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(26, $border), 1)
for ($x = $M; $x -lt $W; $x += 64) { $g.DrawLine($penGrid, $x, 0, $x, $H) }
$penGrid.Dispose()

# --- accent rule down the left of the text block --------------------------
$brAccent = Brush $accent
$g.FillRectangle($brAccent, $M, 150, 5, 168)

# --- header line: repo slug left, constraint right ------------------------
Draw 'benirvin714 / fantasy-2026' $fEyebrow $faint ($M + 30) 104
$note = 'read-only by construction'
Draw $note $fEyebrow $moss ($W - $M - (Width $note $fEyebrow)) 104

# --- title (two lines, sized to sit inside the safe margin) ---------------
$tx = $M + 30
Draw 'Agentic'                $fTitle $text  $tx 150
Draw 'decision-support system' $fTitle $text $tx 226

# --- lead copy ------------------------------------------------------------
Draw 'Slash-command workflows, encoded domain rules, quantitative models'      $fLead $dim $tx 340
Draw 'built from six seasons of raw data, and deterministic validators.'        $fLead $dim $tx 378

# --- divider --------------------------------------------------------------
$penDiv = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, $border), 1)
$g.DrawLine($penDiv, $M, 456, $W - $M, 456)
$penDiv.Dispose()

# --- stat row: accent numerals, dim labels, faint separators --------------
$stats = @(
  @{ n = '6';     l = 'seasons' },
  @{ n = '900';   l = 'draft picks' },
  @{ n = '2,100'; l = 'transactions' },
  @{ n = '0';     l = 'dependencies' }
)
# GenericTypographic drops leading/trailing spaces from both measurement and
# placement, so gaps are explicit pixels rather than space characters.
$gapNumLbl = 11    # between an accent numeral and its label
$gapSep    = 26    # each side of the separator dot
$y         = 506
$x         = [single]$M

foreach ($i in 0..($stats.Count - 1)) {
  $s = $stats[$i]
  Draw $s.n $fStatNum $accent $x $y
  $x += (Width $s.n $fStatNum) + $gapNumLbl
  Draw $s.l $fStatLbl $dim $x $y
  $x += (Width $s.l $fStatLbl)
  if ($i -lt $stats.Count - 1) {
    $x += $gapSep
    Draw '·' $fStatLbl $faint $x $y
    $x += (Width '·' $fStatLbl) + $gapSep
  }
}
if ($x -gt ($W - $M)) { Write-Warning "stat row overruns the safe margin by $([int]($x - ($W - $M)))px" }

$brAccent.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$kb = [math]::Round((Get-Item $OutPath).Length / 1KB, 1)
"wrote $OutPath  ${W}x${H}  ${kb} KB"
