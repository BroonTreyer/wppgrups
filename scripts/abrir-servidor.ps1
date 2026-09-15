# Abre a tela do Chrome do servidor (VNC) para resolver CAPTCHA ou mexer na extensao.
# O VNC so escuta em 127.0.0.1 no servidor: o acesso passa por um tunel SSH.
$ErrorActionPreference = "Stop"
$servidor = "root@2.28.102.201"
$portaLocal = 5911
$viewer = "C:\Program Files\TigerVNC\vncviewer.exe"

function Avisar($texto) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($texto, "OfertaFlow - Servidor") | Out-Null
}

if (-not (Test-Path $viewer)) { Avisar "TigerVNC nao encontrado em $viewer"; exit 1 }

function PortaAberta {
    (Test-NetConnection 127.0.0.1 -Port $portaLocal -WarningAction SilentlyContinue).TcpTestSucceeded
}

# Reaproveita um tunel que ja esteja aberto; senao cria um so para esta sessao.
$tunel = $null
if (-not (PortaAberta)) {
    $tunel = Start-Process ssh -WindowStyle Hidden -PassThru -ArgumentList `
        "-o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -N -L ${portaLocal}:127.0.0.1:5901 $servidor"
    $limite = (Get-Date).AddSeconds(20)
    while (-not (PortaAberta)) {
        if ($tunel.HasExited -or (Get-Date) -gt $limite) {
            Avisar "Nao consegui conectar no servidor. Confira a internet e tente de novo."
            if (-not $tunel.HasExited) { Stop-Process -Id $tunel.Id -Force }
            exit 1
        }
        Start-Sleep -Milliseconds 500
    }
}

Start-Process $viewer -ArgumentList "localhost::$portaLocal" -Wait

# Fechou o visualizador: fecha o tunel que este script abriu.
if ($tunel -and -not $tunel.HasExited) { Stop-Process -Id $tunel.Id -Force }
