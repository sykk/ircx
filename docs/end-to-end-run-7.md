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

**Not fixed here**, and deliberately: both ways out — a pixel floor alongside
the share, or dropping the roster from a pane too narrow to hold it — need a
constant that would show up in every split at every size, and picking it is a
design decision rather than a walk's business. #367 records the measurement and
both options.

## What this run did not reach

- **A divider dragged in the assembled app.** All of the above is Chrome. The
  window harness has a real pointer through `xsend` but no selectors, so the
  same measurements there would be eyeballed off screenshots.
- **Touch.** Every event here was `pointerType: "mouse"`. A coarse pointer wants
  a target several times this size, and nothing in the client has been asked
  about one.
