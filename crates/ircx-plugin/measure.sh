#!/usr/bin/env bash
# The two numbers `bench` cannot produce from inside one process: what each
# mechanism adds to a binary, and what it costs between exec and an answer.
#
# Builds `probe` four times — no backend, then each backend alone — under the
# workspace release profile (lto, opt-level = "s", stripped), which is the
# profile the shipped binary uses. The size of a mechanism is the difference
# between two binaries that are otherwise identical code.
#
#   crates/ircx-plugin/measure.sh
#
# Timing is `exec` to exit of a process that loads one plugin and calls it
# once, over $RUNS runs, reported as the minimum and the median. It includes
# fork, exec, the dynamic linker, and Rust startup, because the app pays those
# too. It excludes anything the app does with the answer.

set -euo pipefail

cd "$(dirname "$0")/../.."
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
RUNS="${RUNS:-100}"
OUT="$CARGO_TARGET_DIR/probe-variants"
mkdir -p "$OUT"

build() {
  local name="$1"
  shift
  cargo build --release -p ircx-plugin --no-default-features "$@" >/dev/null
  cp "$CARGO_TARGET_DIR/release/probe" "$OUT/probe-$name"
}

build none --bin probe
build js --features js --bin probe
build wasm --features wasm --bin probe
build proc --features proc --bin probe --bin plugin-child
cp "$CARGO_TARGET_DIR/release/plugin-child" "$OUT/plugin-child"

echo "# binary size, release profile, stripped"
echo
echo "| build | bytes | added |"
echo "|---|---|---|"
base=$(stat -c %s "$OUT/probe-none")
for name in none js wasm proc; do
  size=$(stat -c %s "$OUT/probe-$name")
  echo "| probe, $name | $size | $((size - base)) |"
done
child=$(stat -c %s "$OUT/plugin-child")
echo "| plugin-child (the process mechanism's plugin) | $child | ships separately |"

echo
echo "# exec to answer, $RUNS runs"
echo
echo "| build | min | median |"
echo "|---|---|---|"
for name in none js wasm proc; do
  # `probe-proc` looks for plugin-child next to itself, which is why both were
  # copied into the same directory.
  samples=$(
    for _ in $(seq "$RUNS"); do
      start=${EPOCHREALTIME/./}
      "$OUT/probe-$name" >/dev/null 2>&1
      end=${EPOCHREALTIME/./}
      echo $((end - start))
    done | sort -n
  )
  echo "$samples" | awk -v name="$name" \
    '{a[NR]=$1} END{printf "| probe, %s | %.2f ms | %.2f ms |\n", name, a[1]/1000, a[int((NR+1)/2)]/1000}'
done

echo
echo "# what the probe spends it on, one run each (nanoseconds since main)"
echo
for name in js wasm proc; do
  echo "probe-$name"
  "$OUT/probe-$name" 2>/dev/null | sed 's/^/  /'
done
