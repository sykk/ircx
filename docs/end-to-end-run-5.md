# The fifth run: the export, refused

Run on 2026-08-02 against a local `ergo` 2.19 on `127.0.0.1:6667`, in the
assembled app on `Xvfb :93`.

#351 walked the export the same day, hours earlier: both buttons, a GTK save
dialog answered for the first time, and both files read back with `jq`. What it
walked was the path where everything works. This run went after the other one —
a destination that refuses the write, a file already sitting where the export is
aimed, and a dialog nobody answers — because the sheet has three sentences for
those cases and none of them had been seen.

Two defects, both on the refusal.

## Two things in the way, both in the harness

**Xvfb wedged before the app started.** The display accepted no connections,
`xprop` hung rather than failing, and the run made no progress and printed
nothing — not an error, not a timeout, nothing to read. `window.mjs` gave Xvfb a
stderr pipe and never read it, and node backs a stdio pipe with a socketpair, so
the warnings filled a buffer instead of going nowhere. Xvfb starts by running
`xkbcomp` and waiting for it; `xkbcomp` blocked in a write it could not finish,
Xvfb waited on it forever, and the display never came up. Visible only from
`/proc`: `wchan` said `do_wait`, and its child sat in `sock_alloc_send_pskb`.

This host has something to say about its GPU on top of the usual keymap
warnings, which is presumably why four runs got away with it. The stream is
drained now, not ignored — an Xvfb that dies still says why.

**A shared `CARGO_TARGET_DIR` hands you another worktree's app.** The skill
recommends pointing it at an existing checkout to avoid rebuilding 51G of
dependencies, and `window.mjs` skips its build whenever the binary exists. Both
are right on their own and wrong together: the binary in a shared target
directory belongs to whichever checkout built it last. What caught it was #233,
which exists for exactly this and named both trees on the way out —

```text
ircx: http://localhost:5183/ is serving another checkout.
  it is serving: …/worktrees/export-walk/
  this build is: …/worktrees/topic-header
```

— so the answer is one `cargo build` with the same `CARGO_TARGET_DIR` before the
run, which takes 14 seconds because the dependencies really are shared. A guard
written for a stale dev server caught a stale binary instead.

## What refused

A folder at `chmod 500`, which the chooser accepts and the write cannot use.
Two defects on one screen — `04-errno-and-stale-success.png`.

**The sentence carried an errno.**

```text
…/readonly/nope.jsonl could not be written: Permission denied (os error 13)
```

`CLAUDE.md` asks for the other half of that: "Nickname already in use on
irc.libera.chat" — not "ERR_NICKNAMEINUSE (433)". `os error 13` is the same
thing wearing a different number. The kinds somebody can act on now say what to
do — `there is no permission to write there`, `that folder does not exist`,
`that is a folder, not a file`, `that disk is read-only`, `the disk is full` —
and anything else keeps the system's own words up to the errno it ends with.

**The success above it was two clicks old.** `Written to …export-all.jsonl —
35 KB` sat directly above the red line, because `setError` cleared the error and
nothing ever cleared the success. One screen said the same action both worked
and did not. The asymmetry was the tell: an error was already dropped by the
next attempt, and only the success outlived everything. Each outcome now
replaces the other, and cancelling still reports nothing, so an abandoned click
does not wipe what is on screen.

`05-one-outcome.png` is the same refusal after both fixes: one sentence, in
words, and nothing above it.

## The two that hold

**A file that is already there.** GTK asks — `03-replace.png`, *A file named
"export-1.jsonl" already exists. Do you want to replace it?* — and `Replace`
rewrites it in place at the same 7124 bytes. The client never sees the question,
which is the argument for using the platform's dialog rather than drawing one.

**A dialog nobody answers.** Escape, and nothing happens: no file written, no
error drawn, the previous sentence still standing. That is `exportTo`'s null
branch, which #167 made the point of separating from a rejection, and it
behaves.

## What landed, again

Not new — #351 established it — but read back once more on this run's own
archive, because the fixes touched the command that writes it.

`01-save-dialog.png` is the chooser: suggested name `#export.jsonl` with the
stem selected, filter `JSON Lines`. `02-written.png` is
`Written to …/export-1.jsonl — 7.0 KB` against 7124 bytes on disk: ten lines,
all valid JSON, oldest first, every one of them `#export` on `walk`. `Export
everything` wrote 51 — the 51 the sheet had just claimed — 41 of them console
output at `*` and the same 10 from the channel.

Each row carries the whole message model the spec asks for, `raw` included:

```json
{"id":"760387cc…","network":"walk","target":"#export","kind":"privmsg",
 "sender":{"nick":"walker","user":"~u","host":"f6u3beryjfghu.irc","isSelf":true},
 "timestamp":"2026-08-03T03:27:01.432Z","text":"second line, so the file has two of mine",
 "tags":[["msgid","4bs8tctcig2wvyqhbt9kjx6k8i"],["time","2026-08-03T03:27:01.432Z"],["label","ircx-2"]],
 "delivery":{"state":"delivered"},"encryption":"plaintext","source":"localArchive",
 "raw":"@msgid=…;time=…;label=ircx-2 :walker!~u@… PRIVMSG #export :second line, so the file has two of mine"}
```

## What this run did not reach

- **An export large enough to stream.** 35 KB is not a test of writing the
  archive without rendering it first, which is what `BufWriter` and
  `export_everything` are for. The 40k-message archive that
  `docs/measurements.md` measures the backlog against would be.
- **A disk that fills mid-write.** `StorageFull` has a sentence and no evidence:
  every failure here happened at `File::create`, before a byte was written. The
  error from a write that starts and cannot finish comes out of `StoreError::Io`
  instead, which still renders its `io::Error` whole — errno and all.
- **A screen reader.** Still nobody has heard the queue announcements, and these
  new sentences are drawn into the same `role="alert"` nobody has listened to.
