# Supervisor atualizado junto com app. Somente ASCII: Windows PowerShell 5.1 le sem BOM como ANSI.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'app'
$previous = Join-Path $base 'app.previous'
$runtime = Join-Path $base 'runtime'
$blocked = Join-Path $runtime '.blocked-versions'
$trial = Join-Path $runtime 'update-trial.txt'
$env:UNIOVER_CONFIG_FILE = Join-Path $base 'config\agent.toml'
$env:UNIOVER_LOG_FILE = Join-Path $base 'logs\agent.log'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $runtime 'venv'
$env:PYTHONUTF8 = '1'

function Find-Uv {
    $found = Get-Command uv -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($relative in @('Microsoft\WinGet\Links\uv.exe', 'Microsoft\WindowsApps\uv.exe', '.local\bin\uv.exe')) {
        $candidate = Join-Path $env:LOCALAPPDATA $relative
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-Version {
    try { return [System.IO.File]::ReadAllText((Join-Path $source '.version')).Trim() }
    catch { return $null }
}

function Stop-VenvUsers {
    # Qualquer processo rodando do ambiente (icone da bandeja, agente que sobrou) prende o
    # uniover-agent.exe e faz o sync falhar para sempre. Antes de sincronizar, todos saem.
    $venvPath = Join-Path $runtime 'venv'
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProcessId -ne $PID) -and (
            ($_.ExecutablePath -and $_.ExecutablePath -like "$venvPath\*") -or
            ($_.CommandLine -and $_.CommandLine -like "*uniover-agent*" -and $_.CommandLine -like "*$source*")
        )
    } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }
}

function Sync-Agent([string]$Uv) {
    Stop-VenvUsers
    & $Uv sync --project $source --quiet *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    $venv = Join-Path $runtime 'venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue }
    & $Uv sync --project $source --quiet *> $null
    return ($LASTEXITCODE -eq 0)
}

function Schedule-NextUpdate { return (Get-Date).AddHours(6).AddMinutes((Get-Random -Minimum 0 -Maximum 46)) }

function Invoke-Update([string]$Uv) {
    $before = Get-Version
    $env:UV = $Uv
    & $Uv run --project $source uniover-agent self-update *> $null
    $after = Get-Version
    if ($before -and $after -and $before -ne $after) {
        [System.IO.File]::WriteAllText($trial, ($after + '|0'), [System.Text.Encoding]::ASCII)
        return $true
    }
    return $false
}

function Note-Run([double]$Seconds) {
    if (-not (Test-Path -LiteralPath $trial)) { return }
    $parts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
    if ($parts.Count -ne 2 -or $parts[0] -ne (Get-Version)) { return }
    if ($Seconds -ge 600) { Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue; return }
    $falls = 0
    [void][int]::TryParse($parts[1], [ref]$falls)
    $falls++
    if ($falls -lt 3 -or -not (Test-Path -LiteralPath $previous)) {
        [System.IO.File]::WriteAllText($trial, ($parts[0] + '|' + $falls), [System.Text.Encoding]::ASCII)
        return
    }
    $bad = Join-Path $runtime ('app.rejected-' + $parts[0].Substring(0, 12))
    Remove-Item -LiteralPath $bad -Recurse -Force -ErrorAction SilentlyContinue
    try {
        Move-Item -LiteralPath $source -Destination $bad -ErrorAction Stop
        Move-Item -LiteralPath $previous -Destination $source -ErrorAction Stop
        if (-not (Select-String -LiteralPath $blocked -SimpleMatch $parts[0] -Quiet -ErrorAction SilentlyContinue)) {
            Add-Content -LiteralPath $blocked -Value $parts[0] -Encoding ASCII
        }
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
    } catch { }
}

function Start-Tray([string]$Uv) {
    $arguments = 'run --project "' + $source + '" uniover-agent tray'
    return Start-Process -FilePath $Uv -ArgumentList $arguments -PassThru -WindowStyle Hidden
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Location -LiteralPath $base
$wait = 5
$nextUpdate = [DateTime]::MinValue
$tray = $null
while ($true) {
    $uv = Find-Uv
    if (-not $uv -or -not (Test-Path -LiteralPath $source)) { Start-Sleep -Seconds 300; continue }
    $updated = $false
    if ((Get-Date) -ge $nextUpdate -or (Test-Path (Join-Path $runtime 'update-now'))) {
        Remove-Item -LiteralPath (Join-Path $runtime 'update-now') -Force -ErrorAction SilentlyContinue
        $updated = Invoke-Update $uv
        $nextUpdate = Schedule-NextUpdate
        if ($updated) {
            if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
            exit 42
        }
    }
    if (-not (Sync-Agent $uv)) { Start-Sleep -Seconds $wait; $wait = [Math]::Min($wait * 2, 300); continue }
    # O icone sobe depois do sync: antes, ele prenderia o executavel que o sync troca.
    if ($null -eq $tray -or $tray.HasExited) { $tray = Start-Tray $uv }
    $arguments = 'run --project "' + $source + '" uniover-agent run'
    $process = Start-Process -FilePath $uv -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $started = Get-Date
    $restartForUpdate = $false
    while (-not $process.HasExited) {
        Start-Sleep -Seconds 15
        if (Test-Path (Join-Path $runtime 'restart-now')) {
            Remove-Item -LiteralPath (Join-Path $runtime 'restart-now') -Force -ErrorAction SilentlyContinue
            & taskkill.exe /PID $process.Id /T /F *> $null
            $restartForUpdate = $true
        }
        if ((Get-Date) -ge $nextUpdate -or (Test-Path (Join-Path $runtime 'update-now'))) {
            Remove-Item -LiteralPath (Join-Path $runtime 'update-now') -Force -ErrorAction SilentlyContinue
            if (Invoke-Update $uv) {
                & taskkill.exe /PID $process.Id /T /F *> $null
                $restartForUpdate = $true
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                exit 42
            }
            $nextUpdate = Schedule-NextUpdate
        }
        if ($null -ne $tray -and $tray.HasExited) { $tray = Start-Tray $uv }
    }
    $seconds = ((Get-Date) - $started).TotalSeconds
    if (-not $restartForUpdate) { Note-Run $seconds }
    if ($seconds -gt 600 -or $restartForUpdate) { $wait = 5 }
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
}
