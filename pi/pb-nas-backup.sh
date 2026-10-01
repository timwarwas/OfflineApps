#!/bin/bash
# Tägliche Sicherung von PocketBase (und Push-Dienst) auf das FRITZ!Box-NAS.
# Einstellungen: /etc/pb-nas-backup.conf  ·  Protokoll: journalctl -u pb-nas-backup -n 20
set -euo pipefail
CONF=${CONF:-/etc/pb-nas-backup.conf}
ZIEL=; BEHALTEN=30; PB_DATA=/opt/pocketbase/pb_data; PUSH_DATA=/var/lib/push-dienst
# shellcheck disable=SC1090
. "$CONF"
[ -n "$ZIEL" ] || { echo "ZIEL fehlt in $CONF"; exit 1; }

TS=$(date +%F_%H%M)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pocketbase"

# Datenbanken im laufenden Betrieb konsistent kopieren
for db in data.db auxiliary.db; do
  [ -f "$PB_DATA/$db" ] && sqlite3 "$PB_DATA/$db" ".backup '$TMP/pocketbase/$db'"
done
[ -f "$TMP/pocketbase/data.db" ] || { echo "Keine data.db in $PB_DATA gefunden"; exit 1; }
chk=$(sqlite3 "$TMP/pocketbase/data.db" "PRAGMA integrity_check;")
[ "$chk" = ok ] || { echo "Kopie fehlerhaft: $chk"; exit 1; }
[ -d "$PB_DATA/storage" ] && cp -a "$PB_DATA/storage" "$TMP/pocketbase/"
[ -d "$PUSH_DATA" ] && cp -a "$PUSH_DATA" "$TMP/push-dienst"

# NAS ansprechen (weckt das Automount) und schreiben
ls "$(dirname "$ZIEL")" >/dev/null
mkdir -p "$ZIEL"
NAME="pb-$TS.tar.gz"
tar -czf "$ZIEL/.$NAME.teil" -C "$TMP" .
mv -f "$ZIEL/.$NAME.teil" "$ZIEL/$NAME"

# alte Sicherungen aufräumen
mapfile -t ALT < <(ls -1t "$ZIEL"/pb-*.tar.gz 2>/dev/null | tail -n +$((BEHALTEN + 1)))
[ ${#ALT[@]} -gt 0 ] && rm -f "${ALT[@]}"
echo "Sicherung $ZIEL/$NAME ($(du -h "$ZIEL/$NAME" | cut -f1)), $(ls -1 "$ZIEL"/pb-*.tar.gz | wc -l) vorhanden"
