# ircx — readability studies

Nine exploratory studies attacking the "hard to read" complaint, drawn against
`docs/design/ircx-design-handoff.md` rather than around it. Open
`ircx-readability-studies.html` — it is one self-contained file with no network
resources, and the theme and density controls in its header are live.

The premise is that "readability" names six distinct failures that get reported as
one: flat weight, no author grouping, presence churn outranking speech, interleaved
conversations in a single column, unbounded line measure, and a verdict that
repeats itself into invisibility. Each study takes one.

Handoff §1 — a verdict is unforgeable, always present, and readable without a
legend — is treated as fixed. Every proposal below was checked against it, and the
one that comes closest to the line (§4.1, the gutter) is argued for explicitly
rather than assumed.

## The studies

**01 — the same six messages.** Today's pane beside the same content with author
grouping, a reading measure and a verdict spine. The nick `sable` is printed three
times on the left and once on the right; the word `encrypted` likewise.

**02 — the verdict spine.** The fixed-width right-hand gutter becomes a coloured
rail down the left of each run, with the word printed at the head of the run and a
sticky header naming the verdict at the top edge of the viewport. Always present,
never truncated, still words rather than only colour — and a verdict *change* now
ends a run, so structure carries the security event instead of burying it in the
fortieth identical row.

**03 — presence is weather, not speech.** Joins, parts, quits, nick changes and
mode flips collapse into one line of prose, expandable in place. The governing rule
is that an event may be digested only if it changes nothing about who can read the
conversation; anything that does is named in the digest's first clause in
`attention` colour and has no setting that hides it.

**04 — strands.** Inferred conversation strands, indented, with a focus mode that
dims rather than hides and is never persisted. A real reply carried over
`message-tags` gets a solid connector and a quoted excerpt; an inferred one gets a
dotted connector. A heuristic is never drawn to look like a protocol fact.

**05 — three densities.** Compact for operators and log reading, comfortable for
being in the conversation, read for nine hours of backlog. Compact is *denser* than
today's pane, because the verdict no longer occupies a fixed 62px column.

**06 — nick colour, and how much work it is allowed to do.** Ten hues generated
inside 186–339°, each solved numerically for the lowest lightness clearing 5:1
against the pane. There is no avatar in IRC and this design does not invent one:
the identifier is a string, written out in full on every block header, so colour
is reinforcement rather than a carrier. Turn it off and nothing is lost but speed,
which is also why ten hues is enough — two people sharing a colour still have
different names.

**07 — most of what IRC carries is not prose.** URLs become domain-forward chips,
pastes become bounded blocks with a stated line count, attachments become offers,
fingerprints keep their groups of four. Prose gets the text face; data keeps
monospace.

**08 — the seam.** The unread divider states the size of what you are about to
read, how many messages mention you, and how many times the verdict changed while
you were away — the one part of a catch-up summary a reader cannot reconstruct by
skimming.

**09 — all of it in one window.** Twenty networks, 147 buffers, the full four-column
layout with a live scroll area.

**10 — what this would change in the handoff.** A section-by-section delta.

## Two findings against the current design

Both were measured, not eyeballed. Both are reproducible from the files in this
repository.

### 1. The nick palette collides with the security palette

`docs/design/mockups/dark/01-main-window.html` draws `sable` in `#1D9E75` and
`tsutomu` in `#BA7517`. Those are handoff §3.1 `protected` and `attention`
*exactly*. In that same mockup, `tsutomu` — rendered in the colour that means
"encrypted, all devices verified" — is sending plaintext.

A twelve-entry palette assigned by hash of nickname has no way to avoid this
today, because nothing constrains where the twelve entries sit.

**Proposed:** warm hues are reserved for security. Identity lives in the cool half
of the wheel, 180–350°, and the palette is generated inside that band rather than
listed, with a 20° margin around each security hue.

### 2. The dark security palette does not meet AA on the project's own surfaces

Handoff §8 states the §3.1 values "meet WCAG AA against both the light and dark
defaults". Measured against the dark surfaces in `docs/design/mockups/tokens.css`:

| role | value | on `#1a1a19` | on `#262625` | on `#333331` (the pane the mockups use) |
|---|---|---|---|---|
| protected | `#1D9E75` | 5.14 | **4.47** | **3.74** |
| attention | `#BA7517` | 4.68 | **4.07** | **3.40** |
| refused | `#E24B4A` | **4.43** | **3.85** | **3.22** |

Bold values fall below the 4.5:1 floor for body text. The light values pass
everywhere and need no change.

**Proposed replacements**, each solved to clear 4.5:1 on the *lightest* dark
surface the project uses, which makes them safe on every darker one:

| role | proposed | on `#333331` | on `#1B1B1A` |
|---|---|---|---|
| protected | `#1FAF86` | 4.54 | 6.18 |
| attention | `#CF8D1A` | 4.51 | 6.14 |
| refused | `#E77B79` | 4.53 | 6.16 |

These are what every mockup in the studies renders.

## Handoff delta

| Section | Status | Change |
|---|---|---|
| §1 the rule | unchanged | Verdicts stay words, untruncated, unforgeable, unthemeable. |
| §3.1 palettes | correction | Dark security values replaced; see finding 2. |
| §3.1 nick palette | correction | Constrained to 180–350° and generated; see finding 1. |
| §3.2 type | amend | "Monospace throughout" becomes semantic: prose in the text face, data in monospace. The largest departure here, and the one most worth arguing about. |
| §4.1 gutter | replaced | Left spine + per-run word + sticky viewport header. The yield-order ladder is deleted rather than rewritten, because nothing about the verdict is width-negotiated any more. Closes open question §10.5. |
| §4.2 member list | unchanged | Two-group split and enumerate/count asymmetry preserved. |
| §4.3 refusal | unchanged | Same two lines, same square corners, same absence of a one-click override. |
| §5.1 main window | amend | Message pane gains a reading measure and a density setting; fixed column widths become minimums. |
| new §4.5 | add | Presence digest, and the rule that bounds what may be digested. |
| new §4.6 | add | Strands, and the solid/dotted distinction between a protocol reply and an inferred one. |

## Deliberately not proposed

No message action was added to a context menu — §4.4's argument that a one-click
menu is the wrong home for anything dangerous applies equally to anything new. And
no summary, digest or catch-up view ever states a verdict on behalf of messages it
collapsed; the seam counts the changes and points at them, and the messages still
carry their own.

## Open, and not resolved here

- Whether §1 accepts a verdict printed once per run. The fallback if it does not is
  once per author change — roughly a fifth of today's repetition, and the word still
  on screen at all times.
- Whether the strand heuristic (leading nick mention within a short window) is worth
  shipping before phase 13 lands real replies, or whether an inferred strand is a
  guess the client should not be making at all.
- Whether the digest's "loud clause" vocabulary should be a closed set the way the
  verdict vocabulary is.

## A note on avatars

There is no avatar in IRC, so nothing in these studies stands in for one. Author
blocks are carried by the spine, the block spacing and the nickname itself —
which is the real identifier and is written out in full on every header. Rosters
are plain coloured names. The nick colour links a roster entry to a block, and
that is the whole of its job.

## Verification

The studies were checked programmatically, not by eye:

- every rendered verdict is one of the five §4.1 strings, and none is clipped or
  ellipsised in either theme
- every text node in every mockup clears its WCAG AA threshold against its
  composited background, in both themes — 0 failures
- no all-caps strings anywhere, per §7 and §8

---

# Part two — live channel studies

`ircx-live-studies.html`. Nine more studies (11–19), same controls. The premise
changes in one significant way: **the verdict word is out of the message stream
entirely.**

## The band and the exception

Studies 01–10 printed the verdict once per author run. Study 11 removes it from
the run as well, on the argument that a verdict is a fact about the
*conversation* and printing it per-message states it in the wrong scope.

What replaces it:

- **A band** at the point the conversation's verdict starts or changes — a
  coloured rule with the word and a clause saying why (`encrypted — 9 allowed
  accounts hold session 4f21`).
- **The spine**, unchanged, running down each author block.
- **An exception pill**, printed on a message *only where it departs from the
  band*. In an encrypted channel, encrypted messages carry nothing; the one
  plaintext message carries `plaintext` in a bordered pill with its consequence
  written underneath.
- **The sticky viewport header**, which cannot scroll away.
- **The status bar**, and the per-message answer on hover, focus, selection and
  `Copy with verdict`.

The degenerate case is a channel where the verdict genuinely alternates. The rule
that prevents the design from lying about it: **when exceptions exceed a third of
the visible messages, the band restates itself as `mixed` and every message
carries its word again.** The design falls back to the honest, noisy rendering
exactly when the conversation is mixed, and never earlier.

This is the one change that needs an explicit decision on §1. "Always present"
has to be read as *present in every viewport* rather than *present on every row*.
Nothing else in either file depends on a reinterpretation of §1.

## IRCv3 rendered as interface

| Study | Capability | What it becomes |
|---|---|---|
| 12 | everything at once | #ircd-dev, 9 allowed / 47 present, eleven speakers, one bot, two exception pills in the whole stream |
| 13 | `batch` | netsplit/netjoin collapse to one sentence; `chathistory` backfill with both clocks; `draft/multiline` as one message with four paragraphs |
| 14 | `message-tags` | reactions with names not just counts, replies quoting one line at one third weight, edits that say they edited, and the `account` tag on every block |
| 15 | standard replies | `fail` / `warn` / `note` with command, code and consequence, against the numerics they replace |
| 16 | `away-notify`, `account-notify`, `extended-join` | away in the roster and the input line; an account change as a security event caught when it happens |
| 17 | capability negotiation, SASL, STS | `/caps` — enabled and absent in one list, every absence followed by what it costs |
| 19 | grouping provenance | three grades — declared, addressed by name, guessed — ranked by stroke weight and style; only the guess is dismissable |
| 18 | all of it, at public scale | #libera-dev, 1,240 people, plaintext, roster sorted by operators → recent speakers → a sentence |

### Grouping provenance (study 19)

The strand model in studies 04 and 12 was a binary — solid connector for a
protocol reply, dotted for an inferred one. That is one grade short. A bracketed
topic the sender typed is a **fact**; IRC's `nick:` addressing convention is
**near-certain**; everything else is a **guess**. Three grades, ranked by stroke:

- **declared** — 2px solid, and the only grade that carries a *name*, because it
  is the only one a human named
- **addressed** — 1px solid, unnamed; the label is the participants and the basis
- **guessed** — 1px dashed, labelled `by guess`, and the only one with a dismiss
  affordance

Certainty spends no hue. It is ordinal and hue is not, so three hues would read as
three categories a reader has to memorise; weight and stroke read as more-to-less
at a glance, in greyscale and in a screenshot. Warm stays reserved for security,
cool for identity, and grouping — which is the client talking about itself — gets
neither. (The reference sketch this came from rendered the declared header in the
`protected` green, which is finding 1 arriving from a different direction.)

**Colour on the rule.** In a conversation whose verdict is uniform — every public
channel, all the time — the per-message spine is restating what the band already
said, so it goes, and the group rule becomes the only vertical line. Its hue is
then free to carry *which strand*, taken from the nick colour of whoever opened
it. Hue answers "which" and has no order, which is what a strand needs and exactly
why it was wrong for certainty; weight and stroke keep answering "how sure". Two
independent questions on one line, and neither can be mistaken for the other
because one is a colour and one is a thickness. Every grade gained a pixel when
colour joined — 1px does not carry enough ink to judge a hue.

The spine returns the moment a message departs from the band, in the security
colour with its pill, and returns on every line in a `mixed` conversation. Then
there are two coloured rules, and the warm/cool split from finding 1 keeps them
apart: cool outer rule is a strand, warm inner spine is a verdict.

The cost, stated plainly: dropping the spine takes away the author block's left
edge, and with the monogram chips gone too, an *ungrouped* message is held by
spacing and its header line alone. Inside a group the rule does that job; outside
one, nothing does. Survivable — an ungrouped message is usually a single line —
but it is the load-bearing assumption, and if ungrouped multi-line messages read
as loose, the fallback is a neutral low-weight spine everywhere and living with
the two-grey-rules problem.

The rules: declared beats addressed beats guessed and a message is in at most one
group; only the guess is dismissable, in place, without moving anything; no grade
reorders, filters or hides; the verdict spine is never dashed at any strength, so
dashed can only ever mean "the client grouped this"; a declared name is
sender-typed text and renders in the body face, never in chrome and never in the
security palette; and a guess below a size and confidence floor is not drawn at
all.

Three rules came out of building these:

**A `batch` is the only collapse the client may perform on the server's
authority.** Everything else on these pages is the client guessing. That makes
batches the highest-value readability capability in IRCv3 — and it means a
netsplit summary must state whether anyone who left held a key, because that is
what decides whether the session rotates.

**Severity is the server's word.** ircx never promotes a `WARN` to a refusal or
demotes a `FAIL` to a note. It is rendered lower case, though, because §7 forbids
capitals for emphasis and §8 gives the reason — a screen reader spells `FAIL` out
as four letters. The machine-readable code stays verbatim in monospace inside a
bordered chip, which marks it as quoted rather than written.

**Rendering reactions changes what the status bar has to say.** A reaction is a
client tag on a `TAGMSG`, so on a plaintext channel the server can read it. The
status bar clause becomes `server sees membership, timing and reactions`. Adding
a feature that leaks metadata obliges the interface to name the leak.

## Delta, continued

| Section | Status | Change |
|---|---|---|
| §1 the rule | clarify | "Always present" = present in every viewport, not on every row. Needs an explicit decision. |
| §4.1 gutter | rewrite | Band + spine + exception + sticky header, with the one-third `mixed` fallback. |
| new §4.7 | add | Batches. Only the server may authorise a collapse. Netsplit summaries state the key consequence. `chathistory` batches carry their own band, a dashed edge and both clocks. |
| new §4.8 | add | Standard replies. Severity is never re-decided; unknown codes render with a stated absence. |
| new §4.9 | add | Reactions and the metadata clause. |
| new §5.x | add | `/caps` — every absence followed by its consequence, ending with `what is not here`. |
| §4.2 member list | extend | Away is a roster and input-line state. At scale the roster sorts operators → recent speakers → a sentence; the filter is the completeness route. |

## Still open

- Whether one third is the right `mixed` threshold, or whether it should be a
  per-buffer pin.
- Whether the `account` chip belongs on every message or only on the first block
  from that account in a session.
- Whether encrypted reactions are worth their metadata — a sealed reaction still
  tells the server that someone reacted to something.
