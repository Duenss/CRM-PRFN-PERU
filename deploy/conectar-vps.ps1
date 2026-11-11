# =====================================================================
#  Conectar la VPS de Contabo con Coolify (autoriza la public key)
#  Uso:
#    1. Edita las 3 variables de abajo (o déjalas vacías y el script
#       te las pide de forma segura).
#    2. Ejecuta:  powershell -ExecutionPolicy Bypass -File .\deploy\conectar-vps.ps1
#    3. Cuando termine, en Coolify pega la PRIVATE KEY y pulsa Continue.
# =====================================================================

$VpsIp           = "62.171.182.130"
$RootPassword    = ""   # <-- tu contraseña root de Contabo (o Enter y te la pide)
$CoolifyPublicKey = ""  # <-- public key de Coolify (ssh-rsa/ssh-ed25519...)

# ---------------------------------------------------------------------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Pedir-Password {
  $sec = Read-Host "Contraseña root de $VpsIp" -AsSecureString
  if (-not $sec) { throw "Contraseña vacía." }
  [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

function Manual($key) {
  Write-Host ""
  Write-Host "No pude usar Posh-SSH. Hazlo manualmente:" -ForegroundColor Yellow
  Write-Host "  1) ssh root@$VpsIp"
  Write-Host "  2) dentro del VPS ejecuta:"
  Write-Host "     mkdir -p /root/.ssh"
  Write-Host "     echo '$key' >> /root/.ssh/authorized_keys"
  Write-Host "     chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys"
  Write-Host "     cat /root/.ssh/authorized_keys"
  Write-Host "  3) vuelve a Coolify, pega la private key y Continue."
}

if (-not $RootPassword) { $RootPassword = Pedir-Password }
if (-not $CoolifyPublicKey -or $CoolifyPublicKey -notmatch '^ssh-(rsa|ed25519)\s') {
  $CoolifyPublicKey = Read-Host "Pega la PUBLIC KEY de Coolify"
}
$key = $CoolifyPublicKey.Trim()
if ($key -notmatch '^ssh-(rsa|ed25519)\s') {
  Write-Host "La public key no parece válida (debe empezar con ssh-rsa o ssh-ed25519)." -ForegroundColor Red
  exit 1
}

Write-Host "`n==> Conectando a $VpsIp ..." -ForegroundColor Cyan

try {
  if (-not (Get-Module -ListAvailable -Name Posh-SSH)) {
    Write-Host "Instalando módulo Posh-SSH (solo la primera vez)..." -ForegroundColor Yellow
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    Install-Module Posh-SSH -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
  }
  Import-Module Posh-SSH -ErrorAction Stop

  $cred = New-Object System.Management.Automation.PSCredential(
    'root', (ConvertTo-SecureString $RootPassword -AsPlainText -Force))
  $session = New-SSHSession -ComputerName $VpsIp -Credential $cred -AcceptKey -ConnectionTimeout 25

  $comando = @"
set -e
mkdir -p /root/.ssh
grep -qxF '$key' /root/.ssh/authorized_keys 2>/dev/null || echo '$key' >> /root/.ssh/authorized_keys
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys
echo '--- authorized_keys ---'
cat /root/.ssh/authorized_keys
echo '--- sistema ---'
lsb_release -ds 2>/dev/null || true
free -h | head -2
df -h / | tail -1
"@

  $res = Invoke-SSHCommand -SessionId $session.SessionId -Command $comando -TimeOut 40
  $res.Output | ForEach-Object { Write-Host $_ }

  Remove-SSHSession -SessionId $session.SessionId | Out-Null

  if ($res.ExitStatus -eq 0) {
    Write-Host "`n✅ Public key autorizada correctamente en la VPS." -ForegroundColor Green
    Write-Host "   Ahora en Coolify: pega la PRIVATE KEY y pulsa Continue/Validate." -ForegroundColor Green
  } else {
    Write-Host "`nLa conexión funcionó pero el comando devolvió error (código $($res.ExitStatus))." -ForegroundColor Yellow
    Manual $key
  }
}
catch {
  Write-Host "`nNo se pudo conectar por SSH: $($_.Exception.Message)" -ForegroundColor Red
  Manual $key
}
