# The tenth run: eleven changes, together

Run on 2026-08-03 against a local `ergo` on `127.0.0.1:6667`, in the assembled
app on `Xvfb :90`, against `main` at `5ce471e`.

Eleven changes went in today and every one was verified on its own — a browser
walk, a scripted session, a store test. None had been seen with the others in a
real window. This is that, and it found nothing, which is the result worth
writing down at the same length a defect would get.

What was in the build: the divider's centred rule and the roster drop, the
280px pane floor, the export error sentences and the file they name, the unread
count across a replay, drafts going with their network, EXTERNAL out of the SASL
picker, the wildcard-host refusal, the plugin fetch tests, and the theme opening
on the installed one.

## The roster rule, in WebKitGTK

`01-two-panes-keep-their-rosters.png`. Split side by side on a 1200px window:
two panes of about 480px, **both keeping their member lists**.

`02-narrow-panes-drop-them.png`. Split again: the left pane keeps its roster at
480px and the two on the right, about 240px each, **drop theirs** — each with a
conversation that still reads, text wrapping at word boundaries, both composers
present.

That is #367's rule seen in the app rather than in Chrome. The browser walk
established the threshold and measured the boundary; this is the same rule in
the engine that ships.

## What that turned up, which is not a defect

**Splitting can make a pane narrower than dragging can.** The floor added for
#367 clamps a *drag*: `Divider` refuses to leave either side below 280px.
Splitting does not go through it — `splitActiveView` halves what is there — so a
third split on a 1200px window gives 240px panes, which no drag would allow.

Left alone deliberately. Those panes read: the roster is gone, the text wraps at
word boundaries and the composer works, which is exactly the state the roster
drop exists to produce. And the alternative — refusing to split — would be worse
on a small window, where somebody wanting two panes would get none. What the
floor is for is stopping a drag from destroying a pane by degrees; what a split
does is make an even, deliberate one.

Recorded rather than filed, because it is the floor's scope rather than a fault
in it.

## The rest of the build

- **The archive sheet** opens and reads `45 messages, 136 KB on this machine`,
  with both export and both delete buttons and the two retention windows.
- **The plugins sheet** opens on `Nothing installed`, after a day in which
  `manifest.rs` gained a validation rule.
- **The app connected, joined, and drew history** — `HistServ` replaying the
  join, the `Live from here` seam under it, the topic-locked notice.

Nothing to report about any of them, which is the point of looking.

## What this run did not reach

- **A drag in the assembled app.** `window.mjs` has a real pointer through
  `xsend` but no drag command, so the divider's geometry stays a Chrome
  measurement — which is the right instrument for it, and
  `docs/end-to-end-run-7.md` says why.
- **The SASL picker without EXTERNAL.** Network settings are reached from the
  sidebar rather than the palette, and the removal is a list entry that the
  frontend tests and the typechecker already cover.
- **Unread across a real drop**, still. It wants a proxy cut, which
  `docs/manual-verification.md` has wanted for a while.
