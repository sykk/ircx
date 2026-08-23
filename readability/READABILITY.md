# Timeline readability

This document records the rules the shipped timeline follows. The exploratory
HTML studies that produced them are available in Git history; current behavior
is asserted in the timeline, theme, and token tests.

## Type, measure, and density

- Prose uses the text face. Protocol data, timestamps, fingerprints, commands,
  and other machine-shaped values use the monospace face.
- The conversation has a bounded reading measure. Alignment, message size, and
  measure are reader settings rather than theme tokens because they change what
  the component draws.
- Compact, comfortable, and read densities change only row padding, block gap,
  and body leading. Comfortable comes from the active theme; the other two are
  application settings.
- Long pastes and code blocks stay bounded and scroll in place. Link previews
  load only when the reader asks.

## Message runs

- Consecutive speech from one sender forms one run. A sender change, a five
  minute span, a group change, or a message kind that writes its own nick ends
  it.
- The run header states the sender and clock once. Readers may move the clock,
  change its format, add angle brackets, put the nick on every line, or turn
  either element off.
- Putting the nick on every line adds a prefix in the prose flow. It does not
  recreate a name column whose width moves the start of the message text.
- Timestamps and nickname color accelerate recognition; neither replaces the
  visible name.

## Grouping and the spine

Each message belongs to at most one group, based only on text people sent:

- A leading `[topic]` declares a named group. The bracket becomes the group
  label and is removed only from the rendered body; the archive keeps the
  original text.
- A leading `nick:` or `nick,` addresses a member of the channel. The exchange
  is between the pair that opened it. A third person answering opens another
  addressed group instead of extending the first pair indefinitely.
- Declared groups outrank addressed groups. Timing and participant guesses are
  not drawn: a live trial joined a single shared conversation into one rule
  spanning the screen, and changing the timeout only split it arbitrarily.

The spine carries the group and takes its hue from the person who opened it. A
message in no group keeps a neutral spine. A group keeps the spine when the run
mentions the reader because the row tint and line above the run already carry
the mention.

Turning the spine off removes the group hue. A declared group falls back to its
label, an addressed group to the participants' nickname colors, and the normal
gap returns between separate blocks of one group.

## System traffic and history

- Joins, parts, quits, nick changes, and mode changes may collapse into a
  presence digest. Kicks, topics, and other changes that affect the channel
  remain explicit.
- A server batch is the authority for multiline and history boundaries. The
  client does not invent a batch from timing.
- Server history is bounded by markers that distinguish replayed messages from
  live traffic. A search window that omits messages draws an explicit gap.
- Standard replies retain the server's severity and machine-readable code; the
  client translates the consequence rather than reclassifying it.

## Unread seam

The seam marks where unread messages begin and states the message count, people
count, elapsed span, and mention count available from the messages it bounds.
It never summarizes what people said or assigns a verdict to the missing text.
Server read markers and local unread state both survive history replacement.

## Nick colors

Nickname hues stay inside 186–335 degrees so identity does not collide with
warm status colors. The token tests enforce the range and contrast. The full
nickname remains visible, so two people sharing a hue are still distinguishable
and turning nickname colors off loses no information.

IRC has no avatar, so the client does not invent one. Message runs are carried
by the name, spacing, and spine; roster entries remain colored names.

## Reactions and replies

- A reply quotes a bounded excerpt and names an unavailable parent instead of
  drawing an empty quote.
- A reaction chip names participants as well as showing its count. The reader's
  own reaction is written as `you`; a count alone is not used as a popularity
  score.
- Reaction, reply, and typing tags degrade to ordinary IRC when a server does
  not relay them.

## Member list

Every channel pane owns its member list. Operators and members form the two
visible groups; away state and rank remain visible within them. Large rosters
enumerate the useful prefix and state how many names remain, with filtering as
the route to the complete list.

The roster yields to the conversation below the measured pane width. A member
list without readable message text is not a useful pane.

## Deliberate omissions

- No encryption verdict or encryption interface ships in this milestone.
- No inferred conversation grade is drawn.
- No summary hides messages or states what their content means.
- No message action is placed in a context menu solely to make the feature
  easier to discover.
