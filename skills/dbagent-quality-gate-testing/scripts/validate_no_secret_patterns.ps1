param(
  [string]$Root = "."
)

$patterns = @(
  "sk-[A-Za-z0-9_\-]{16,}",
  "xox[baprs]-[A-Za-z0-9\-]{16,}",
  "ghp_[A-Za-z0-9]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}"
)

$failed = $false
foreach ($pattern in $patterns) {
  $matches = rg $pattern $Root -S --glob '!node_modules/**' --glob '!dist/**' --glob '!release/**'
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Potential secret pattern found: $pattern"
    Write-Host $matches
    $failed = $true
  }
}

if ($failed) {
  exit 1
}

Write-Host "No obvious secret patterns found."
