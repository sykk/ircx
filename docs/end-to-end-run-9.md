# The ninth run: `color-scheme`, which turns out not to be the question

Run on 2026-08-03 against a local `ergo`, in the assembled app on `Xvfb :90`.

`docs/manual-verification.md` left one thing from the themes walk:

> **`color-scheme` on a real window.** The manifest's `appearance` is written to
> the root element, which is what makes native scrollbars and form controls
> flip. The root attribute is confirmed; the run had no native scrollbar or form
> control in view to watch flip, so what the attribute *does* is still unseen.

Both halves of that turn out to be wrong, in opposite directions.

## The scrollbar was never `color-scheme`'s

Sixty lines flooded into `#scheme` to make the timeline scroll, then the thumb
sampled either side of a theme change:

```text
ircx Dark    thumb rgb(49,58,70)      page rgb(10,13,18)
ircx Light   thumb rgb(206,212,218)   page rgb(255,255,255)
```

It flips. It is not a native scrollbar. `src/styles/global.css` styles it:

```css
::-webkit-scrollbar-thumb { background: var(--border-strong); … }
```

and `--border-strong` is `#313a46` in the dark theme and `#b6bfc9` in the light
one — the dark reading is that token exactly, and the light one is it blended
with the white track through the thumb's 2px transparent border. So the
scrollbar follows the theme's tokens and would do so with no `color-scheme`
anywhere. The entry credited the wrong mechanism.

The same goes for the form controls it names. `fields.tsx` gives every input and
select `bg-[var(--surface-base)]`, a token border and token text, so what they
look like is the theme's doing too.

## What is left is a black popup on a white sheet

Which leaves the one surface the page cannot style: the list a `<select>` opens.
`01-light-theme-black-popup.png` — ircx Light in force, the archive sheet white,
and the retention dropdown opening a panel with a black background, white text
and a blue selection bar that is in no theme this client ships.

`02-dark-theme-same-popup.png` is the same control under ircx Dark. Cropped to
the popup and compared:

```text
compare -metric AE popup-light.png popup-dark.png   ->   0
```

Zero differing pixels. WebKitGTK draws that popup with the GTK theme, and
`root.style.colorScheme` — which `apply.ts` sets from the manifest's
`appearance`, correctly — does not reach it.

So the answer to "what does the attribute do" is: on this platform, for this
client, nothing anyone can see. Everything it was supposed to govern is already
governed by tokens, and the one thing tokens cannot reach ignores it. #375.

## What this changes

Nothing in the code. `color-scheme` is still right to set — a platform that does
honour it costs nothing here, and the attribute is what a future control would
need. What changes is the record, which had this down as unverified when it was
really unverifiable in the terms it was written in.

The defect it uncovered is a different entry: a light theme is light until
somebody opens a dropdown. Fixing that means drawing the list rather than asking
the platform for one, which is UI work with a design decision inside it — the
mockup is deliberately minimal and a custom listbox is more chrome, not less —
so #375 carries it rather than this.

## What this run did not reach

- **Any other platform.** This is WebKitGTK. A `<select>` popup on macOS or
  Windows may well follow `color-scheme`, and the entry above is a statement
  about the one window this project builds today.
- **A theme arriving while the palette is open**, still, which was the other
  thing run 6 left behind.
