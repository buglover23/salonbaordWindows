#!/bin/bash
# One copy of the SALON BOARD auto poster (Mac), like 起動.bat on Windows: started in its own Terminal window by the top
# folder's 起動.command (or by double-click). Placed at app/<copy>/起動.command by the Mac export.
set -u

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$LINK_DIR/$SOURCE" ;; esac
done
DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)" || exit 2
ROOT="$(cd "$DIR/../.." && pwd)" || exit 2
cd "$DIR" || exit 2
if [ -x "$ROOT/.runtime/node/bin/node" ]; then export PATH="$ROOT/.runtime/node/bin:$PATH"; fi

# The window title names this copy, so the two windows (two logins) can be told apart.
printf '\033]0;SalonBoard - %s\007' "$(basename "$DIR")"

wait_key() {
  echo
  read -r -n 1 -s -p "何かキーを押すと閉じます。" _
  echo
}

if ! command -v node > /dev/null 2>&1; then
  echo "Node.js が見つかりません。いちばん上のフォルダの 起動.command を開いてください（必要なものを自動で入れます）。"
  wait_key
  exit 2
fi
if [ ! -f "dist/src/launcher.js" ]; then
  echo "プログラムが組み立てられていません（dist/src/launcher.js がありません）。"
  echo "いちばん上のフォルダの 起動.command を開いてください（自動で組み立てます）。"
  wait_key
  exit 2
fi

node dist/src/launcher.js
EXIT_CODE=$?
if [ "$EXIT_CODE" -ne 0 ]; then
  echo
  echo "ツールが止まりました（終了コード ${EXIT_CODE}）。上の表示を確認してください。詳しくは logs フォルダの記録にあります。"
fi
wait_key
exit "$EXIT_CODE"
