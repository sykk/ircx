# The seventh run: the divider, dragged

Run on 2026-08-03 in Chrome through `driver.mjs --seeded`, at 1200×800 and then
at 760×640.

`docs/manual-verification.md` says of resizing a split: *"`PaneTree.test.tsx`
drives the divider with a mocked rectangle, because jsdom lays nothing out. So
every figure in those tests is one this file supplied, and what nobody has done
is drag one."* Three things follow from that, and this run does all three.

Chrome rather than the window harness on purpose. This is a question about
layout and pointer geometry, which is what a browser answers and WebKitGTK
cannot be asked — there are no selectors there, and every figure below is a
measurement rather than a look at a screenshot.

## What the harness needed

`driver.mjs` could click and could not drag. `click` calls `el.click()`, which
dispatches one event and moves no pointer; a divider that works by
`pointerdown` / `pointermove` / `pointerup` with `setPointerCapture` on it
cannot be operated that way at all.

- **`drag <sel> <dx> <dy>`** presses at an element's centre, moves in twelve
  steps and releases, through `Input.dispatchMouseEvent` so Chrome synthesises
  the pointer events exactly as it does for a hand on a mouse. In steps because
  the handler reads the pointer's position on every move, and one 300px jump
  would exercise a single reading of it.
- **`dragxy <x> <y> <dx> <dy>`** does the same from a point. A selector always
  lands dead centre, so it is the only way to ask what a target catches.
- **`size <w> <h>`** sets the viewport, because a floor stated as a share
  behaves differently at 760px than at 1200 and that difference is the question.

## Whether the divider can be hit

It draws a 1px rule inside a 4px box. The four pixels are there. They are not
where the eye is.

`Divider` is `w-1` and drew its rule with `left-0`, on the box's leading edge,
so the whole target lay to the right of the line. At 1200px with the divider at
x=720:

```text
718  no movement   aria-valuenow 50 → 50
719  no movement   aria-valuenow 50 → 50
720  drags         aria-valuenow 50 → 56
```

Aim at the rule, land a pixel short, and you have pressed a pane. The divider
does not move and nothing says why — and a pointer is as likely to fall short as
long, so half of every near miss was a dead press. #368.

The rule is centred in the target now. Same measurement after: the target is
still 720–724 and the rule is drawn at 721.5, so a press at 720 — a pixel and a
half short of the line — drags. Four pixels around what somebody is aiming at,
rather than four pixels beside it.

Whether four is *enough* is a different question and this does not answer it.
It is a measured ±2px now instead of an unmeasured 4px.

## A nested split

Holds, and the run is worth recording because the doc suspected it might not:
*"that falls out of the tree rather than being arranged, so it is worth watching
a three-deep layout rather than assuming it."*

Split side by side, then split the right pane top and bottom, then drag the
outer divider left by 260px — `02-nested-outer-dragged.png`:

```text
before   Pane width  50   x=720      Pane height  50   x=724  w=476
after    Pane width  23   x=461      Pane height  50   x=465  w=735
```

The outer ratio moved and the inner one did not. The inner divider kept its own
50 and applied it to a span that had grown from 476 to 735, which is what the
tree was supposed to do and had never been watched doing it.

## The 15% floor on a narrow window

`03-floor-eats-the-conversation.png`, at 760×640, dragged all the way in.

The floor holds at `aria-valuenow=15`, and that is the problem rather than the
reassurance. Fifteen percent of that split is about 114px. The roster inside the
pane measures 157px — `rosterWidth` is `clamp(8rem, …, 13rem)` on a `shrink-0`
`<aside>` — so the roster is wider than the pane holding it, and it wins.

What is left of the conversation is the composer's hint text wrapped into a
column one word wide: `Markdown` / `Shift+Enter` / `is` / `for new` /
`supported` / `line`. The timeline is gone. The roster's longest nick clips at
the pane edge on the way out.

So the floor does not do what a floor is for. `MIN_SHARE = 0.15` keeps a pane
from vanishing, but a share cannot say "still wide enough to be a pane" on a
window whose width it does not know.

### Which of the two ways out, decided by measuring both

The pane was dragged to three widths at 1200px and the screenshots read:

```text
323px pane   04-pane-323-one-char-a-line.png   "morning" as m / o / r / n / i / n / g
403px pane   05-pane-403-reads.png             "sable: did the / pane branch / land?"
483px pane   01-an-even-split.png              comfortable
```

So a pane holding a roster wants about 440: the roster's 208px ceiling and the
232px of conversation that read. **A pixel floor of 440 was built and then
taken out again**, because the arithmetic kills the control. Two of them on the
960px a 1200px window has after the sidebar leaves 80px of travel — the divider
moves ±40px and freezes altogether below about 900px of window. The unit tests
said it first: a drag to 70% came back 56%.

**The roster gives way instead.** `ChatPane` is a `@container` and the roster
carries `@max-[440px]:hidden`, so it answers to the pane it sits in rather than
to the window — two panes side by side being one window and two very different
widths. Below 440px of pane the member list goes and the conversation has the
whole of it. The divider keeps its full range.

`06-roster-gives-way.png` is the same drag as `03`: at a 147px pane the roster
is gone and the timeline is there. Measured across the boundary — a 480px pane
shows its roster at 157px, a 410px pane shows none, and the pane on the other
side of the divider is untouched throughout.

**What that leaves, honestly.** At 15% of a 1200px window the pane is 147px, and
147px is too narrow to read whether or not a roster is in it — the text still
wraps to a character a line. Dropping the roster moved that from *impossible*
(no timeline at all, composer mangled) to *small*. Finishing it wants a modest
floor as well, and the arithmetic is now cheap: with no roster to fit, a pane
needs about 280px, which on that same 960px split leaves the divider 29%–71%
rather than 44%–56%. That is a second constant and a second decision, so #367
stays open carrying it rather than being taken here.

## What this run did not reach

- **A divider dragged in the assembled app.** All of the above is Chrome. The
  window harness has a real pointer through `xsend` but no selectors, so the
  same measurements there would be eyeballed off screenshots.
- **Touch.** Every event here was `pointerType: "mouse"`. A coarse pointer wants
  a target several times this size, and nothing in the client has been asked
  about one.
