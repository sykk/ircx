# Message renderers

The fifth extension point, and the only one that has to argue with the rule the
other four are built on: **a plugin may not change what somebody else said.**

`docs/plugins.md` holds that rule as a type. No host function takes a message
the plugin did not write and returns a different one, and the same document
already spends the renderer's inheritance:

> A message renderer may annotate — its own text, attributed, beside what it is
> about — and may not transform.

Which is the annotator, and the annotator is built. So the honest question is
not "how do we build a renderer safely" but **whether anything is left once the
rule has taken its share**. This note says what is left, what it costs, and
what it must never be allowed to do.

Nothing here is built. `render-content` exists as a permission and governs
something else — what a plugin may show *of its own*, in a command's answer.

## What people actually want one for

Worth listing before designing anything, because the list decides the shape.

| Want | What it does to the message |
|---|---|
| Highlight a pasted diff or code block | colours the sender's own characters |
| Collapse a wall of output | hides the sender's own characters, revealably |
| Mark a spoiler | hides the sender's own characters until asked |
| Turn `#4213` into a link to the tracker | adds a destination the sender did not write |
| Render a formula as an image | replaces the sender's characters with something else |

The first three change **how** the sender's bytes are drawn. The last two
introduce something the sender did not send. That line is the whole design.

## The shape that survives the rule

A renderer is handed a message and answers with **spans over that message's own
text** — never with text.

```
{ from: 12, to: 31, as: "code" }
```

`as` comes from a closed set the host defines and draws: `code`, `dim`,
`emphasis`, `hidden`. The plugin chooses where and which. It never chooses
what, because it is never asked for characters.

That is what keeps the rule intact rather than merely respected. The bytes on
screen are the bytes that arrived; the archive is untouched; a selection copies
what was said; search matches what was said. None of that needs enforcing,
because there is no path by which a plugin could supply a character that
reaches the body of somebody else's message.

Offsets are checked against the message and dropped when they do not fit, the
way `annotate` drops a note naming a message that was not in the batch. A
plugin that miscounts gets nothing, not a panic and not somebody else's line.

## Hiding is forgery, and the closed set is not enough

`hidden` looks like a style and is not. Hide four characters of

> I do **not** agree with the patch

and the sender appears to have said the opposite. No sandbox helps: the
isolation is sound and the lie is in what the plugin was legitimately allowed
to return. It is the same failure the rule exists to prevent, arriving through
omission rather than substitution.

So the rule needs its second half:

**Nothing a renderer does may make text vanish without leaving a mark that text
is there.** `hidden` draws a control in place of what it hides and says how
much. A reader who sees no mark is reading everything that arrived.

This is not a detail of the `hidden` style. It is a constraint on the whole
closed set, and any style added later has to answer it: `dim` at an opacity
low enough to be unreadable is `hidden` wearing a different name.

## Links are content, and stay out

Turning `#4213` into a link is the one on the list that reads as harmless and
is not. The destination is a string the plugin supplies, and a plugin that can
choose it can make the text say one thing and the click do another. That is
forgery with extra steps, and it is worse than rewriting the message because
the message still reads as the sender's own.

Two ways out, neither free:

- **Show the destination.** The reader sees where it goes before it goes there.
  The client already does this for links in a message body, so the machinery
  exists — but a link nobody typed sitting inside somebody's sentence is a
  claim about that sentence whatever the hover says.
- **Leave it to the annotator.** A note beside the message reading
  `#4213 → bugs.example.com/4213`, attributed to the plugin, in the plugin's
  own words. Nothing is inserted into anybody's sentence.

The second is what the annotator is for and it is already built, so links are
**out of scope for renderers** and stay with `annotate`. Substitution — a
formula drawn as an image, an embed — is out for the same reason and by a
wider margin.

## What it costs to run

This was the original blocker on the whole of #90:

> a renderer runs per message drawn rather than per command typed, which is a
> different budget and nobody has measured it

The annotator answered that question rather than dodging it, and its answer
carries here. It runs **on arrival, in batches**, and what it produces is
written to the archive beside the message. `docs/measurements.md` holds the
figures: 0.0014 ms to find no annotators at all, 0.207 ms for a batch of fifty.

Spans can be computed on exactly the same terms — on arrival, per batch, stored
with the message, applied at draw. Then a renderer costs what an annotator
costs, on a path that has been measured, and nothing runs while a timeline
scrolls. A renderer that ran per draw would be a new budget and would need its
own measurement first.

Failure is the annotator's too: three consecutive failed batches and the hook
is dropped for the connection, with the server console saying so.

## What it is worth

Stated plainly, because it decides whether this gets built at all.

Two of the five wants survive: **highlighting** and **collapsing**. Spoilers are
a client feature rather than a plugin one — a sender marking their own text
does not need somebody else's code. Links and substitution belong to the
annotator, which exists.

So the case for renderers is syntax highlighting and folding long output, and
the cost is a new hook, a new permission, a span type with offset validation, a
closed style set with the no-vanishing rule, and archive storage per message.
That is a real amount of machinery for two features that the client could
plausibly do itself — it already renders code blocks, and `Markdown.tsx` already
caps a paste at 260px and scrolls it.

The recommendation is therefore **not to build this yet**, and to keep the
design note rather than the code. What would change that: somebody wanting to
highlight a syntax the client will never know about, which is the case a plugin
exists for and the case nothing in this milestone has produced.

## The rules, if it is ever built

1. A renderer is handed a message and answers with spans over that message's
   own text. It is never asked for characters and never supplies any.
2. Offsets that do not fit the message are dropped, not clamped.
3. Styles come from a closed set the host draws. A plugin cannot name a colour,
   a size or a font.
4. Nothing may make text vanish without a mark saying text is there.
5. No destination, no substitution, no insertion. Those are annotations, and
   the annotator is built.
6. It runs on arrival in batches and its answer is stored, so a scrolling
   timeline runs no plugin code.
7. It is struck and dropped like the other on-arrival hooks, and the console
   says when it is.
