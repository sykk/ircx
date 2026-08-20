# End-to-end run 36: the three answers, against a server that misbehaves

Walked 2026-08-20 against `ergo` 2.19 on loopback, release builds, `Xvfb :90`.
The instrument is `docs/end-to-end-36/`.

## The question

Run 35 found three defects. All three were fixed, each with tests, and **none of
the three had ever been watched in the assembled app** — which is the same gap
run 35 itself was written to close, one turn later.

They are worth taking together because each was invisible to a different part of
the stack, and for a different reason:

- the reaction casemapping needed **a server behaviour ergo does not have**;
- the favourite star needed **a machine that reports a pointer**;
- the picker needed **layout**, which jsdom does not do.

So: do the three hold in the window? And the one nothing could provoke — can it
be provoked at all?

## The instrument

Run 35's shape, unchanged: `walk.py` holds the window and every socket in one
process, driven from a FIFO, so the order of a line and the photograph after it
is stated rather than hoped for. `irc.py` is run 35's.

What this run adds is **a proxy that lies**. Run 34 and 35 put a transparent
pipe between ircx and ergo because the app's own raw log records what it queued
rather than what it wrote. The same wire is the only place the missing server
behaviour can come from, so `proxy.py` now rewrites in one direction — server to
client — in exactly two ways:

- **`CASEMAPPING=ascii` becomes `CASEMAPPING=rfc1459` in `005`.** ergo goes on
  folding `ascii` underneath; only ircx is asked to believe it. Under that
  folding `[` and `{` are one character, which is the case
  `docs/manual-verification.md` records as unwalked and the one no amount of
  lowercasing would catch.
- **The source nick of a `TAGMSG` is re-cased**, by rules the walk writes
  between steps. `TAGMSG` only, so the roster still learns everybody from `JOIN`
  and `353` under the casing they really have. The variable under test is one
  line's spelling against a member list that disagrees with it, which is what a
  re-casing server produces and nothing else in this harness could.

Both halves are on the wire and both are logged (`recase-wire.txt`):

```text
<< … CASEMAPPING=rfc1459 …
** rewrote: casemapping ascii -> rfc1459
<< @msgid=…;+draft/unreact=👍;+reply=2dp4… :SABLE{M}!~u@… TAGMSG #run36
** rewrote: sable[m] -> SABLE{M}
```

**Everything below was run twice**, on the release build of `15f5a49` and on the
release build of `9d2c762` — the merge-base before the three fixes — with the
same proxy, the same server and the same commands. A result that appeared on
both would have measured nothing.

## The reaction nobody could clear

`sable[m]` joins, says a line, and reacts `👍`. The chip reads `1` and the
roster reads `sable[m]` (`chip-present.png`). The proxy is then armed and the
same client takes the reaction back — arriving as `SABLE{M}`, which is one
person under rfc1459 and two under string equality.

**Fixed: the chip clears** (`recased-unreact-clears.png`).
**Control: the chip stays** (`control-chip-stays.png`) — two frames of the same
row, before and after, and the `👍 1` is in both.

That is the defect, provoked for the first time: a reaction that cannot be taken
back, on a message that keeps a chip for somebody who is no longer on it.

The add path folds too. With the rule armed, a react as `SABLE{M}` and a second
react as `sable[m]` leave **one** chip reading `1` — the same person twice, not
two people.

## Your own reaction, counted twice

This is the half that needs no exotic peer. `send_react` draws the chip locally
under `self.nick`; the `echo-message` copy comes back spelled however the server
likes. With the proxy re-casing `walker36` to `WALKER36`, the reader types
`/react <msgid> hot` into the composer and ircx puts one clean line on the wire:

```text
>> @+reply=6zfgw7rcmxtuhng94pgdays7bi;+draft/react=hot TAGMSG #run36
```

**Fixed: `hot 1`, outlined in the accent** (`own-echo-one-person.png`) — one
person, recognised as yours.
**Control: `hot 2`** (`control-own-echo-twice.png`).

One reader, one reaction, counted twice, against a server doing nothing worse
than choosing a capitalisation.

## The picker at the top of the scroller

The compact picker measures **40px**, so with its gap it needs 44 above the chip
it hangs from. Opened where there is room it opens upward over rows that painted
before it, which is correct and is what both builds do.

Driven to a row whose chips sit 30px below the timeline's top:

**Fixed: it opens downward**, clear of the channel header
(`picker-opens-downward.png`).
**Control: it opens upward and is sliced off** at the timeline's top edge, about
half of it missing, the top row of emoji neither visible nor clickable
(`control-picker-clipped.png`).

**That is not quite what run 35 photographed.** Run 35 recorded the picker
painting *out over the channel header*; at this run's scroll position the same
cause shows as clipping instead. Both are one picker opening upward with nowhere
to go, and which of the two a reader sees evidently depends on where the row
sits when they click. The fix answers both, because it stops the picker opening
into room it does not have rather than tidying up what happens when it does.

## The control that is drawn only for a pointer

The full picker's footer says *529 emoji · hover ☆ to favorite* and not one star
is drawn, which is the media query run 35 identified. Tabbing to the eggplant's
cell, three frames each — no focus, focus on the emoji button, focus on the star
itself:

**Fixed** (`star-on-focus.png`): nothing, then **the ☆ appears** when the emoji
button takes focus, then the star drawn with its own focus ring.

**Control** (`control-no-star.png`): nothing, nothing, and **nothing** — the
third frame is a focused button the window does not draw at all, ring included.
A reader tabbing through that grid passes through a control that does not exist
on screen.

## What the harness cannot do, and did not say so

**`window.mjs` cannot type an emoji.** `type` goes through XTEST a keystroke at a
time, so a character with no keysym fails: `err no keycode for keysym 0xf0`. The
first two attempts at the paragraph above died there. `driver.mjs` is not
affected — it uses `Input.insertText` — and `SKILL.md` says as much about
punctuation without saying that the same limit puts every emoji out of reach of
the assembled app. A reaction's value has no restriction on it, so `hot` tests
the same path and is what this run used.

It bites twice, because **a failed keystroke leaves the composer dirty**. The
half-typed line stayed, the next attempt appended to it, and ircx sent

```text
>> @+reply=2dp4…ncnn/react;+draft/react=6zfgw7rcmxtuhng94pgdays7bi TAGMSG #run36
```

— a reaction whose value is a msgid, against a reply naming `<id>/react`. That
is the instrument's fault and not a defect: the specification puts no restriction
on the value, and ircx sent what it was told to send. It is recorded because the
line is in the log and somebody reading it later deserves to know why.

## What this does not claim

- **That any of this is ergo's behaviour.** The re-casing and the `rfc1459`
  claim are both the proxy's. What is tested is ircx against a server that does
  those things, not that a server in the wild does them — though a network
  folding `rfc1459` is ordinary, and the tests in `session.rs` are what pin the
  folding itself.
- **That another client drew any of it.** The peers on the socket parse; none of
  them renders. Same gap as every run since 33.
- **Anything about rows under the sticky author.** A click on a chip at y≈105,
  inside the band the sticky author occupies, sent nothing at all — no `TAGMSG`
  reached the proxy. The band was written down as the reason, and **that is not
  what happened**: `StickyAuthor` has carried `pointer-events-none` since
  `b8bae22` first drew it, and that commit is an ancestor of both builds walked
  here, so the click went through the band and landed on whatever the row had at
  that point. Most likely between two chips. **This run did not isolate it**,
  and the reading it wrote down was wrong.

  What the band does is paint. It is opaque, full width, and over the rows that
  scroll beneath it, so a chip on the topmost row is covered rather than
  unreachable — a reader has nothing to aim at, though a pointer put there would
  still land. That is the question worth walking, and it is not the one this run
  asked: not whether the control can be clicked, but whether it can be seen.
- **The archive.** No restart was done; every result above is the live path.
  Run 35 walked the restart and the rows it leaves.
- **Anything about timing.** Every step was driven and waited for.
