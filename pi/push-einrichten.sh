#!/bin/bash
# Push-Dienst der Anwendungssammlung auf dem Pi einrichten oder aktualisieren.
# Aufruf in Termius:
#   curl -fsSL https://timwarwas.github.io/OfflineApps/pi/push-einrichten.sh | sudo bash
# Enthält keine Geheimnisse: Die VAPID-Schlüssel erzeugt der Dienst beim ersten Start selbst
# (/var/lib/push-dienst/vapid.json, nur für den Benutzer „push“ lesbar).
set -euo pipefail
BASE="${BASE:-https://timwarwas.github.io/OfflineApps/pi}"
DIR=/opt/push-dienst
DATA=/var/lib/push-dienst

[ "$(id -u)" = 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
echo "== Node.js prüfen"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  apt-get update && apt-get install -y nodejs
fi
node --version

echo "== Benutzer und Ordner"
id push >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin push
install -d -m 755 "$DIR"
install -d -o push -g push -m 700 "$DATA"

echo "== Programm laden"
for f in push-dienst.js webpush.js; do
  curl -fsSL "$BASE/$f?$(date +%s)" -o "$DIR/neu-$f"   # Endung .js behalten, sonst lehnt node --check ab
  node --check "$DIR/neu-$f"
  mv "$DIR/neu-$f" "$DIR/$f"
done
rm -f "$DIR"/*.neu   # Reste einer älteren Skriptfassung
chmod 644 "$DIR"/*.js

echo "== Dienst einrichten"
cat > /etc/systemd/system/push-dienst.service <<'EOF'
[Unit]
Description=Push-Dienst der Anwendungssammlung
After=network-online.target
Wants=network-online.target

[Service]
User=push
Group=push
Environment=PUSH_DIR=/var/lib/push-dienst
Environment=PUSH_PORT=8091
Environment=PUSH_ORIGIN=https://timwarwas.github.io
ExecStart=/usr/bin/env node /opt/push-dienst/push-dienst.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/push-dienst

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable push-dienst >/dev/null
systemctl restart push-dienst

echo "== Lokal testen"
ok=
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8091/health 2>/dev/null; then ok=1; echo; break; fi
  sleep 1
done
[ -n "$ok" ] || { echo "Dienst antwortet nicht:"; journalctl -u push-dienst -n 20 --no-pager; exit 1; }

echo "== Über den Funnel freigeben (/push → Port 8091, PocketBase bleibt auf /)"
tailscale funnel --bg --set-path=/push http://127.0.0.1:8091
tailscale funnel status || true

HOST=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)
if [ -n "$HOST" ]; then
  echo "== Von außen testen: https://$HOST/push/health"
  sleep 2
  curl -fsS "https://$HOST/push/health" && echo || echo "(Von außen noch nicht erreichbar – in einer Minute nochmal im Browser öffnen.)"
fi
echo "Fertig. Jetzt am iPhone: Hauptmenü → Mitteilungen → Einschalten → Testmitteilung."
