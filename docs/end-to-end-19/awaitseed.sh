#!/usr/bin/env bash
# Waits for the seeder's lines to finish reaching ergo's history buffer.
#
#     awaitseed.sh
#
# `fakelag` accepts five commands and then two a second, so `seed_history.py`
# printing "seeded" means the socket took the lines, not that the server has.
# A walk started before the drain ends has live messages arriving in it, which
# is a different walk from the one being counted.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
prev=""
for i in $(seq 1 30); do
  n=$(timeout 30 python3 "$HERE/newest.py" "drain$i")
  echo "newest seeded line: $n"
  if [ "$n" = "$prev" ]; then
    echo "drain finished at line $n"
    exit 0
  fi
  prev=$n
  sleep 25
done
echo "still moving after 30 checks — last saw $prev"
exit 1
