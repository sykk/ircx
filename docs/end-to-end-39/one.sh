#!/usr/bin/env bash
# One walk: two panes on one conversation, the right one at the live edge.
#
#     one.sh <tree> <output directory> <arm> <ergo port> <hold port> <park notches>
#
# Run 31's `parked.sh` with the parking moved to the other pane, which is the
# whole of what run 39 is. Runs 22, 23 and 31 all parked the right pane in the
# archive beside a left one paging back, so every measurement of a split to date
# is of two panes reading history. The pane this run leaves alone is the one at
# the tail, and it is left alone by not wheeling it: a restored pane opens at the
# live edge, so the arrangement costs a command rather than needing one.
#
# The arms are things landing in a pane, and the first three are measured in both:
#
#   live      a second client says a line while the left pane sits in the archive
#   pageback  a page-back lands in the left pane while nothing at all is said
#   both      a page-back lands after lines have arrived live while it was held
#   split     the split is made while the one pane there is is in the archive
#   atlive    the same line, with neither pane parked: the control
#   single    the same line again, into one pane at the tail: the base control
#   send      the reader types into the parked pane, which is a way back to the tail
#   sendone   the same, with no split at all: the case with no second pane to see it in
#   jump      lines arrive live, and the parked pane is sent to the tail by its pill
#   sendfail  the same line into a channel that refuses it, the reader parked
#
# The last is the other half of what this gap names. #307 is a pane losing its
# place on a split, and the three arms above all split before anybody has read
# anything, which is the easy order. This one reads first: it wheels the single
# pane back into the archive and then presses `ctrl+backslash`, so the place
# being kept is one the reader chose rather than the one a fresh pane opens at.
# There is nothing to measure in pixels across it — the pane is a different width
# afterwards — so the reading is the frame.
#
# `latepage.py` is under the last two and not under the first, because a frame
# has to be able to fall either side of what it measures. A page-back off a local
# ergo is answered inside the wheel burst that asked for it — run 31's note on
# why the window cannot start at the end of a wait — so the answer is held for
# forty seconds, which run 31 established is past the longest burst measured here
# and twenty short of `ROUND_TRIP_TIMEOUT`. The client is still waiting when its
# page lands, which is the ordinary case rather than run 30's.
#
# A line said by a second client needs no proxy: `say` returns on the echo, so
# the plan already knows when it was sent and the frame after it is the frame
# after it.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
ARM=${3:?arm}
ERGO=${4:?ergo port}
HOLD=${5:?hold port}
PARK=${6:?park notches}

HERE="$TREE/docs/end-to-end-39"
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
# The refusing channel is a different one because it has to be moderated, and
# moderating the channel the other eight arms read would refuse their seeder too.
CHANNEL='#live39'
if [ "$ARM" = sendfail ]; then CHANNEL='#refuse39'; fi
HELD=40
mkdir -p "$DIR"

# The proxy is up across both launches, so the first launch's join page crosses
# it untouched — it holds `CHATHISTORY BEFORE` and nothing else.
PORT=$ERGO
# `sendfail` is under the proxy for its log rather than for its hold: the reader
# never pages in that arm, so nothing is ever held, and what the wire answers is
# which of the client's own lines the channel refused.
if [ "$ARM" = pageback ] || [ "$ARM" = both ] || [ "$ARM" = sendfail ]; then
  python3 "$TREE/docs/end-to-end-30/latepage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
    "$HELD" > "$DIR/hold.log" 2>&1 &
  HOLD_PID=$!
  PORT=$HOLD
  sleep 1
fi

# The split arm's first launch does not split: what it seeds is a profile on the
# channel, and the split is the thing being measured in the second.
PROFILE=$(
  {
    echo "wait 9000"
    case "$ARM" in split|single|sendone|sendfail) ;; *) echo "key ctrl+backslash" ;; esac
    echo "wait 2500"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join "$CHANNEL" --keep 2>&1 \
    | tee "$DIR/first.log" \
    | sed -n 's/^ok profile kept at //p'
)

if [ -z "$PROFILE" ]; then
  echo "  no profile kept — see $DIR/first.log"
  kill "${HOLD_PID:-}" 2>/dev/null || true
  exit 1
fi

plan() {
  # The left pane is parked before anything is provoked, and `parked.png` is
  # what says where it stopped. However far it goes it has to stop inside the
  # messages the restore read: a pane within `LOAD_OLDER_PX` of the top of its
  # content has already asked for a page, and the walk then has no pane sitting
  # still in the archive at all.
  echo "win wait 12000"
  echo "spawn talker $CHANNEL"
  echo "win wait 2000"
  echo "shot arrangement"
  # The control parks nothing. It is the same walk with the wheel taken out, so
  # what it isolates is the parking rather than the split: two panes on one
  # conversation, both at the tail, and a line said into it.
  if [ "$ARM" != atlive ] && [ "$ARM" != single ]; then
    echo "win wheel 400 400 -$PARK"
    echo "win wait 2500"
  fi
  echo "shot parked"
  case "$ARM" in
    split)
      # Wheeled at the middle of the window, because at this point there is only
      # one pane and it is the whole of it. Then the split, then a line, so the
      # frame after says which of the two panes is at the tail as well as where
      # each of them is reading.
      echo "pair quiet"
      echo "win key ctrl+backslash"
      echo "win wait 3000"
      echo "shot split"
      echo "say talker $CHANNEL live 01 said just after the split"
      echo "win wait 1500"
      echo "shot after"
      ;;
    send|sendone|sendfail)
      # Into the parked pane's own composer, which is the one below it: a split
      # gives every pane one and the reader typed into this one. What is asked
      # is what a pane in the archive does with a line the reader themselves
      # sent — the tail moved, and they are not looking at it.
      echo "pair quiet"
      # The composer under the parked pane, which is the whole width of the
      # window when there is only one.
      case "$ARM" in sendone|sendfail) echo "win click 700 747" ;; *) echo "win click 480 747" ;; esac
      echo "win wait 500"
      echo "win type a line typed into the pane that is in the archive"
      echo "win key Return"
      echo "win wait 2000"
      echo "shot after"
      # That the line was sent at all is the second client's to say, and it has
      # to be said: a pane that does not move is the same picture whether the
      # composer sent the line or swallowed it.
      echo "grep talker a line typed into the pane"
      # Where the line went, for the arm whose whole question is whether the
      # reader was told anything: the pill takes the pane to the tail, and
      # whatever the client had to say about the message is drawn there.
      if [ "$ARM" = sendfail ]; then
        echo "win click 656 683"
        echo "win wait 2000"
        echo "shot at-the-tail"
      fi
      ;;
    jump)
      # Three lines while the pane is parked, then the pill it has been drawing
      # since it was parked. Where it lands is the question: the tail it was
      # promised has moved three messages since the pill appeared.
      echo "pair quiet"
      for n in 1 2 3; do
        echo "say talker $CHANNEL live 0$n said while the left pane is parked"
        echo "win wait 1200"
      done
      echo "shot arrived-live"
      echo "win click 412 683"
      echo "win wait 2000"
      echo "shot after"
      ;;
    live|atlive|single)
      # Two frames before the line and one after it. The first pair is the
      # control: two frames of a walk that provoked nothing, which is what says
      # a difference across the second pair came from the line.
      echo "pair quiet"
      echo "say talker $CHANNEL live 01 said while the left pane is in the archive"
      echo "win wait 1500"
      echo "shot after"
      ;;
    pageback|both)
      # The ask goes out inside this burst rather than after it, so the walk
      # photographs a window and `pick.py` chooses the straddling pair. Frames
      # every two seconds from the end of the burst until the hold has run out
      # with room to spare.
      echo "win wheel 400 400 -1600"
      echo "win wait 1500"
      echo "shot frame-000"
      if [ "$ARM" = both ]; then
        # Inside the hold and well clear of the release: what is being asked is
        # what a page lands into when lines have arrived since it was asked for,
        # so the lines have to be in before the page is.
        for n in 1 2 3; do
          echo "say talker $CHANNEL live 0$n said while the page is held"
          echo "win wait 1200"
        done
        echo "shot arrived-live"
      fi
      for n in $(seq -w 1 $(( (HELD + 8) / 2 ))); do
        echo "shot frame-$n"
        echo "win wait 2000"
      done
      ;;
  esac
  echo "quit"
}

plan | WALK_PORT="$ERGO" python3 "$HERE/walk.py" "$DIR/walk.log" "$DIR" "$TREE" \
  -- --release --profile "$PROFILE" > "$DIR/plan.log" 2>&1 \
  || echo "    the walk exited $?"

kill "${HOLD_PID:-}" 2>/dev/null || true
wait "${HOLD_PID:-}" 2>/dev/null || true
rm -rf "$PROFILE"

if [ "$ARM" = split ]; then
  echo "  the frames are the reading: parked.png, split.png, after.png"
elif [ "$ARM" = send ] || [ "$ARM" = sendone ] || [ "$ARM" = sendfail ] || [ "$ARM" = jump ]; then
  echo "  what the second client heard:"
  # Nothing, in the `sendfail` arm and in `jump`, which sends nothing at all.
  sed -n 's/^.*\[[0-9]*\] //p' "$DIR/walk.log" | grep "a line typed into the pane" | tail -1 \
    || echo "    nothing"
  echo "  across the reader's own line:"
  python3 "$HERE/reading.py" "$DIR/quiet-b.png" "$DIR/after.png"
elif [ "$ARM" = single ]; then
  echo "  one pane: the frames are the reading"
elif [ "$ARM" = live ] || [ "$ARM" = atlive ]; then
  echo "  control:"
  python3 "$HERE/reading.py" "$DIR/quiet-a.png" "$DIR/quiet-b.png"
  echo "  the line:"
  python3 "$HERE/reading.py" "$DIR/quiet-b.png" "$DIR/after.png"
else
  echo "  $(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked"
  python3 "$HERE/pick.py" "$DIR"
fi
