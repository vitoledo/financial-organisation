#!/bin/sh
# Renders the supercronic crontab from the environment (see .env.example):
#   NOTION_SYNC_SCHEDULE   Pierre → Notion sync          (default: 00:00, 06:00, 12:00 and 18:00)
#   SHEETS_SYNC_SCHEDULE   legacy Google Sheets sync     (default: 06:30 and 18:30; runs only with
#                                                         ENABLE_GOOGLE_SHEETS_SYNC=true)
# Times are America/Sao_Paulo. A schedule is a standard 5-field cron expression (or 6/7 fields, or an
# @-shortcut such as @hourly, as supercronic accepts). Anything else fails here, before the scheduler starts.
set -eu

NOTION_SYNC_SCHEDULE="${NOTION_SYNC_SCHEDULE:-0 0,6,12,18 * * *}"
SHEETS_SYNC_SCHEDULE="${SHEETS_SYNC_SCHEDULE:-30 6,18 * * *}"

check() {
  name="$1"
  value="$2"
  case "$value" in
    @yearly | @annually | @monthly | @weekly | @daily | @midnight | @hourly) return 0 ;;
    @*)
      echo "render-crontab: $name inválido: '$value' (atalhos aceitos: @hourly, @daily, @weekly, @monthly, @yearly)" >&2
      exit 1
      ;;
  esac
  # Only cron characters, and 5 to 7 fields.
  if printf '%s' "$value" | grep -Eq '[^0-9A-Za-z*,/?#L -]'; then
    echo "render-crontab: $name inválido: '$value'" >&2
    exit 1
  fi
  fields=$(printf '%s\n' "$value" | awk '{ print NF }')
  if [ "$fields" -lt 5 ] || [ "$fields" -gt 7 ]; then
    echo "render-crontab: $name precisa de 5 campos (minuto hora dia mês dia-da-semana), recebi $fields: '$value'" >&2
    exit 1
  fi
}

check NOTION_SYNC_SCHEDULE "$NOTION_SYNC_SCHEDULE"
check SHEETS_SYNC_SCHEDULE "$SHEETS_SYNC_SCHEDULE"

cat <<CRONTAB
# Generated at container start by render-crontab.sh — edit NOTION_SYNC_SCHEDULE / SHEETS_SYNC_SCHEDULE in .env.
CRON_TZ=America/Sao_Paulo

# Pierre → SQLite → Notion (Transações, Faturas, Contas e Log de Sincronização).
$NOTION_SYNC_SCHEDULE node /app/dist/notion/sync/cli.js --apply

# Planilha Google Sheets (legado): só roda com ENABLE_GOOGLE_SHEETS_SYNC=true.
$SHEETS_SYNC_SCHEDULE if [ "\$ENABLE_GOOGLE_SHEETS_SYNC" = "true" ]; then node /app/dist/index.js; fi
CRONTAB
