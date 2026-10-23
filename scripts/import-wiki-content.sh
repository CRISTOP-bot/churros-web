#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONTENT_DIR="${WIKI_CONTENT_DIR:-$SCRIPT_DIR/../wiki-content}"
MEDIAWIKI_DIR="${MEDIAWIKI_DIR:-/usr/share/webapps/mediawiki}"
WIKI_RUN_USER="${WIKI_RUN_USER:-http}"
SUMMARY="${WIKI_IMPORT_SUMMARY:-Contenido inicial de la wiki de ChurrOS}"
REBUILD_SEARCH="${WIKI_REBUILD_SEARCH:-1}"
PHP_BIN="${PHP_BIN:-php}"

if [[ ! -f "$MEDIAWIKI_DIR/maintenance/run.php" ]]; then
  echo "No se encontró MediaWiki en: $MEDIAWIKI_DIR" >&2
  echo "Define MEDIAWIKI_DIR con la ruta de la instalación." >&2
  exit 1
fi

if [[ ! -d "$CONTENT_DIR" ]]; then
  echo "No se encontró el contenido de la wiki en: $CONTENT_DIR" >&2
  exit 1
fi
CONTENT_DIR="$(cd -- "$CONTENT_DIR" && pwd)"

shopt -s nullglob
files=("$CONTENT_DIR"/*.wiki)
if (( ${#files[@]} == 0 )); then
  echo "No hay archivos .wiki en: $CONTENT_DIR" >&2
  exit 1
fi

as_root=0
if [[ "$(id -u)" -eq 0 ]]; then
  if ! command -v runuser >/dev/null 2>&1; then
    echo "runuser no está disponible. Ejecuta el script como el usuario de MediaWiki." >&2
    exit 1
  fi
  if ! id -u "$WIKI_RUN_USER" >/dev/null 2>&1; then
    echo "El usuario de MediaWiki no existe: $WIKI_RUN_USER" >&2
    exit 1
  fi
  as_root=1
fi

run_mediawiki() {
  if [[ "$as_root" -eq 1 ]]; then
    runuser -u "$WIKI_RUN_USER" -- "$@"
  else
    "$@"
  fi
}

echo "Importando ${#files[@]} páginas desde $CONTENT_DIR"
run_mediawiki "$PHP_BIN" "$MEDIAWIKI_DIR/maintenance/run.php" importTextFiles \
  --overwrite --rc --summary "$SUMMARY" "${files[@]}"

if [[ "$REBUILD_SEARCH" != "0" ]]; then
  echo "Reconstruyendo el índice de búsqueda..."
  run_mediawiki "$PHP_BIN" "$MEDIAWIKI_DIR/maintenance/run.php" rebuildtextindex
fi
