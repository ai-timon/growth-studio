#!/bin/bash
# Usage : shot.sh <nom> <query> [largeur] [hauteur]  -> tools/render-bench/out/<nom>.png
cd "$(dirname "$0")"; mkdir -p out
timeout 40 python3 -I serve.py 8765 & S=$!; sleep 0.6
timeout 30 google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=${3:-1110},${4:-1200} --virtual-time-budget=4000 \
  --screenshot="out/$1.png" "http://127.0.0.1:8765/tools/render-bench/index.html?$2" >/dev/null 2>&1
kill $S 2>/dev/null; echo "out/$1.png"
