#!/bin/bash
# SALON BOARD auto poster for Mac: double-click to start. Prepares everything the tool needs (Node.js 24, the packages
# and the builds of app/mens and app/ladies), makes the salonboard command available, then starts each copy in its own
# Terminal window. Works from wherever this folder is placed (~/SalonBoard is the recommended place).
set -u
set -o pipefail

# This folder, with symlinks resolved.
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$LINK_DIR/$SOURCE" ;; esac
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)" || exit 1
RUNTIME="$ROOT/.runtime"
NODE_DIR="$RUNTIME/node"
LOG="$RUNTIME/setup.log"

if ! mkdir -p "$RUNTIME"; then
  echo "フォルダに書き込めません（${RUNTIME}）。フォルダをホームの中（例: ホーム > SalonBoard）に置いてから、もう一度開いてください。"
  read -r -p "Enter キーを押すと閉じます。" _
  exit 1
fi

say() {
  printf '%s\n' "$*"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

fail() {
  say "$*"
  say "詳しい記録: $LOG"
  echo
  read -r -p "Enter キーを押すと閉じます。" _
  exit 1
}

label() {
  case "$1" in mens) echo "メンズ" ;; ladies) echo "レディース" ;; *) echo "$1" ;; esac
}

# True when $1 is a Node.js the tool accepts (24.11 or later within 24, as package.json engines).
node_ok() {
  [ -x "$1" ] && "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a === 24 && b >= 11 ? 0 : 1)' > /dev/null 2>&1
}

sha_of() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

# True while that copy's tool or its window runs (its lock files name a live node process; npm ci must not run then).
copy_running() {
  local f pid
  for f in "$1/data/launcher.lock" "$1/data/app.lock"; do
    [ -f "$f" ] || continue
    pid="$(/usr/bin/sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$f" | /usr/bin/head -n 1)"
    if [ -n "$pid" ] && /bin/ps -p "$pid" -o comm= 2> /dev/null | /usr/bin/grep -q node; then return 0; fi
  done
  return 1
}

say "SALON BOARD 自動投稿ツール（Mac）の準備をします: $ROOT"

# a. Files that came from another PC are quarantined; without this the other .command files would not open.
/usr/bin/xattr -dr com.apple.quarantine "$ROOT" 2> /dev/null || true

# b. Node.js 24: this folder's own copy, else one already on the Mac, else download the official one.
if node_ok "$NODE_DIR/bin/node"; then
  export PATH="$NODE_DIR/bin:$PATH"
elif node_ok "$(command -v node 2> /dev/null || true)"; then
  say "この Mac に入っている Node.js を使います（$(node --version)）。"
else
  case "$(uname -m)" in
    arm64) ARCH="darwin-arm64" ;;
    x86_64) ARCH="darwin-x64" ;;
    *) fail "この Mac の種類（$(uname -m)）には対応していません。開発担当に連絡してください。" ;;
  esac
  BASE="https://nodejs.org/dist/latest-v24.x"
  say "Node.js 24 をダウンロードします（初回だけ。数分かかることがあります）。"
  SUMS="$(/usr/bin/curl -fsSL "$BASE/SHASUMS256.txt")" || fail "Node.js をダウンロードできませんでした。インターネットにつながっているか確かめてから、もう一度 起動.command を開いてください。"
  LINE="$(printf '%s\n' "$SUMS" | /usr/bin/grep -E "  node-v24\.[0-9]+\.[0-9]+-${ARCH}\.tar\.gz\$" | /usr/bin/head -n 1)"
  [ -n "$LINE" ] || fail "ダウンロードするファイルが見つかりませんでした（nodejs.org の一覧）。時間をおいて、もう一度開いてください。"
  WANT="${LINE%% *}"
  FILE="${LINE##* }"
  TMP="$(/usr/bin/mktemp -d "$RUNTIME/node-download.XXXXXX")" || fail "作業用のフォルダを作れませんでした（${RUNTIME}）。"
  /usr/bin/curl -fL --progress-bar -o "$TMP/$FILE" "$BASE/$FILE" || { rm -rf "$TMP"; fail "Node.js をダウンロードできませんでした。インターネットにつながっているか確かめてから、もう一度開いてください。"; }
  GOT="$(sha_of "$TMP/$FILE")"
  if [ "$GOT" != "$WANT" ]; then
    rm -rf "$TMP"
    fail "ダウンロードした Node.js が壊れているため使いません（確認用の値が一致しません）。もう一度開いてください。"
  fi
  # Extracted beside the old one, then swapped in, so a cut-off run never leaves half a Node.js behind.
  if ! mkdir "$TMP/x" || ! /usr/bin/tar -xzf "$TMP/$FILE" -C "$TMP/x"; then
    rm -rf "$TMP"
    fail "Node.js を展開できませんでした。"
  fi
  rm -rf "$NODE_DIR.old"
  if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old" || fail "古い Node.js を片付けられませんでした（${NODE_DIR}）。"; fi
  mv "$TMP/x/${FILE%.tar.gz}" "$NODE_DIR" || fail "Node.js を置けませんでした（${NODE_DIR}）。"
  rm -rf "$TMP" "$NODE_DIR.old"
  node_ok "$NODE_DIR/bin/node" || fail "入れた Node.js が動きません。開発担当に連絡してください。"
  export PATH="$NODE_DIR/bin:$PATH"
  say "Node.js $(node --version) を入れました。"
fi

# c. Google Chrome (the extension runs in it).
if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
  say "Google Chrome が入っていません。開いたページから Chrome をインストールしてから、もう一度 起動.command を開いてください。"
  /usr/bin/open "https://www.google.com/chrome/" || true
  fail "（Chrome を入れた後に、もう一度開きます）"
fi

# d. Each copy: packages when missing or package-lock.json changed, the build when missing or the package changed.
COPIES=()
for COPY in mens ladies; do
  DIR="$ROOT/app/$COPY"
  NAME="$(label "$COPY")"
  if [ ! -f "$DIR/package.json" ]; then
    say "${NAME}のツール（app/${COPY}）が見つからないため、${NAME}は準備も起動もしません。"
    continue
  fi
  if copy_running "$DIR"; then
    say "${NAME}のツールはすでに動いています（そのウィンドウを見てください）。準備と起動は飛ばします。"
    continue
  fi
  LOCK_SHA="$(sha_of "$DIR/package-lock.json")" || fail "${NAME}の package-lock.json を読めません。"
  if [ ! -d "$DIR/node_modules" ] || [ "$(cat "$RUNTIME/$COPY-lock.sha" 2> /dev/null)" != "$LOCK_SHA" ]; then
    say "${NAME}: 必要な部品を入れています（初回は数分かかります）…"
    (cd "$DIR" && npm ci --no-audit --no-fund) 2>&1 | tee -a "$LOG" || fail "${NAME}: 部品を入れられませんでした。インターネットにつながっているか確かめてから、もう一度開いてください。"
    printf '%s\n' "$LOCK_SHA" > "$RUNTIME/$COPY-lock.sha"
    rm -f "$RUNTIME/$COPY-build.id"
  fi
  PACKAGE_ID="$(cat "$DIR/.package-id" 2> /dev/null || true)"
  if [ ! -f "$DIR/dist/src/launcher.js" ] || [ ! -f "$DIR/apps/extension/dist/manifest.json" ] || [ "$(cat "$RUNTIME/$COPY-build.id" 2> /dev/null)" != "$PACKAGE_ID" ]; then
    say "${NAME}: プログラムと拡張機能を組み立てています…"
    (cd "$DIR" && npm run build && npm run build:extension) 2>&1 | tee -a "$LOG" || fail "${NAME}: 組み立てに失敗しました。上の表示を開発担当に伝えてください。"
    printf '%s\n' "$PACKAGE_ID" > "$RUNTIME/$COPY-build.id"
  fi
  COPIES+=("$COPY")
done

# e. The salonboard command from any folder (new Terminal windows). This folder's Node.js is last, for npm run in a copy.
MARK="# SalonBoard: salonboard コマンド（起動.command が書きました）"
ESC="${ROOT//\\/\\\\}"
ESC="${ESC//\"/\\\"}"
ESC="${ESC//\$/\\\$}"
ESC="${ESC//\`/\\\`}"
PATH_LINE="export PATH=\"$ESC/bin:\$PATH:$ESC/.runtime/node/bin\""
add_path() {
  local f="$1" tmp rc=0
  if [ -f "$f" ] && /usr/bin/grep -qxF "$PATH_LINE" "$f"; then return 0; fi
  tmp="$(/usr/bin/mktemp)" || return 1
  # An earlier line of ours (the folder was moved) is replaced, never repeated.
  if [ -f "$f" ]; then /usr/bin/awk -v m="$MARK" 'skip { skip = 0; next } $0 == m { skip = 1; next } { print }' "$f" > "$tmp" || rc=1; fi
  if [ "$rc" -eq 0 ]; then { printf '%s\n%s\n' "$MARK" "$PATH_LINE" >> "$tmp" && cat "$tmp" > "$f"; } || rc=1; fi
  rm -f "$tmp"
  return "$rc"
}
chmod +x "$ROOT/bin/salonboard" 2> /dev/null || true
if add_path "$HOME/.zprofile"; then
  if [ -f "$HOME/.bash_profile" ]; then add_path "$HOME/.bash_profile" || true; fi
  say "salonboard コマンドを使えるようにしました（新しく開いたターミナルのウィンドウで使えます。例: salonboard status）。"
else
  say "salonboard コマンドの設定（~/.zprofile）を書けませんでした。代わりに \"$ROOT/bin/salonboard\" と打てば使えます。"
fi

# f. Each copy in its own Terminal window.
if [ "${#COPIES[@]}" -eq 0 ]; then
  fail "起動するツールがありません（上の表示を確認してください）。"
fi
for COPY in "${COPIES[@]}"; do
  CMD="$ROOT/app/$COPY/起動.command"
  if [ -f "$CMD" ]; then
    chmod +x "$CMD" 2> /dev/null || true
    /usr/bin/open -a Terminal "$CMD" || say "$(label "$COPY")のウィンドウを開けませんでした（app/$COPY/起動.command をダブルクリックしてください）。"
  else
    say "$(label "$COPY")の起動ファイル（app/$COPY/起動.command）が見つかりません。"
  fi
done

cat << EOF

――――――――――――――――――――――――――――――――
起動しました。メンズとレディースの黒いウィンドウ（ターミナル）が開きます。閉じないでください。

はじめての Mac では次の準備をします（くわしくは 使い方.txt）。
  1. Chrome でユーザー（プロファイル）を2つ作り、それぞれで SALON BOARD にログインします。
       メンズ用  → メンズでログイン   レディース用 → レディースでログイン
  2. それぞれの Chrome で chrome://extensions を開き、右上の「デベロッパー モード」をオンにして
     「パッケージ化されていない拡張機能を読み込む」から次のフォルダを選びます。
       メンズ用の Chrome     : $ROOT/app/mens/apps/extension/dist
       レディース用の Chrome : $ROOT/app/ladies/apps/extension/dist
  3. 各ウィンドウに出る「拡張機能の接続コード」を、拡張機能のポップアップで「接続」を押して入力します。

このウィンドウは閉じてかまいません。
――――――――――――――――――――――――――――――――
EOF
