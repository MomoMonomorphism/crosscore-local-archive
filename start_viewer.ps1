param(
    [ValidateRange(1, 65535)][int]$Port = 8798,
    [switch]$NoBrowser,
    [switch]$CheckOnly,
    [switch]$Build,
    [string]$Python,
    [string]$Config
)

$ErrorActionPreference = 'Stop'
$viewerRoot = $PSScriptRoot
$previousConfig = $env:CROSSCORE_CONFIG
if ($Config) { $env:CROSSCORE_CONFIG = (Resolve-Path -LiteralPath $Config).Path }
try {
    if ($Python -and -not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "Explicit Python executable not found: $Python" }
    # Explicit argument -> environment -> project venv -> PATH -> legacy local environment.
    $candidates = @($Python, $env:CROSSCORE_PYTHON, (Join-Path $viewerRoot '.venv/Scripts/python.exe'))
    $pathPython = Get-Command python -CommandType Application -ErrorAction SilentlyContinue
    if ($pathPython) { $candidates += $pathPython.Source }
    $candidates += Join-Path $env:USERPROFILE '.workbuddy/binaries/python/envs/crosscore/Scripts/python.exe'
    $pythonExe = $null
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $pythonExe = (Resolve-Path -LiteralPath $candidate).Path; break }
    }
    if (-not $pythonExe) { throw 'Python not found. Use -Python <python.exe> or CROSSCORE_PYTHON; see docs/RUNBOOK.md.' }

    Push-Location $viewerRoot
    try {
        if ($Build) {
            $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
            if (-not $node) { throw 'Node.js not found on PATH. Install Node and run npm ci in web first.' }
            if (-not (Test-Path -LiteralPath 'web/node_modules/typescript/bin/tsc')) { throw 'Frontend dependencies missing. Run npm ci in web.' }
            Push-Location (Join-Path $viewerRoot 'web')
            try {
                & $node.Source node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
                if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed' }
                & $node.Source node_modules/vite/bin/vite.js build --emptyOutDir false --configLoader runner
                if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
            } finally { Pop-Location }
        }
        $reportText = & $pythonExe -X utf8 startup_check.py --json
        $checkExit = $LASTEXITCODE
        if (-not $reportText) { throw 'Startup check did not return a report. Check Python/configuration.' }
        $report = ($reportText -join "`n") | ConvertFrom-Json
        foreach ($item in $report.checks) { Write-Host "[$($item.status)] $($item.name): $($item.detail)" }
        if ($checkExit -ne 0 -or -not $report.ok) { throw 'Startup check failed. Existing caches were not regenerated or removed.' }
        if ($CheckOnly) { Write-Host 'Read-only startup check passed.'; return }

        $url = "http://127.0.0.1:$Port/"
        $health = $null
        try { $health = Invoke-RestMethod -Uri "$($url)api/health" -TimeoutSec 2 } catch { }
        if ($health) {
            if ($health.service -ne 'crosscore-local-viewer' -or $health.workspace -ne $viewerRoot) {
                throw "Port $Port belongs to another or legacy/unidentified service. Verify and stop that instance manually, or choose -Port. No process was stopped."
            }
            foreach ($path in $report.paths.PSObject.Properties) {
                if (-not $health.runtimePaths -or $health.runtimePaths.($path.Name) -ne $path.Value) {
                    throw "The running server uses different or unverified resource paths ($($path.Name)). Restart that verified instance to apply configuration."
                }
            }
            Write-Host "Reusing verified server PID $($health.pid)."
        } else {
            $serverArgs = @('-X', 'utf8', ('"' + (Join-Path $viewerRoot 'server.py') + '"'), '--port', $Port)
            $process = Start-Process -FilePath $pythonExe -ArgumentList $serverArgs -WorkingDirectory $viewerRoot -WindowStyle Hidden -PassThru
            $ready = $false
            for ($attempt = 0; $attempt -lt 50; $attempt++) {
                Start-Sleep -Milliseconds 200
                if ($process.HasExited) { throw "Viewer exited during startup (code $($process.ExitCode)). Run server.py in foreground for details." }
                try {
                    $health = Invoke-RestMethod -Uri "$($url)api/health" -TimeoutSec 1
                    # Windows venv python.exe may redirect through a child process.
                    if ($health.ok -and $health.workspace -eq $viewerRoot -and ($health.pid -eq $process.Id -or $health.parentPid -eq $process.Id)) { $ready = $true; break }
                } catch { }
            }
            if (-not $ready) { throw "Viewer did not become ready. Check PID $($process.Id) before retrying." }
        }
        Write-Host "CrossCore local viewer: $url"
        if (-not $NoBrowser) { Start-Process $url }
    } finally { Pop-Location }
} finally {
    if ($Config) { $env:CROSSCORE_CONFIG = $previousConfig }
}
