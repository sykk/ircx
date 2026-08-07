# The eleventh run: the export, at the size it was built for

Run on 2026-08-07 against a local `quickserver` on `127.0.0.1:6699`, in the
assembled release app on `Xvfb :90`, against `main` at `3479428`.

Run 5 walked the export and said what it had left behind: *"An export large
enough to stream. 35 KB is not a test of writing the archive without rendering
it first, which is what `BufWriter` and `export_everything` are for."* This is
that walk, at 100,021 messages and 52 MB, with three networks connected while it
ran.

It found nothing, and the evidence is the point. Until today the claim that the
export streams rested on `export_archive`'s own comment.

## The profile

`startup.mjs --seed-only --messages 100000 --networks 3`, which is the profile
`docs/measurements.md` times startup against. Three networks dialling, each with
`#measure` restored, 100,000 seeded messages and a 56 MB archive.

`01-a-hundred-thousand-kept.png` is the sheet reading **100,021 messages, 56 MB
on this machine** — the 100,000 seeded, three joins and eighteen numerics the
session added. The count and the size both render, which nothing had asked them
to do above five figures.

## What it wrote

`02-fifty-two-megabytes.png`: **Written to …/export-everything.jsonl — 52 MB.**
54,127,733 bytes on disk.

Read back rather than trusted:

| | |
|---|---|
| lines | 100,021 — the count the sheet had just claimed |
| valid JSON | 100,021 of 100,021, through `jq -c` |
| ordering | 0 lines out of order, oldest first |
| coverage | all three networks, each `#measure` and each `*` console |

The three channels hold 33,335 / 33,334 / 33,334 and the three consoles 6 each,
which is the seed's `i % 3` plus one join apiece.

One line was sent from the composer between the first export and the second, and
the file grew by 519 bytes — one message, whole. That is the cheapest check that
the export reads the archive as it stands rather than a page of it.

## What it cost

Sampled every 57 ms: the destination's size, and `VmRSS` from `/proc`. Three
runs of `Export everything`, release build, archive and destination both on
btrfs.

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| bytes written | 54,127,733 | 54,128,252 | 54,128,252 |
| from `File::create` to the final byte | 570 ms | 563 ms | 504 ms |
| RSS before | 177,108 kB | 179,848 kB | 182,816 kB |
| RSS peak during | 177,932 kB | 179,936 kB | 182,888 kB |
| **RSS the export added** | **824 kB** | **88 kB** | **72 kB** |

**52 MB leaves through under a megabyte of memory**, and in two runs of three
under a tenth of one. The size climbs in a straight line — about 6.9 MB per
57 ms sample, eight samples wide, at roughly 96 MB/s — which is the shape of a
writer being fed rather than a buffer being flushed.

**The excursion is smaller than the app's own drift.** Over the 693 samples
before the first export, RSS wandered between 160,788 kB and 171,000 kB with
nothing happening. A 10 MB idle drift is larger than anything the export did, so
"it streams" is not a fine measurement here; it is the difference between a
number that moves and one that does not.

Quote 0.5–0.6 s for 100,000 messages, and read the caveats before quoting it
anywhere else. **Covers:** the whole path from the click, through the save
dialog, `export_archive`, `export_everything` and the `BufWriter`, to the last
byte on a real filesystem. **Excludes:** the save dialog itself, which is the
operator; a destination on a slower disk; and any archive larger than this one.

## The conversation on its own

`03-the-conversation-alone.png`: **Written to …/export-measure.jsonl — 17 MB.**

`Export #measure` takes `export_target`, which is a different query and the same
loop. 33,335 lines, all valid JSON, every one of them `quick0 #measure` — so the
scope holds at scale as well as the SQL says it does. 18,039,768 bytes in
230–290 ms, and RSS moved by nothing measurable: 176,564 kB before, 176,468 kB
at the end.

## The window afterwards

`04-still-live-after.png`. After 70 MB across two exports the three networks are
still connected, the status bar reads **Lag 0ms**, and a line typed into the
composer sends and draws. The archive sheet's success sentence replaced the
previous one rather than stacking, which is #351's rule holding at a size run 5
could not reach.

## What this run did not reach

- **What the lock costs a search.** `Store` is one connection behind a mutex,
  and `export_everything` holds it for the whole 563 ms. What that does to a
  connection is measured — `docs/measurements.md`, *What an archive command
  costs the connection* — and what it does to a search typed while an export
  runs is listed there as excluded and still is. The window is the place to ask
  it and 563 ms is a hard thing to type inside of.
- **An archive that does not fit in the page cache.** 56 MB is read back at
  96 MB/s from a file the machine had just written. A year of real channels is
  the same code path against a colder file.
- **A disk that actually fills.** Still `StorageFull` with a sentence and no
  evidence, unchanged since run 5.
- **A screen reader.** The sheet's `role="status"` sentence is longer now and
  still nobody has heard it.
