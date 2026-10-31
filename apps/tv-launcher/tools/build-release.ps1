# Monta o APK de release do launcher da TV assinado com a chave fixa do projeto e confere o certificado.
# A chave (uniover-tv.p12 e senha.txt) fica em <repositório principal>\.secrets\tv-launcher, fora do git.
# Uso: pwsh -NoProfile -File apps/tv-launcher/tools/build-release.ps1 [-SecretsDir <pasta>] [-Destino <pasta>]
param(
  [string]$SecretsDir,
  [string]$Destino
)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot

if (-not $SecretsDir) {
  # Funciona também numa worktree: o diretório comum do git é o .git do repositório principal.
  $common = (& git -C $app rev-parse --path-format=absolute --git-common-dir).Trim()
  $SecretsDir = Join-Path (Split-Path -Parent $common) '.secrets\tv-launcher'
}
$store = Join-Path $SecretsDir 'uniover-tv.p12'
$passFile = Join-Path $SecretsDir 'senha.txt'
foreach ($f in @($store, $passFile)) {
  if (-not (Test-Path $f)) { throw "Falta $f. Restaure o backup (Documents\UniOver-chaves\restaurar-tv-launcher.ps1)." }
}
$password = [IO.File]::ReadAllText($passFile).Trim()

# Pelas variáveis de ambiente (o gradle as lê): a senha nunca aparece na linha de comando.
$env:UNIOVER_TV_STORE_FILE = $store
$env:UNIOVER_TV_STORE_PASSWORD = $password
$env:UNIOVER_TV_KEY_ALIAS = 'uniover-tv'
$env:UNIOVER_TV_KEY_PASSWORD = $password

try {
  Push-Location $app
  & .\gradlew.bat --no-daemon assembleRelease
  if ($LASTEXITCODE -ne 0) { throw "assembleRelease falhou ($LASTEXITCODE)" }
} finally {
  Pop-Location
  Remove-Item Env:UNIOVER_TV_STORE_PASSWORD, Env:UNIOVER_TV_KEY_PASSWORD, Env:UNIOVER_TV_STORE_FILE, Env:UNIOVER_TV_KEY_ALIAS -ErrorAction SilentlyContinue
}

$apk = Join-Path $app 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "APK não encontrado: $apk" }

# Confere que o certificado é o da chave do projeto (SHA-256 público em signing-cert.sha256).
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$apksigner = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory | Sort-Object { [version]($_.Name -replace '[^0-9.].*$','') } -Descending |
  ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $apksigner) { throw "apksigner não encontrado em $sdk\build-tools" }
$out = & $apksigner verify --print-certs $apk
if ($LASTEXITCODE -ne 0) { throw 'apksigner verify falhou' }
$line = $out | Where-Object { $_ -match 'certificate SHA-256 digest' } | Select-Object -First 1
$got = ($line -replace '.*digest:\s*', '').Trim().ToLower()
$want = (Get-Content (Join-Path $app 'signing-cert.sha256') -Raw).Trim().ToLower()
if ($got -ne $want) { throw "Certificado diferente do esperado. Esperado $want, veio $got" }
Write-Host "Assinatura confere (SHA-256 $got)"

if ($Destino) {
  New-Item -ItemType Directory -Force $Destino | Out-Null
  Copy-Item $apk (Join-Path $Destino 'uniover-launcher.apk') -Force
  Write-Host "APK copiado para $Destino\uniover-launcher.apk"
}
Write-Host "APK: $apk"
