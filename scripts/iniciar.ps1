# Sobe o OfertaFlow destacado do terminal, uma instancia so.
#
# Existe porque o bot nao voltava sozinho depois de reiniciar o PC: em 09 e 10/09/2026
# o sistema ficou horas fora do ar sem que nada avisasse, e o sintoma que chegava ao
# dono era "o sistema nao esta publicando".
$projeto = Split-Path -Parent $PSScriptRoot
Set-Location $projeto

# Ja esta de pe? Nao sobe outra: duas instancias gravando o mesmo store.json
# disputam o arquivo e uma sobrescreve a outra.
$emUso = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($emUso) {
  Write-Output "OfertaFlow ja esta rodando (pid $($emUso[0].OwningProcess))."
  exit 0
}

# Tem que ser o node.exe de verdade. `Get-Command node` chamado a partir do Git
# Bash devolve o shim em ~\bin\node, que e um script shell — Start-Process tenta
# executa-lo como binario e morre com "nao e um aplicativo Win32 valido".
$node = (Get-Command node.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -like "*.exe" } | Select-Object -First 1).Source
if (-not $node) {
  $node = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS*\*\node.exe" -ErrorAction SilentlyContinue |
          Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) { Write-Output "node.exe nao encontrado."; exit 1 }

Start-Process -FilePath $node `
  -ArgumentList '--env-file-if-exists=.env', 'src/index.js' `
  -WorkingDirectory $projeto -WindowStyle Hidden `
  -RedirectStandardOutput "$projeto\data\bot.log" `
  -RedirectStandardError "$projeto\data\bot.err"

Start-Sleep -Seconds 4
$subiu = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($subiu) { Write-Output "OfertaFlow no ar em http://localhost:3000" }
else { Write-Output "FALHOU. Veja data\bot.err"; Get-Content "$projeto\data\bot.err" -Tail 15 -ErrorAction SilentlyContinue }
