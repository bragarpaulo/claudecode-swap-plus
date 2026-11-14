# Instala o Swap Plus neste Windows: o motor (comando swap-plus) e a extensão
# do VS Code, a partir das releases dos forks no GitHub. Não precisa clonar nada
# nem abrir o PowerShell como administrador.
#
#   irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
#
# Rodar de novo reinstala as versões mais novas. Depois de instalado, a própria
# extensão se atualiza ao abrir e ao fechar o VS Code.
#
# Só simular (mostra o que faria, sem instalar):
#   $env:SWAP_PLUS_DRY_RUN = "1"; irm <o mesmo link> | iex; Remove-Item Env:SWAP_PLUS_DRY_RUN

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # downloads bem mais rápidos no Windows PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$CliRepo = "bragarpaulo/swap-plus"
$ExtRepo = "bragarpaulo/swap-plus-vscode"
$DryRun = $env:SWAP_PLUS_DRY_RUN -eq "1"
$Headers = @{ "User-Agent" = "swap-plus-install"; "Accept" = "application/vnd.github+json" }

function Say([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host ""; Write-Host "ERRO: $Text" -ForegroundColor Red; throw $Text }

# Programas externos (uv, code) às vezes escrevem avisos no canal de erro. No
# Windows PowerShell 5.1, com ErrorActionPreference = Stop, isso derrubaria o
# script mesmo com o comando dando certo. O resultado vale pelo $LASTEXITCODE.
function Invoke-Native([scriptblock]$Block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $Block } finally { $ErrorActionPreference = $old }
}

# Primeiro arquivo de release plus-vX.Y.Z cujo nome bate com $Pattern. A API
# lista as releases da mais nova para a mais antiga.
function Get-LatestAsset([string]$Repo, [string]$Pattern) {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=20" -Headers $Headers
  foreach ($r in $releases) {
    if ($r.draft -or $r.prerelease -or ($r.tag_name -notmatch '^plus-v\d+\.\d+\.\d+$')) { continue }
    foreach ($a in $r.assets) {
      if ($a.name -match $Pattern) { return $a.browser_download_url }
    }
  }
  return $null
}

# Onde o uv e as ferramentas dele ficam no Windows.
$env:Path = "$HOME\.local\bin;$HOME\.cargo\bin;$env:Path"

# ------------------------------------------------------------------ uv
Say "uv (gerenciador que instala o motor)"
if (Get-Command uv -ErrorAction SilentlyContinue) {
  Write-Host "    já instalado: $(Invoke-Native { uv --version })"
} else {
  Write-Host "    não encontrado; instalando pelo instalador oficial (https://astral.sh/uv)"
  if ($DryRun) {
    Write-Host "    (simulação) irm https://astral.sh/uv/install.ps1 | iex"
  } else {
    Invoke-Native { powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex" }
    $env:Path = "$HOME\.local\bin;$HOME\.cargo\bin;$env:Path"
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
      Fail "o uv não ficou disponível. Feche e abra o PowerShell e rode este comando de novo."
    }
  }
}

# ------------------------------------------------------------------ motor
Say "Motor (swap-plus)"
$Wheel = Get-LatestAsset $CliRepo '\.whl$'
if (-not $Wheel) { Fail "não achei a release do motor em https://github.com/$CliRepo/releases" }
Write-Host "    $Wheel"
if ($DryRun) {
  Write-Host "    (simulação) uv tool install --force --reinstall $Wheel"
  Write-Host "    (simulação) uv tool update-shell"
} else {
  Invoke-Native { uv tool install --force --reinstall $Wheel }
  if ($LASTEXITCODE -ne 0) { Fail "a instalação do motor falhou (uv tool install)." }
  # Deixa o comando swap-plus disponível nos próximos terminais.
  Invoke-Native { uv tool update-shell 2>$null | Out-Null }
  Invoke-Native { & "$HOME\.local\bin\swap-plus.exe" --version }
  if ($LASTEXITCODE -ne 0) { Fail "o comando swap-plus não ficou disponível." }
}

# ------------------------------------------------------------------ extensão
Say "Extensão Swap Plus (VS Code)"
$Code = $null
$Candidates = @(
  (Get-Command code -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
  "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
  "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd"
)
foreach ($c in $Candidates) {
  if ($c -and (Test-Path $c)) { $Code = $c; break }
}
if (-not $Code) {
  Write-Host "    VS Code não encontrado. Instale o VS Code (https://code.visualstudio.com) e rode este comando de novo."
} else {
  $VsixUrl = Get-LatestAsset $ExtRepo '\.vsix$'
  if (-not $VsixUrl) { Fail "não achei a release da extensão em https://github.com/$ExtRepo/releases" }
  Write-Host "    $VsixUrl"
  $Tmp = Join-Path $env:TEMP "swap-plus.vsix"
  if ($DryRun) {
    Write-Host "    (simulação) baixar para $Tmp"
    Write-Host "    (simulação) `"$Code`" --install-extension `"$Tmp`" --force"
  } else {
    Invoke-WebRequest -Uri $VsixUrl -OutFile $Tmp -UseBasicParsing
    Invoke-Native { & $Code --install-extension $Tmp --force }
    if ($LASTEXITCODE -ne 0) { Fail "o VS Code não instalou a extensão." }
    Remove-Item $Tmp -ErrorAction SilentlyContinue
  }
  # A extensão original mostraria uma segunda barra de status.
  $Installed = Invoke-Native { & $Code --list-extensions 2>$null }
  if ($Installed -match '^smith89k\.claude-swap-status$') {
    Write-Host "    removendo a extensão original (smith89k.claude-swap-status)"
    if (-not $DryRun) { Invoke-Native { & $Code --uninstall-extension smith89k.claude-swap-status } }
  }
}

Say "Pronto"
Write-Host "    1. Feche e abra o VS Code (ou Ctrl+Shift+P > `"Developer: Reload Window`")."
Write-Host "    2. Para trazer as contas do outro computador: clique na barra do Swap Plus"
Write-Host "       (embaixo, à esquerda) > Configurações > Importar contas..."
Write-Host "       Ou, para logar uma conta aqui: swap-plus add"
