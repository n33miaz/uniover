# Lancador estavel. Somente ASCII e compativel com Windows PowerShell 5.1.
# Quem o abre e o launcher.vbs (WScript, sem console), que cria este PowerShell ja oculto. Os filhos abaixo sao chamados
# direto, sem Start-Process: herdam o console oculto em vez de criar um novo, entao nada pisca na tela.
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$current = Join-Path $base 'app\tools\run-agent.ps1'
$legacy = Join-Path $base 'agent-src\tools\run-agent.ps1'
$fallback = Join-Path $base 'run-agent.fallback.ps1'

# Um lancador so: a tarefa e a migracao podem tentar subir outro ao mesmo tempo.
$created = $false
# O nome inclui a pasta: outra instalacao (ou um teste numa pasta temporaria) nao disputa o mesmo.
$sha = [System.Security.Cryptography.SHA256]::Create()
$key = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($base.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($true, ('Local\UniOverLauncher-' + $key), [ref]$created)
if (-not $created) { exit 0 }

# Na instalacao real, o lancador antigo usava um nome de mutex sem a pasta: se um deles ainda esta
# vivo, este nao sobe (dois lancadores dariam dois agentes com a mesma identidade). Em outra pasta
# (teste, outra instalacao) o nome antigo nao vale e nao se disputa.
$realBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'UniOver'
$legacyMutex = $null
if ($base -ieq $realBase) {
    $legacyCreated = $false
    $legacyMutex = New-Object System.Threading.Mutex($true, 'Local\UniOverLauncher', [ref]$legacyCreated)
    if (-not $legacyCreated) { exit 0 }
}

# Este lancador e o unico dono do agente. Qualquer agente que sobrou (layout antigo com
# agent-src/venv/run-agent.ps1 na raiz, ou um supervisor orfao) sai antes: dois agentes com a
# mesma identidade disputariam a conexao com o servidor.
$leftovers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and ($_.ProcessId -ne $PID) -and (
        $_.CommandLine -like "*$base\run-agent.ps1*" -or
        $_.CommandLine -like "*$base\agent-src*" -or
        $_.CommandLine -like "*$base\venv*" -or
        $_.CommandLine -like "*$base\app\*" -or
        $_.CommandLine -like "*$base\runtime\*"
    )
}
foreach ($process in $leftovers) {
    & taskkill.exe /PID $process.ProcessId /T /F *> $null
}

while ($true) {
    if (Test-Path -LiteralPath $current) {
        $started = Get-Date
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $current
        $code = $LASTEXITCODE
        if ($code -eq 42) { continue }
        if (((Get-Date) - $started).TotalSeconds -ge 30) { Start-Sleep -Seconds 5; continue }
    }
    # Durante a primeira migracao, a tarefa ja aponta para este lancador antes de `agent-src`
    # virar `app`. A queda nesse intervalo ainda pode iniciar o supervisor antigo.
    if (Test-Path -LiteralPath $legacy) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $legacy
        Start-Sleep -Seconds 5
        continue
    }
    if (Test-Path -LiteralPath $fallback) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $fallback
    }
    Start-Sleep -Seconds 30
}
