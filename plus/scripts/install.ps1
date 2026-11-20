# Instala a extensão Swap Plus no VS Code deste Windows, a partir da release mais nova
# do GitHub. Não precisa clonar nada nem abrir o PowerShell como administrador.
#
#   irm https://raw.githubusercontent.com/bragarpaulo/claudecode-swap-plus/main/plus/scripts/install.ps1 | iex
#
# Rodar de novo reinstala a versão mais nova. Depois de instalada, a própria extensão
# se atualiza ao abrir e ao fechar o VS Code.
#
# A partir da 3.0 o Swap Plus é só a extensão + o servidor. O motor antigo das versões
# 1.x e 2.x (o comando swap-plus, instalado pelo uv) não é mais usado: se ele estiver
# neste Windows, este script o remove.
#
# Só simular (mostra o que faria, sem instalar nem remover nada):
#   $env:SWAP_PLUS_DRY_RUN = "1"; irm <o mesmo link> | iex; Remove-Item Env:SWAP_PLUS_DRY_RUN

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # downloads bem mais rápidos no Windows PowerShell 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$ExtRepo = "bragarpaulo/claudecode-swap-plus"
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

# Tag da release mais nova (plus-vX.Y.Z) pelo link /releases/latest do GitHub,
# que redireciona para ela. Não usa a API, que tem limite de consultas por hora.
function Get-LatestTag([string]$Repo) {
  try {
    $req = [System.Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
    $req.AllowAutoRedirect = $false
    $req.Method = "HEAD"
    $req.UserAgent = "swap-plus-install"
    $resp = $req.GetResponse()
    $loc = $resp.Headers["Location"]
    $resp.Close()
    if ($loc -match '/releases/tag/(plus-v\d+\.\d+\.\d+)$') { return $Matches[1] }
  } catch {}
  return $null
}

# Reserva: primeiro arquivo de release plus-vX.Y.Z cujo nome bate com $Pattern,
# pela API (lista as releases da mais nova para a mais antiga).
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
if (-not $Code) { Fail "VS Code não encontrado. Instale o VS Code (https://code.visualstudio.com) e rode este comando de novo." }
Write-Host "    VS Code: $Code"

$ExtTag = Get-LatestTag $ExtRepo
if ($ExtTag) {
  $VsixUrl = "https://github.com/$ExtRepo/releases/download/$ExtTag/swap-plus.vsix"
} else {
  $VsixUrl = Get-LatestAsset $ExtRepo '\.vsix$'
}
if (-not $VsixUrl) { Fail "não achei a release da extensão em https://github.com/$ExtRepo/releases" }
Write-Host "    $VsixUrl"

$Tmp = Join-Path $env:TEMP "swap-plus.vsix"
if ($DryRun) {
  Write-Host "    (simulação) baixar para $Tmp"
  Write-Host "    (simulação) `"$Code`" --install-extension `"$Tmp`" --force"
} else {
  try {
    Invoke-WebRequest -Uri $VsixUrl -OutFile $Tmp -UseBasicParsing
  } catch {
    Fail "não consegui baixar a extensão ($($_.Exception.Message))."
  }
  Invoke-Native { & $Code --install-extension $Tmp --force }
  if ($LASTEXITCODE -ne 0) { Fail "o VS Code não instalou a extensão." }
  Remove-Item $Tmp -ErrorAction SilentlyContinue
}

$Exts = @(Invoke-Native { & $Code --list-extensions --show-versions 2>$null })
if (-not $DryRun) {
  $Mine = @($Exts | Where-Object { "$_" -match '^paulo-local\.swap-plus@' })
  if ($Mine.Count -gt 0) { Write-Host "    instalada: $($Mine[0])" }
}
# A extensão original (de onde o Swap Plus começou) mostraria uma segunda barra de status.
if (@($Exts | Where-Object { "$_" -match '^smith89k\.claude-swap-status@' }).Count -gt 0) {
  Write-Host "    removendo a extensão original (smith89k.claude-swap-status)"
  if ($DryRun) {
    Write-Host "    (simulação) `"$Code`" --uninstall-extension smith89k.claude-swap-status"
  } else {
    Invoke-Native { & $Code --uninstall-extension smith89k.claude-swap-status }
    if ($LASTEXITCODE -ne 0) { Write-Host "    (não consegui remover; desinstale pela aba Extensões do VS Code)" }
  }
}

# ------------------------------------------------------------------ motor antigo
# O motor das versões 1.x e 2.x é o pacote do uv que traz o comando swap-plus
# (o pacote se chama claude-swap). Acha pelo comando, não pelo nome, para não
# mexer num claude-swap instalado por outro motivo. Nada aqui faz o script falhar.
Say "Motor antigo (comando swap-plus)"
# Onde o uv e as ferramentas dele ficam no Windows.
$env:Path = "$HOME\.local\bin;$HOME\.cargo\bin;$env:Path"
$OldCmd = Get-Command swap-plus -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (Get-Command uv -ErrorAction SilentlyContinue) {
  $Pkgs = @()
  $Pkg = $null
  foreach ($line in @(Invoke-Native { uv tool list 2>$null })) {
    $l = "$line"
    if ($l -match '^- (\S+)') {
      # No Windows o uv lista o comando como "swap-plus.exe".
      if (($Matches[1] -eq "swap-plus" -or $Matches[1] -eq "swap-plus.exe") -and $Pkg) { $Pkgs += $Pkg }
    } elseif ($l -match '^([A-Za-z0-9][A-Za-z0-9._-]*)') {
      $Pkg = $Matches[1]
      if ($Pkg -eq "swap-plus") { $Pkgs += $Pkg }
    }
  }
  $Pkgs = @($Pkgs | Select-Object -Unique)
  if ($Pkgs.Count -gt 0) {
    foreach ($p in $Pkgs) {
      Write-Host "    o Swap Plus 3.0 não usa mais o motor: removendo (uv tool uninstall $p)"
      if ($DryRun) {
        Write-Host "    (simulação) uv tool uninstall $p"
      } else {
        $Out = @(Invoke-Native { uv tool uninstall $p 2>&1 })
        $Rc = $LASTEXITCODE
        foreach ($o in $Out) { if ("$o".Trim()) { Write-Host "    $o" } }
        if ($Rc -ne 0) { Write-Host "    (não consegui remover; siga em frente: a extensão não usa o motor)" }
      }
    }
  } elseif ($OldCmd) {
    Write-Host "    o comando swap-plus existe ($OldCmd), mas não foi instalado pelo uv; não mexi nele."
  } else {
    Write-Host "    não está instalado (nada a remover)."
  }
} elseif ($OldCmd) {
  Write-Host "    o comando swap-plus existe ($OldCmd), mas o uv não foi encontrado; não mexi nele."
} else {
  Write-Host "    não está instalado (nada a remover)."
}

Say "Pronto. Abra o VS Code, clique no Swap Plus na barra de baixo > Configurações... > Entrar com Google."
Write-Host "    (Se o VS Code já estava aberto, feche e abra de novo.)"
