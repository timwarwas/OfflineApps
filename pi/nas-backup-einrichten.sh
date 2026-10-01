#!/bin/bash
# Tägliche Sicherung des Pi auf das FRITZ!Box-NAS einrichten.
# Vorher in der FRITZ!Box: Speicher (NAS) an, Benutzer mit NAS-Rechten (lesen + schreiben) anlegen.
# Aufruf in Termius:
#   curl -fsSL https://timwarwas.github.io/OfflineApps/pi/nas-backup-einrichten.sh -o nas.sh && sudo bash nas.sh
# Das Passwort wird abgefragt und nur auf dem Pi gespeichert (/etc/fritznas.cred, nur root lesbar).
set -euo pipefail
BASE="${BASE:-https://timwarwas.github.io/OfflineApps/pi}"
FRITZ="${FRITZ:-192.168.178.1}"
MNT=/mnt/fritznas
[ "$(id -u)" = 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
exec 3</dev/tty

echo "== Pakete"
command -v mount.cifs >/dev/null && command -v sqlite3 >/dev/null || { apt-get update && apt-get install -y cifs-utils sqlite3; }

echo "== Zugang zur FRITZ!Box ($FRITZ)"
read -r -u 3 -p "FRITZ!Box-Benutzer [pi-backup]: " USERN; USERN=${USERN:-pi-backup}
read -r -s -u 3 -p "Passwort: " PASS; echo
umask 077
printf 'username=%s\npassword=%s\n' "$USERN" "$PASS" > /etc/fritznas.cred
chmod 600 /etc/fritznas.cred
unset PASS

echo "== Verbindung testen"
mkdir -p "$MNT"
systemctl stop mnt-fritznas.automount mnt-fritznas.mount 2>/dev/null || true
umount "$MNT" 2>/dev/null || true
VERS=
for v in 3.0 2.1 2.0; do
  if mount -t cifs "//$FRITZ/FRITZ.NAS" "$MNT" -o "credentials=/etc/fritznas.cred,vers=$v,uid=0,gid=0,file_mode=0600,dir_mode=0700" 2>/dev/null; then VERS=$v; break; fi
done
[ -n "$VERS" ] || { echo "Anmeldung am NAS fehlgeschlagen. Benutzer/Passwort, NAS-Recht und „Speicher (NAS) aktiv“ in der FRITZ!Box prüfen."; exit 1; }
echo "Verbunden (SMB $VERS). Inhalt von FRITZ.NAS:"
mapfile -t ORDNER < <(find "$MNT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
i=1; for o in "${ORDNER[@]}"; do echo "  $i) $o"; i=$((i + 1)); done
read -r -u 3 -p "Auf welchem Speicher sichern? Nummer [1]: " N; N=${N:-1}
SPEICHER=${ORDNER[$((N - 1))]:-}
[ -n "$SPEICHER" ] || { echo "Ungültige Auswahl."; umount "$MNT"; exit 1; }
ZIEL="$MNT/$SPEICHER/pi-backup"
mkdir -p "$ZIEL" && touch "$ZIEL/.schreibtest" && rm -f "$ZIEL/.schreibtest" || { echo "Kein Schreibrecht – in der FRITZ!Box beim Benutzer „Zugang zu NAS-Inhalten“ mit Schreibrecht setzen."; umount "$MNT"; exit 1; }
umount "$MNT"

echo "== Dauerhaft einbinden (bei Bedarf, nach 60 s wieder getrennt)"
sed -i '\#[[:space:]]/mnt/fritznas[[:space:]]#d' /etc/fstab
echo "//$FRITZ/FRITZ.NAS $MNT cifs credentials=/etc/fritznas.cred,vers=$VERS,uid=0,gid=0,file_mode=0600,dir_mode=0700,noauto,x-systemd.automount,x-systemd.idle-timeout=60,_netdev,nofail 0 0" >> /etc/fstab
systemctl daemon-reload
systemctl restart mnt-fritznas.automount
ls "$ZIEL" >/dev/null

echo "== Einstellungen und Sicherungsprogramm"
cat > /etc/pb-nas-backup.conf <<EOF
# Ziel auf dem FRITZ!Box-NAS und Anzahl der aufbewahrten Sicherungen
ZIEL="$ZIEL"
BEHALTEN=30
PB_DATA=/opt/pocketbase/pb_data
PUSH_DATA=/var/lib/push-dienst
EOF
curl -fsSL "$BASE/pb-nas-backup.sh?$(date +%s)" -o /usr/local/bin/pb-nas-backup.sh
bash -n /usr/local/bin/pb-nas-backup.sh
chmod 755 /usr/local/bin/pb-nas-backup.sh

echo "== Täglich um 03:30"
cat > /etc/systemd/system/pb-nas-backup.service <<'EOF'
[Unit]
Description=Sicherung PocketBase auf FRITZ!Box-NAS
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pb-nas-backup.sh
Nice=10
IOSchedulingClass=idle
EOF
cat > /etc/systemd/system/pb-nas-backup.timer <<'EOF'
[Unit]
Description=Tägliche NAS-Sicherung

[Timer]
OnCalendar=*-*-* 03:30
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now pb-nas-backup.timer

echo "== Erste Sicherung jetzt"
if systemctl start pb-nas-backup.service; then
  journalctl -u pb-nas-backup -n 3 --no-pager -o cat
  echo "Fertig. Nächster Lauf:"; systemctl list-timers pb-nas-backup.timer --no-pager | sed -n 2p
else
  echo "Sicherung fehlgeschlagen:"; journalctl -u pb-nas-backup -n 20 --no-pager -o cat; exit 1
fi
