# Lancador estavel. Somente ASCII e compativel com Windows PowerShell 5.1.
# Quem o abre e o launcher.vbs (WScript, sem console), que cria este PowerShell ja oculto. Os filhos abaixo sao chamados
# direto, sem Start-Process: herdam o console oculto em vez de criar um novo, entao nada pisca na tela.
$ErrorActionPreference = 'Continue'
# A pasta fixa (onde este lancador e o launcher.vbs ficam, e onde a tarefa agendada os procura) guarda o ponteiro
# location.txt da pasta que a pessoa escolheu na instalacao. Sem ponteiro valido, os dados ficam na pasta fixa.
# O ponteiro e lido como UTF-8 (o caminho pode ter acento); nunca vai para o .vbs, que le em ANSI.
$anchor = Join-Path $env:LOCALAPPDATA 'UniOver'
$base = $anchor
try {
    $chosen = ([System.IO.File]::ReadAllText((Join-Path $anchor 'location.txt'), [System.Text.Encoding]::UTF8) -split "`n")[0].Trim()
    if ($chosen -and [System.IO.Path]::IsPathRooted($chosen) -and (Test-Path -LiteralPath $chosen -PathType Container)) { $base = $chosen }
} catch { }
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
if ($anchor -ieq $realBase) {
    $legacyCreated = $false
    $legacyMutex = New-Object System.Threading.Mutex($true, 'Local\UniOverLauncher', [ref]$legacyCreated)
    if (-not $legacyCreated) { exit 0 }
}

# Este lancador e o unico dono do agente. Qualquer agente que sobrou (layout antigo com
# agent-src/venv/run-agent.ps1 na raiz, ou um supervisor orfao) sai antes: dois agentes com a
# mesma identidade disputariam a conexao com o servidor.
function Stop-Leftovers {
    $leftovers = Get-CimInstance Win32_Process -OperationTimeoutSec 30 -ErrorAction SilentlyContinue | Where-Object {
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
}
Stop-Leftovers

# Queda de energia no meio da troca de pasta da atualizacao (app -> app.previous, depois app.new -> app): sem `app` o
# supervisor nao tem de onde subir e esperaria para sempre, e nenhum outro caminho a restaura. Este lancador (que a
# atualizacao nao troca) refaz a pasta ANTES de iniciar o supervisor. So age quando `app` realmente nao existe (ou esta sem
# o essencial): a troca so acontece depois de a candidata ser validada, e uma atualizacao em andamento sempre tem `app`.
$appDir = Join-Path $base 'app'
$appNew = Join-Path $base 'app.new'
$appPrevious = Join-Path $base 'app.previous'
$runtimeDir = Join-Path $base 'runtime'
$recoveryNoted = $false

function Get-FolderVersion([string]$Folder) {
    try { $text = [System.IO.File]::ReadAllText((Join-Path $Folder '.version')).Trim() } catch { return $null }
    if ($text -match '^[0-9a-f]{40}$') { return $text }
    return $null
}

function Test-AppFolder([string]$Folder, [bool]$NeedsVersion) {
    if (-not (Test-Path -LiteralPath (Join-Path $Folder 'pyproject.toml'))) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $Folder 'tools\run-agent.ps1'))) { return $false }
    if ($NeedsVersion -and -not (Get-FolderVersion $Folder)) { return $false }
    return $true
}

function Write-LauncherLog([string]$Message, [string]$Level = 'WARNING') {
    # Uma linha em logs\supervisor.log (o mesmo do supervisor, no formato do registro do agente). Nao vai para o
    # agent.log: o rodizio dele e do Python, e dois processos no mesmo arquivo perdem linhas.
    try {
        $logs = Join-Path $base 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $file = Join-Path $logs 'supervisor.log'
        if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 524288)) {
            Move-Item -LiteralPath $file -Destination ($file + '.1') -Force
        }
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        [System.IO.File]::AppendAllText($file, ($stamp + ' ' + $Level + ' launcher: ' + $Message + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Add-LauncherDiagnostic([string]$Kind, [string]$Severity, [string]$Detail) {
    # Uma linha na fila de diagnostico que o agente envia a API quando conecta (so ASCII, sem caminhos).
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $entry = @{ id = ([guid]::NewGuid().ToString()); at = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); kind = $Kind; severity = $Severity; component = 'launcher'; detail = $Detail }
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        [System.IO.File]::AppendAllText((Join-Path $runtimeDir 'diagnostics.jsonl'), ($serializer.Serialize($entry) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

# --- Baliza de partida (o mesmo bloco, igual, no lancador e no supervisor) ---------------------------------------------
# Um POST curto e anonimo para a API (`/api/v1/devices/agents/<slug>/beacon`) em cada marco da partida, para separar "o PC
# esta desligado" de "o agente nao sobe" e de "o PC nao alcanca o servidor" (a propria baliza falha). So estagio, codigo e
# versao: nenhum segredo, caminho ou nome. O endereco e o slug vem do config\agent.toml (api_url e agent_id); sem eles (ou com
# um endereco que nao seja https, salvo o do proprio PC) nada e enviado. Nunca atrasa nem derruba a partida: o POST roda num
# processo separado, oculto, que acaba sozinho (10 s de prazo), e qualquer falha aqui dentro e engolida. No maximo uma baliza
# por estagio+codigo a cada 10 minutos (arquivo `runtime\beacon.<estagio>.<codigo>` para valer entre processos; sem poder
# grava-lo vale a memoria deste processo). UNIOVER_BEACON_DISABLED=1 desliga.
$script:beaconSent = @{}

function Get-BeaconTarget {
    try {
        $file = Join-Path $base 'config\agent.toml'
        if (-not (Test-Path -LiteralPath $file)) { return $null }
        $text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
        $api = $null
        $slug = $null
        if ($text -match '(?m)^\s*api_url\s*=\s*"([^"\r\n]+)"') { $api = $Matches[1] }
        if ($text -match '(?m)^\s*agent_id\s*=\s*"([^"\r\n]+)"') { $slug = $Matches[1] }
        if (-not $api -or -not $slug) { return $null }
        if ($slug -notmatch '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$') { return $null }
        # So ASCII imprimivel (sem espaco nem aspas, inclusive as tipograficas): o endereco vai ao filho por variavel de ambiente,
        # nunca dentro do codigo dele, mas um endereco com caractere estranho nao e um endereco que a API usaria.
        if ($api -cmatch '[^!-~]' -or $api -match '[''"`]') { return $null }
        $uri = $null
        if (-not [System.Uri]::TryCreate($api, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
        if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) { return $null }
        $local = ($uri.Host -eq '127.0.0.1' -or $uri.Host -eq 'localhost')
        if (-not ($uri.Scheme -eq 'https' -or ($uri.Scheme -eq 'http' -and $local))) { return $null }
        return ($api.TrimEnd('/') + '/api/v1/devices/agents/' + $slug + '/beacon')
    } catch { return $null }
}

function Get-BeaconExitCode($Code) {
    # O codigo da baliza e [a-z][a-z0-9_]{1,31}: o numero de saida vira `exit_7` (e `exit_neg...` para os negativos do Windows).
    $number = 0
    if ($null -eq $Code -or -not [int]::TryParse([string]$Code, [ref]$number)) { return 'exit_unknown' }
    if ($number -lt 0) { return ('exit_neg' + [string][Math]::Abs([long]$number)) }
    return ('exit_' + $number)
}

# Devolve $true so quando o processo do POST foi iniciado ($false: desligada, sem destino, dentro da janela ou falha ao iniciar).
function Send-Beacon([string]$Stage, [string]$Code, [string]$Version = '', [bool]$IgnoreSpacing = $false) {
    try {
        if ([Environment]::GetEnvironmentVariable('UNIOVER_BEACON_DISABLED') -eq '1') { return $false }
        if ($Stage -notmatch '^[a-z][a-z0-9_]{1,31}$' -or $Code -notmatch '^[a-z][a-z0-9_]{1,31}$') { return $false }
        $spacing = 600.0
        $forced = 0.0
        if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_BEACON_MIN_INTERVAL_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forced) -and $forced -gt 0) { $spacing = $forced }
        $key = $Stage + '.' + $Code
        $now = [DateTime]::UtcNow
        if (-not $IgnoreSpacing -and $script:beaconSent.ContainsKey($key) -and ($now - $script:beaconSent[$key]).TotalSeconds -lt $spacing) { return $false }
        $stamp = Join-Path (Join-Path $base 'runtime') ('beacon.' + $key)
        if (-not $IgnoreSpacing) {
            try {
                $age = ($now - (Get-Item -LiteralPath $stamp -ErrorAction Stop).LastWriteTimeUtc).TotalSeconds
                if ($age -lt $spacing -and $age -gt (0 - $spacing)) { $script:beaconSent[$key] = $now; return $false }
            } catch { }
        }
        $target = Get-BeaconTarget
        if (-not $target) { return $false }
        $body = '{"v":1,"stage":"' + $Stage + '","code":"' + $Code + '"'
        if ($Version -match '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$') { $body += ',"ver":"' + $Version + '"' }
        $body += ',"os":"windows"}'
        # O codigo do filho e constante: endereco e corpo vao por variavel de ambiente (nada do config entra no codigo).
        $post = '$ProgressPreference = ''SilentlyContinue''; ' +
            'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }; ' +
            'try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri $env:UNIOVER_BEACON_URI -ContentType ''application/json'' -Body $env:UNIOVER_BEACON_BODY -TimeoutSec 10 | Out-Null } catch { }'
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = 'powershell.exe'
        $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($post))
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.EnvironmentVariables['UNIOVER_BEACON_URI'] = $target
        $info.EnvironmentVariables['UNIOVER_BEACON_BODY'] = $body
        $child = [System.Diagnostics.Process]::Start($info)
        if ($null -eq $child) { return $false }
        $child.Dispose()
        # So agora (o processo existe) a baliza conta como enviada: memoria e arquivo de estado.
        $script:beaconSent[$key] = $now
        try { [System.IO.File]::WriteAllText($stamp, 'x', [System.Text.Encoding]::ASCII) } catch { }
        return $true
    } catch { return $false }
}
# --- Fim da baliza de partida -------------------------------------------------------------------------------------------

function Set-RecoveryState([hashtable]$Changes) {
    # Mesmo arquivo e mesmo jeito do supervisor (runtime\update-status.json): junta ao que ja esta la. Nunca levanta erro.
    try {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        $path = Join-Path $runtimeDir 'update-status.json'
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $state = @{}
        if (Test-Path -LiteralPath $path) {
            try {
                $old = $serializer.DeserializeObject([System.IO.File]::ReadAllText($path))
                foreach ($name in $old.Keys) { $state[$name] = $old[$name] }
            } catch { $state = @{} }
        }
        foreach ($key in @($Changes.Keys)) {
            if ($null -eq $Changes[$key]) { [void]$state.Remove($key) } else { $state[$key] = $Changes[$key] }
        }
        $temp = $path + '.tmp'
        [System.IO.File]::WriteAllText($temp, $serializer.Serialize($state), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temp -Destination $path -Force
    } catch { }
}

function Move-Folder([string]$From, [string]$To) {
    # Renomeacao de verdade (Directory.Move): ou troca o nome inteiro ou falha sem tocar em nada. O Move-Item, quando ha um
    # arquivo aberto dentro da pasta, cai para copiar-e-apagar e deixa metade dos arquivos em cada lugar.
    [System.IO.Directory]::Move([System.IO.Path]::GetFullPath($From), [System.IO.Path]::GetFullPath($To))
}

function Restore-AppFolder {
    try {
        # Layout antigo (agent-src): a migracao feita pelo proprio agente cuida dele.
        if (Test-Path -LiteralPath (Join-Path $base 'agent-src')) { return }
        if (Test-AppFolder $appDir $false) { return }
        $appWasMissing = -not (Test-Path -LiteralPath $appDir)
        # A candidata so pode ser promovida quando app realmente sumiu: durante a escrita da candidata uma app
        # completa continua no lugar. Se sobrou uma app incompleta, a copia anterior e a opcao conservadora.
        if ($appWasMissing -and (Test-AppFolder $appNew $true)) { $from = $appNew; $kind = 'app.new' }
        elseif (Test-AppFolder $appPrevious $false) { $from = $appPrevious; $kind = 'app.previous' }
        else {
            if (-not $script:recoveryNoted) {
                $script:recoveryNoted = $true
                Write-LauncherLog 'a pasta app esta ausente ou incompleta e nao ha app.new nem app.previous para restaurar'
                Set-RecoveryState @{ outcome = 'failed'; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = 'a pasta do agente esta ausente ou incompleta e nao ha copia valida para restaurar' }
            }
            return
        }
        # A atualizacao conserva app ate a candidata estar validada e pronta para a troca; por isso so uma app
        # inteiramente valida interrompe a recuperacao. A candidata jamais e promovida quando qualquer app existe.
        if (Test-AppFolder $appDir $false) { return }
        $stamp = (Get-Date).ToString('yyyyMMddHHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
        $badSha = $null
        if (Test-Path -LiteralPath $appDir) {
            # Existe, mas incompleta: fica de lado (nunca e apagada) e a versao dela e bloqueada, para a atualizacao nao
            # trazer a mesma de volta a cada checagem.
            $badSha = Get-FolderVersion $appDir
            New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
            Move-Folder $appDir (Join-Path $runtimeDir ('app.incomplete-' + $stamp))
            if ($badSha) {
                try { Add-Content -LiteralPath (Join-Path $runtimeDir '.blocked-versions') -Value $badSha -Encoding ASCII } catch { }
            }
        }
        $sha = Get-FolderVersion $from
        $hadPrevious = ($kind -eq 'app.new') -and (Test-AppFolder $appPrevious $false)
        Move-Folder $from $appDir
        $trial = Join-Path $runtimeDir 'update-trial.txt'
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        if ($kind -eq 'app.new') {
            # A versao que acabou de ser promovida nunca rodou: fica em prova, com a anterior guardada para onde voltar.
            if ($hadPrevious) {
                try { [System.IO.File]::WriteAllText($trial, ($sha + '|0'), [System.Text.Encoding]::ASCII) } catch { }
            }
            Set-RecoveryState @{ outcome = 'updated'; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = $null; rolledBack = $null; blockedSha = $null }
            Write-LauncherLog ('a pasta app nao existia (queda no meio da troca da atualizacao); promovi app.new, versao ' + $sha.Substring(0, 12))
            Add-LauncherDiagnostic 'installation.restored' 'warn' 'a pasta do agente nao existia (queda no meio da atualizacao); a versao nova foi promovida'
        }
        else {
            Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
            $changes = @{ outcome = 'rolled_back'; rolledBack = $true; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = 'a pasta do agente estava ausente ou incompleta; restaurei a versao anterior' }
            if ($badSha) { $changes['blockedSha'] = $badSha }
            Set-RecoveryState $changes
            Write-LauncherLog 'a pasta app estava ausente ou incompleta; restaurei app.previous'
            Add-LauncherDiagnostic 'installation.restored' 'warn' 'a pasta do agente estava ausente ou incompleta; a versao anterior foi restaurada'
        }
        $script:recoveryNoted = $false
    } catch {
        Write-LauncherLog ('nao consegui restaurar a pasta app (' + $_.Exception.GetType().Name + ')')
    }
}

# Quanto tempo o supervisor pode ficar sem dar sinal de vida (runtime\supervisor-alive, que ele renova a cada poucos
# segundos, ate quando espera um filho) antes de o lancador o dar por travado. Nenhum supervisor sadio passa disto: toda
# espera dele tem prazo e da sinal enquanto espera. Os testes encurtam pela variavel; sem ela vale o de producao.
$staleSeconds = 900.0
$forced = 0.0
if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_STALE_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forced) -and $forced -gt 0) { $staleSeconds = $forced }
$staleCode = -9999
# Um supervisor de uma versao anterior (sem `Invoke-Bounded`/pulso durante a espera) bloqueia em `uv sync` e `self-update`
# por muitos minutos sem dar sinal: vigia-lo com os 15 min do novo mataria uma atualizacao lenta e legitima, em ciclo.
# Esse prazo maior so vale para ele; a variavel de teste de $staleSeconds vale para os dois, salvo a propria deste.
$legacyStaleSeconds = 2700.0
if ($forced -gt 0) { $legacyStaleSeconds = 0.0 }
$forcedLegacy = 0.0
if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_LEGACY_STALE_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forcedLegacy) -and $forcedLegacy -gt 0) { $legacyStaleSeconds = $forcedLegacy }
$staleRestarts = 0
$busyWait = 30.0
$forcedBusy = 0.0
if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_BUSY_WAIT_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forcedBusy) -and $forcedBusy -gt 0) { $busyWait = $forcedBusy }
$busySeenStamp = $null
# Suspensao/hibernacao: o relogio de parede salta de uma volta da vigia para a outra (que deveria levar $pollMs). O
# supervisor dormiu junto e o sinal dele parece velho de horas: depois de um salto assim o prazo recomeca do despertar.
$pollMs = 5000
$killWaitMs = 15000
$forcedWait = 0
if ([int]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_KILL_WAIT_MS'), [ref]$forcedWait) -and $forcedWait -gt 0) { $killWaitMs = $forcedWait }
$resumeGapSeconds = 60.0
$forcedGap = 0.0
if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_RESUME_GAP_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forcedGap) -and $forcedGap -gt 0) { $resumeGapSeconds = $forcedGap }
# Gancho de teste: "<apos s>:<salto s>" faz o relogio da vigia saltar uma vez, como uma suspensao.
$clockSkew = 0.0
$jumpAfter = -1.0
$jumpBy = 0.0
$jumpSpec = [Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_TEST_CLOCK_JUMP')
if ($jumpSpec -and $jumpSpec -match '^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$') {
    $jumpAfter = [double]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
    $jumpBy = [double]::Parse($Matches[2], [System.Globalization.CultureInfo]::InvariantCulture)
}

function Get-WatchNow {
    # UTC: no fim do horario de verao a hora local volta uma hora e o silencio do supervisor pareceria menor (ou maior).
    return [DateTime]::UtcNow.AddSeconds($script:clockSkew)
}

function Stop-SupervisorTree($Process) {
    # Encerra o supervisor e tudo que ele abriu e so diz que conseguiu se o processo saiu de fato (ate 3 tentativas).
    # Gancho de teste: UNIOVER_LAUNCHER_TEST_KILL_FAILS=1 finge que o encerramento nao funciona.
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        if ([Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_TEST_KILL_FAILS') -ne '1') { & taskkill.exe /PID $Process.Id /T /F *> $null }
        if ($Process.WaitForExit($killWaitMs)) { return $true }
    }
    return $false
}

function Invoke-Supervisor([string]$Script) {
    $alive = Join-Path $runtimeDir 'supervisor-alive'

    # Roda o supervisor e o VIGIA, em vez de so esperar por ele: um supervisor vivo mas travado (preso numa atualizacao, com
    # o disco cheio) deixava o lancador esperando para sempre e ninguem reiniciava o agente. Se o sinal de vida para por
    # mais de $staleSeconds, a arvore dele morre e devolve $staleCode. Um supervisor que acabou de subir tem o prazo
    # contado a partir da partida (o sinal velho de antes nao vale).
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'powershell.exe'
    $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Script + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($info)
    $startedAt = Get-WatchNow
    $limit = $staleSeconds
    $oldStyle = $true
    try { $oldStyle = -not (Select-String -LiteralPath $Script -SimpleMatch 'Invoke-Bounded' -Quiet -ErrorAction Stop) } catch { }
    if ($oldStyle -and $legacyStaleSeconds -gt $limit) { $limit = $legacyStaleSeconds }
    # Um script que nem sabe do `supervisor-alive` (um fallback ou legado de uma instalacao antiga) nunca o grava: o silencio
    # dele nao diz nada, e vigia-lo pelo pulso o mataria a cada prazo mesmo sadio. Esse e esperado como antes da vigia.
    # Troca consciente: se um desses travar de fato, volta a ser esperado sem prazo, como antes da vigia (e o autocuidado do
    # agente tambem nao o pega: ele procura o `app\tools\run-agent.ps1`). O preco e menor que o de mata-lo estando sadio.
    $writesPulse = $true
    try { $writesPulse = [bool](Select-String -LiteralPath $Script -Pattern 'supervisor-alive|Touch-Alive|Invoke-Bounded' -Quiet -ErrorAction Stop) } catch { }
    if (-not $writesPulse) { $limit = [double]::MaxValue }
    # O arquivo do pulso existe antes do supervisor subir: com o disco cheio o `Touch-Alive` dele so consegue mudar a data de
    # um arquivo que ja existe, e sem ele um supervisor sadio pareceria mudo.
    try { if (-not (Test-Path -LiteralPath $alive)) { New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null; [System.IO.File]::WriteAllText($alive, 'x', [System.Text.Encoding]::ASCII) } } catch { }
    $previous = $startedAt
    $resumedAt = $startedAt
    while (-not $process.WaitForExit($pollMs)) {
        $now = Get-WatchNow
        if ($jumpAfter -ge 0 -and ($now - $startedAt).TotalSeconds -ge $jumpAfter) {
            $script:clockSkew += $jumpBy
            $jumpAfter = -1.0
            $now = Get-WatchNow
        }
        if (($now - $previous).TotalSeconds -gt $resumeGapSeconds) {
            $resumedAt = $now
            Write-LauncherLog ('o relogio saltou ' + [int](($now - $previous).TotalSeconds) + ' s (suspensao do PC); o prazo do supervisor recomeca agora') 'INFO'
        }
        $previous = $now
        $last = $resumedAt
        try { $stamp = (Get-Item -LiteralPath $alive -ErrorAction Stop).LastWriteTimeUtc.AddSeconds($script:clockSkew); if ($stamp -gt $last) { $last = $stamp } } catch { }
        $silent = ($now - $last).TotalSeconds
        if ($silent -gt $limit) {
            Write-LauncherLog ('o supervisor esta vivo (pid ' + $process.Id + ') mas sem sinal ha ' + [int]$silent + ' s; vou reinicia-lo') 'ERROR'
            Add-LauncherDiagnostic 'supervisor.unresponsive' 'error' 'o supervisor travou (sem sinal de vida) e foi reiniciado pelo lancador'
            # So devolve (e o lancador so sobe outro supervisor) depois de CONFIRMAR que a arvore morreu: o supervisor novo
            # tem o proprio mutex e se recusa a rodar junto com um vivo, mas nem se tenta enquanto o antigo existir.
            if (Stop-SupervisorTree $process) { return $staleCode }
            Write-LauncherLog ('nao consegui encerrar o supervisor (pid ' + $process.Id + '); nao inicio outro e tento de novo mais tarde') 'ERROR'
            $resumedAt = Get-WatchNow
        }
    }
    return $process.ExitCode
}

# Primeiro marco: o lancador subiu (a tarefa agendada funcionou). Nao atrasa nada: o POST roda em outro processo.
$null = Send-Beacon 'bootstrap' 'ok' ([string](Get-FolderVersion $appDir))

while ($true) {
    Restore-AppFolder
    if (Test-Path -LiteralPath $current) {
        $started = Get-Date
        $code = $null
        try { $code = Invoke-Supervisor $current }
        catch { Write-LauncherLog ('nao consegui iniciar ou vigiar o supervisor (' + $_.Exception.GetType().Name + ')') }
        if ($code -eq 42) { Write-LauncherLog 'o supervisor pediu para reiniciar (versao nova ou volta atras)' 'INFO'; continue }
        if ($code -eq $staleCode) {
            # Sem recuo, um travamento que se repete (um passo da partida que nunca termina) reiniciaria sem parar: a espera
            # dobra a cada reinicio seguido (5, 10, 20 ... ate 5 min) e volta ao inicio quando um supervisor dura.
            $baseWait = 5.0
            $forcedBase = 0.0
            if ([double]::TryParse([string][Environment]::GetEnvironmentVariable('UNIOVER_LAUNCHER_RESTART_BASE_SECONDS'), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$forcedBase) -and $forcedBase -gt 0) { $baseWait = $forcedBase }
            $pause = [Math]::Min($baseWait * [Math]::Pow(2, $staleRestarts), 300.0)
            $staleRestarts++
            Write-LauncherLog ('novo supervisor em ' + [int]$pause + ' s (reinicio seguido numero ' + $staleRestarts + ')') 'INFO'
            $null = Send-Beacon 'supervisor' 'stale' ([string](Get-FolderVersion $appDir))
            Start-Sleep -Seconds $pause
            continue
        }
        if (((Get-Date) - $started).TotalSeconds -ge 600) { $staleRestarts = 0 }
        # Codigo 43: o supervisor novo encontrou outro vivo da mesma instalacao (o mutex dele). Nao e um supervisor ruim: espera
        # e tenta de novo, sem rodar o `run-agent.fallback.ps1` (uma copia antiga, possivelmente sem o mutex).
        # (Um lancador anterior a este, ainda em execucao, nao conhece o 43: cai no fallback, que nao tem o mutex. So vale ate
        # todas as maquinas reiniciarem o lancador; depende de existir um supervisor orfao, o que e raro.)
        if ($code -eq 43) {
            Write-LauncherLog 'ja ha um supervisor vivo desta instalacao; espero e tento de novo' 'INFO'
            # Esse supervisor sobrou da varredura da partida (o CIM falhou ou estourou). Se ele estiver travado, esperar para
            # sempre repetiria o incidente: com o pulso parado (o MESMO carimbo velho em duas voltas, o que descarta um PC que
            # acabou de acordar) a varredura e refeita.
            $stamp = $null
            try { $stamp = (Get-Item -LiteralPath (Join-Path $runtimeDir 'supervisor-alive') -ErrorAction Stop).LastWriteTimeUtc } catch { }
            $silentFor = [double]::MaxValue
            $stampKey = 'missing'
            if ($null -ne $stamp) { $silentFor = ([DateTime]::UtcNow - $stamp).TotalSeconds; $stampKey = [string]$stamp.Ticks }
            if ($silentFor -gt $staleSeconds -and $busySeenStamp -eq $stampKey) {
                Write-LauncherLog 'o supervisor que segura a instalacao esta sem sinal; refaco a varredura' 'ERROR'
                Add-LauncherDiagnostic 'supervisor.unresponsive' 'error' 'o supervisor que segurava a instalacao estava sem sinal; o lancador refez a varredura'
                Stop-Leftovers
                $busySeenStamp = $null
            }
            elseif ($silentFor -gt $staleSeconds) { $busySeenStamp = $stampKey }
            else { $busySeenStamp = $null }
            Start-Sleep -Seconds $busyWait
            continue
        }
        Write-LauncherLog ('o supervisor terminou (codigo ' + $code + ') depois de ' + [int]((Get-Date) - $started).TotalSeconds + ' s')
        $null = Send-Beacon 'supervisor' (Get-BeaconExitCode $code) ([string](Get-FolderVersion $appDir))
        if (((Get-Date) - $started).TotalSeconds -ge 30) { Start-Sleep -Seconds 5; continue }
    }
    # Durante a primeira migracao, a tarefa ja aponta para este lancador antes de `agent-src`
    # virar `app`. A queda nesse intervalo ainda pode iniciar o supervisor antigo.
    # O legado e o fallback tambem rodam sob a vigia: um que trava sem dar sinal repetiria o incidente (e o antigo, sem pulso,
    # tem o prazo maior de supervisor anterior).
    if (Test-Path -LiteralPath $legacy) {
        try { [void](Invoke-Supervisor $legacy) } catch { Write-LauncherLog ('nao consegui vigiar o supervisor legado (' + $_.Exception.GetType().Name + ')') }
        Start-Sleep -Seconds 5
        continue
    }
    if (Test-Path -LiteralPath $fallback) {
        try { [void](Invoke-Supervisor $fallback) } catch { Write-LauncherLog ('nao consegui vigiar o fallback (' + $_.Exception.GetType().Name + ')') }
    }
    elseif (-not (Test-Path -LiteralPath $current)) { $null = Send-Beacon 'bootstrap' 'no_app' }
    Start-Sleep -Seconds 30
}
