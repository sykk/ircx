# End-to-end run 20

Run on 2026-08-13 against the same local `ergo` 2.19 on `127.0.0.1:6677` runs 15
to 19 used, in the release app.

Run 19 ended by recommending that the next attempt at #496 **manufacture its
precondition rather than wait for it**, four runs having failed to reach it by
walking. This run did that, and the answer is better than another zero:

**The state #496 guards against cannot be entered at channel open, and there is
a photograph of the reason.** A pane that has joined a channel always holds its
own join digest before any archive read returns, so the snapshot the old build
reads from is never empty — which is the whole of what the fix changed.

## The precondition, stated exactly

The fix is one line, and the two sides differ only in where the head is read
from:

```js
const oldest = older[0] ?? current.messages[0];   // before #497
const oldest = olderOf(older[0], live[0]);        // after
```

`current` is the snapshot taken *before* the archive read is awaited; `live` is
the store read *after*. So they can only disagree when the timeline changed
during the await — when the server's own history landed while `load_history` was
in flight. Two shapes follow, and only one of them had ever been described:

- **`older` non-empty and `live[0]` older than `older[0]`.** The archive page is
  not behind the window, so the old build asks from the page's own first row and
  re-requests what it holds. This is what #497's message describes and what
  `Timeline.test.tsx` already covered.
- **`older` empty and the snapshot empty.** The old build computes `undefined`,
  and `pageBack` reads that as a conversation with nothing behind it: it returns
  `"end"` without sending anything, `hasMore` goes false, and the pane draws
  "Beginning of history" over a server holding thousands.

The second is much the worse symptom and was not covered. A test for it is added
here, and it fails on `b75edf2` in the sharpest way available — **`pageBack` is
never called at all**:

```text
AssertionError: expected "spy" to be called at least once
```

That is the reader who cannot reach their own history for the rest of the run,
and it is the same signature run 17 measured across 69 walks when it found the
old build asking for a page 1.7 times where the fixed one asked 3.0.

## Manufacturing it

The window is the archive read. `holdlatest.py` holds the batch answering the
join's `CHATHISTORY LATEST` for a stated number of milliseconds and passes every
other byte, `PING` included — the discipline run 18 arrived at, because a proxy
that holds everything provokes a reconnect and a reconnect changes the state
under test.

Holding the page back should, on the argument above, leave the pane with nothing
to ask from when its priming read returns. Swept over four orders of magnitude
on the build that has the defect:

```text
    delay      pages held   page-backs sent
        0ms             1                 2
      100ms             1                 2
      800ms             1                 2
     8000ms             1                 2
```

Identical at every point. The old build pages back normally with its join's own
history held for eight seconds.

## Why, photographed

`midhold.sh` takes the frame *inside* the hold, four seconds in, with the page
still eight seconds from being released.

`midhold/a-inside-the-hold.png` is the answer. The pane is not empty. It holds

```text
21:24  1 joined. 1 of them involves you.
       #scrollback is closed to messages from outside and topic-locked to ops.
       #scrollback was created on 2026-08-11 at 12:13 UTC
```

— the join digest and the channel's own system rows, filed before any history
arrives and before the archive is read. So `current.messages[0]` is those rows,
never `undefined`, and the old build asks from them exactly as the new one does.
`midhold/c-scrolled.png` is the same walk afterwards, reading back through
`line 2078` and onwards: nothing was harmed by the hold at all.

**The empty snapshot needs a pane with no messages whatsoever**, and a joined
channel never has one. That is why runs 16 to 19 could not reproduce this by
walking, and it is a stronger answer than any of their counts: not "we did not
see it" but "this path cannot produce it".

## What this does and does not say about the fix

It does not say the fix was unnecessary. Reading the head after the await is
correct regardless of whether any walk can reach the state, the old expression
was wrong on its own terms, and #497 also moved `setAskedBehind` and `pageBack`
onto the same head — which is what run 18's wedge fix then depended on.

What it says is that the **defect's reachable surface is smaller than four runs
of walking assumed**, and that the walks were hunting a state the app's own
ordering prevents. The cost of learning that by walking was runs 16 to 19; the
cost of learning it by test and one proxy was an afternoon.

## What is left

One path remains and it is narrow: a pane **restored from the layout before its
join completes** has no join digest yet, so its snapshot can be empty while its
archive is empty too. That is a startup window rather than a channel-open one,
and this run did not walk it.

It is worth saying plainly that it may not be worth walking either. The state is
reachable in a test, the test now exists, and the fix is in `main`. Runs 16 to
20 have spent five runs on #496 and the last two are the only ones that produced
a mechanism. **The lesson is run 18's, arriving for the third time: where a
defect has a state rather than a timing, the test is the instrument and the walk
is the confirmation.** A walk is a poor search.

## For the next run

Nothing about #496. If the startup window is ever wanted, it is a `--keep`
profile with a channel in the layout, its history injected while the app is
down, and the join's own digest held back — three conditions at once, for a
symptom already covered by a test.
