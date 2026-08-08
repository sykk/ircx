# Protocol capability adapters

The sixth extension point, and the one #90 has called "the odd one out" through
three updates without saying why. This is why, and what it should be.

The other five sit outside the connection. A command runs when somebody types
it. An annotator and a notification rule run after a message has arrived, been
parsed and been written to the archive. All five are handed things that have
already happened.

An adapter is the only one that wants a hook on **the line**, which is the only
place a plugin could end up in the path of the connection itself. That is the
whole of the difference, and every question below follows from it.

Nothing here is built.

## What it is for

IRCv3 grows capabilities faster than any client implements them.
`crates/ircx-core/src/caps.rs` holds the closed list ircx knows how to act on,
and `session.rs` ends its dispatch with

```rust
_ => debug!(command = name, "no handler for this command"),
```

A server can be speaking a capability perfectly well and the client will drop
every line of it into a log. An adapter is how somebody adds one without
waiting for the client to grow it.

**The value is in the `CAP REQ`, not in the answer.** ircx only requests what is
in `SUPPORTED`, so a capability nobody here implements is never negotiated and
its lines never arrive at all. An adapter's first job is to make the client ask
for one; being handed the result is the second.

## What it may do

**Read only.** An adapter never writes to the socket.

Decided rather than assumed, and it is the constraint the other extension
points already rest on: `ircx.send` is closed because the bound that makes a
plugin's sends safe is the keystroke. A plugin writing to the connection sends
under the user's nick with nothing behind it, and a slow one stalls the
session rather than costing a note.

The cost is real and worth naming. **Handshake capabilities cannot be
implemented this way.** A capability where the server says something and expects
a reply — SASL's shape — needs a plugin that can answer, and this design says
no to that. What is left is every capability that only *tells* the client
something, which is most of them: presence, metadata, tags, batched history.

Two ways to answer that were weighed and refused. Letting an adapter write
freely gives up the keystroke bound entirely. Letting it declare in its
manifest which commands it may send bounds the blast radius to a list the user
agreed to, and still puts a plugin's bytes on the user's connection with no
keystroke — a smaller version of the same thing, sold as a smaller thing.

## The shape

An adapter declares the capabilities it handles:

```json
{ "adapts": ["draft/metadata-2", "draft/multiline"] }
```

Three consequences, in order.

**ircx requests them.** The names join `SUPPORTED` for the length of the
session. A capability the server does not offer stays off, exactly as one of
ircx's own does — an adapter cannot make a server speak something it does not
have, and asking for a name nobody recognises costs one word in a `CAP REQ`.

**It is handed lines nobody handled.** The `_ =>` arm above, and only that arm.
Not lines ircx understands: two handlers for one line is two answers that can
disagree, and the client's own is the one that has tests. A plugin cannot claim
`PRIVMSG` away from the timeline.

**It answers with notes, attributed.** The same shape an annotator answers
with, and for the same reason — it is the shape that cannot forge. An adapter
that wants to show something shows it as its own, named, beside the
conversation.

Lines are handed over **parsed**, as `Message`, not as bytes.
`crates/ircx-proto` has already done the work and done it once; handing over
bytes would mean every adapter reimplements tag parsing, and the first one to
get it wrong would get it wrong differently from the client.

## What it costs to run

An adapter runs where the annotator runs: **spawned, off the connection's
path**, on a batch of lines. Nothing about a slow adapter reaches the socket.
That is what makes read-only worth insisting on beyond the forgery argument —
a hook that could answer would have to be awaited, and then a plugin's runtime
is the connection's latency.

Strikes are the annotator's: three consecutive failed batches and the hook is
dropped for the connection, with the server console saying so.

## Two open questions

**Two adapters claiming the same capability.** The obvious answers are all
unsatisfying — first wins is arbitrary, both run means two notes about one
line, refusing the install is a hard error for something the user may not
understand. Probably both run and both are attributed, since attribution is
what makes two answers legible rather than confusing, but nothing has tested
that reading.

**A capability that changes how existing lines parse.** Every capability in
`SUPPORTED` is additive: it turns on tags or extra parameters ircx then reads.
A capability that changed the meaning of a line the client already handles
would put the adapter and the client in disagreement about something the
client believes it understands — and this design gives the client the last
word, which would be the wrong word. No such capability is known. It is
recorded because "no such thing exists" is a worse reason than "here is what
we would do".

## The rules, if it is ever built

1. An adapter declares capabilities and never writes to the socket.
2. Declared names join what ircx requests for the session, and a server that
   does not offer one leaves it off.
3. It is handed only lines no built-in handler took, parsed, in batches.
4. It answers with attributed notes, and with nothing else.
5. It runs off the connection's path, so slow costs a note and never a session.
6. It is struck and dropped like the other on-arrival hooks, and the console
   says when it is.

## Where this leaves the milestone

Four of the six extension points are built. `docs/renderers.md` designed the
fifth and recommended against building it. This designs the sixth and does not:
an adapter is the one whose value does not collapse into the annotator, because
the annotator cannot make a server send lines it was never asked for.

Whether it is worth building is a question about how much IRCv3 the client
intends to grow itself. Every capability an adapter would carry is one ircx
could implement instead, with tests and without a permission — and the argument
for the plugin is the same one that argues for any of them: somebody wants a
capability this client will never know about.
