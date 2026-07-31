# Plugins

A plugin is JavaScript with a manifest. It runs in its own QuickJS runtime on
its own thread and reaches the client only through the functions its grants
allow. `docs/plugin-isolation.md` is why QuickJS: a subprocess enforces two of
the seven permissions the spec names, and this enforces all seven, plus the two
the hooks that read on arrival add.

The extension points built are the **custom slash command**, the **annotator**
and the **notification rule**. Message renderers, link and attachment providers
and protocol capability adapters are the same shape — the host hands a value
over, the plugin returns one, the host applies a deadline — and are follow-up
work.

## What a plugin looks like

```
greeter/
  plugin.json
  main.js
```

```json
{
  "id": "greeter",
  "name": "Greeter",
  "version": "1.0.0",
  "description": "Says hello for you",
  "entry": "main.js",
  "commands": [{ "name": "greet", "summary": "Greet the channel" }],
  "permissions": ["add-commands", "send-messages", "access-channels", "render-content"],
  "channels": ["#ircx"]
}
```

```js
ircx.command("greet", (call) => {
  ircx.send(call.target, "hello " + (call.args || "everyone"));
  return "greeted " + (call.args || "everyone");
});
```

The manifest is what the plugin **asks for**. What it **gets** is a separate
file the user writes through the install dialogue, in the same shape, and only
that one is enforced. Nothing can be granted that was not asked for; anything
asked for can be granted less, and revoking is granting less again.

Commands are declared in the manifest, not discovered by running the plugin, so
typing `/greet` can find the plugin that owns it without starting a runtime.
Built-in commands always win: a plugin declaring `quit` never sees it.

## Installing one from the application

The command palette's **plugins** action opens the library. Installing asks for
a folder — the one holding a `plugin.json` and the file of code it names — and
copies those two files, and only those two, into `app_data_dir()/plugins/<id>`.
A plugin cannot arrive with its own `grants.json`.

Installing grants nothing, so the permissions screen follows immediately with
what the manifest asked for, each line written by `Permission::summary`. The
two scoped permissions ask where they apply: channels for `access-channels`,
hosts for `network-requests`, and the dialogue will not save a permission that
reaches nothing — a scope left empty, or sending and reading without a
conversation to do it in. That rule is the dialogue's; the library's floor is
`Grants::within`, which refuses anything the manifest never asked for.

**Installing over a plugin that is already there grants nothing either.** The
grants belong to the code the user was shown, and an id is only a folder name
that any manifest can claim, so a second install starts the question again
rather than inheriting the first one's answer.

The same screen is how a grant is taken back — `set_grants` writes exactly what
it is handed, so revoking is granting less. It takes effect on the next call: a
running session holds the runtime rather than a copy of the grants, and the
plugin's own thread is thrown away whenever they change.

## The host surface

Everything a plugin can reach, and nothing else. There is no `fetch`, no
`require`, no `process`, no filesystem and no socket —
`permissions.rs::a_plugin_finds_no_network_or_filesystem_global` asserts it.

| call | needs |
|---|---|
| `ircx.command(name, handler)` | `add-commands`, and the name declared in the manifest |
| `ircx.send(target, text)` | `send-messages`, and `target` among the granted channels |
| `call.messages` | `read-messages`, and the conversation among the granted channels |
| `ircx.annotate(handler)` | `annotate-messages`, and `annotates` in the manifest |
| `ircx.notify(handler)` | `raise-notifications`, and `notifies` in the manifest |
| `ircx.store.get/set/remove/keys` | `store-local-data` |
| `ircx.fetch(url)` | `network-requests`, and the URL's host among the granted hosts |
| the handler's return value | `render-content` |

A handler is given `{ command, args, target, nick, messages }` and answers with
text, or nothing. **Now**, not later: a promise is refused rather than waited
for, which is what keeps the deadline meaningful.

A plugin's answer is drawn as a client note, named with the plugin's id above
it. That name is the only thing separating it from `/help`'s output, which is
set identically, so it is not decoration: it is how a reader tells what the
client said from what somebody else's code said in their conversation. The
message carries the id in `ChatMessage.via`, which is archived, so a restart
does not turn a plugin's answer back into the client's.

A refusal is thrown into the plugin, so it can catch it and do less rather than
die — the same shape the client uses when a server is missing an IRCv3
capability. It is an `Error`, so a plugin that degrades can say why it did:

```js
try {
  ircx.fetch(url);
} catch (refused) {
  return "carried on without it: " + refused.message;
}
```

## What each permission means, and what enforces it

| permission | in plain terms | enforced by |
|---|---|---|
| read messages | Read the recent messages in the conversation it is used in | The host reads the archive only for a plugin that holds it, and the sandbox drops `call.messages` if handed any without it |
| send messages | Send messages under your nick, which nobody else can tell from your own | `ircx.send` throws; nothing else can reach the socket |
| add commands | Add slash commands you can type | Routing ignores plugins without it, so the command does not exist |
| store local data | Keep its own settings and data on this computer | `ircx.store` throws; it is the only writing a plugin can do, and only inside its own folder |
| access selected channels | Work in the channels you choose, and no others | Scopes both `ircx.send` and `call.messages`; `*` is every conversation and is a choice the user makes explicitly |
| make external network requests | Fetch data from the websites it names | `ircx.fetch` throws without the grant or off the granted hosts; only `http` and `https` are addresses |
| render message content | Show text in your conversations | A returned answer is refused without it, and sanitised with it |
| annotate messages | Read every message as it arrives in the channels you choose, and show its own note beside them | `Sandbox::annotate` refuses without it, and `annotators` does not offer the plugin at all |
| raise notifications | Read every message as it arrives in the channels you choose, and mark ones worth interrupting you for | `Sandbox::notify` refuses without it, and `notifiers` does not offer the plugin at all |

Sanitising the answer is the host's job under **every** isolation mechanism:
control characters go, and the output is cut to 40 lines and 8 KiB. Nothing
about a sandbox makes a returned string safe to put on screen.

## What a broken plugin costs

The requirement in #13 is that a broken plugin does not take the connection or
the application with it. `tests/failure_modes.rs` asserts it rather than
describing it: every failure mode is followed by a working plugin answering in
the same process.

| what it does | what happens |
|---|---|
| throws | reported against the plugin's name, runtime kept |
| loops, in JavaScript or inside the regex engine | interrupted on the deadline, runtime thrown away, loaded fresh next time |
| allocates without end | stopped at the memory limit, same |
| returns a promise | refused, because hooks are synchronous |
| tries to block on `Atomics.wait` | refused by this QuickJS build |
| sends without end | stopped at eight messages a command, and none are sent |
| does not come back at all | the host stops waiting after the deadline and the grace, abandons the thread, and carries on |

The last row is the backstop for the one thing the interrupt handler cannot
see: a host function that does not return. See the standing constraints below.

## Standing constraints

Four properties hold only as long as the host surface keeps them. They are
constraints on future work, not things already banked.

- **A plugin may not change what somebody else said.** It can add to a
  conversation and its addition is named — `ChatMessage.via` carries the plugin
  and the timeline draws it — but no host function takes a message the plugin
  did not write and returns a different one. The text beside a nick is what that
  person sent.

  This is a decision rather than an accident, and it is what the
  permissions are worth. A plugin that can rewrite a message can make someone
  appear to have said anything, and no sandbox helps: the isolation is sound and
  the lie is in what it was legitimately allowed to return. `render-content`
  governs what a plugin may show **of its own**, and nothing more.

  It bounds the unbuilt work as much as the built. A message renderer may
  annotate — its own text, attributed, beside what it is about — and may not
  transform. A protocol adapter handling a capability ircx does not know may
  produce messages and may not rewrite the ones already there.
- **Hooks are synchronous.** A promise nobody settles leaves the job queue empty
  with no bytecode running, so nothing trips the deadline. Making hooks
  asynchronous means putting a deadline around the microtask pump.
- **`ircx.fetch` is the one host function that waits.** Before it existed, "a
  plugin can spin but cannot hang" was a property of the mechanism. It is now a
  property of a timeout: the request is given what is left of the call's
  deadline and no more, so a call still ends when it was supposed to, but the
  guarantee rests on whoever makes the request honouring that budget rather
  than on nothing being able to wait at all. Any further host function that
  waits owes the same discipline.

  The request itself is `ircx-net`'s, under the policy an attachment preview
  gets — size cap, redirect limits, no fetching the user's own network — because
  `ircx-net` is the only crate that opens an outbound socket. `ircx-plugin` is
  handed the ability as a function and can only spend it after the grant and
  the host list have been checked.
- **Termination is the interrupt handler.** It fires from the regex engine in
  this build of quickjs-ng, which is a property of the build rather than of
  QuickJS. `a_plugin_looping_inside_the_regex_engine_is_also_terminated` exists
  to catch a version bump regressing it.

## The annotator

The second extension point. An annotator is handed a message that arrived and
answers with its own text, drawn beside that message and named with the plugin's
id. It is the command shape under a different trigger: the host hands a value
over, the plugin returns one, the host applies a deadline.

**Built**, end to end: the permission, the manifest flag, the batch call, what
the handler cannot reach, the sanitising, the host handing arrivals over on the
batch that drew them, the note drawn under the message and named with the
plugin, and the note surviving a restart.

```json
{
  "id": "units",
  "name": "Units",
  "version": "1.0.0",
  "description": "Reads Fahrenheit in Celsius",
  "entry": "main.js",
  "annotates": true,
  "permissions": ["annotate-messages", "access-channels"],
  "channels": ["#ircx"]
}
```

```js
ircx.annotate((message) => {
  const found = /(-?\d+(?:\.\d+)?)\s?°?F\b/.exec(message.text);
  if (!found) return;
  return Math.round((Number(found[1]) - 32) * 5 / 9) + " °C";
});
```

Installable as it stands: `examples/plugins/units`. That directory is the copy
`crates/ircx-plugin/tests/examples.rs` installs and runs, so an example that
stopped working fails the build rather than the person who trusted it. The one
difference from the manifest above is `"channels": ["*"]`, which makes the
install dialogue ask which conversations it may watch.

`annotates` is declared for the reason commands are: a conversation where no
installed plugin annotates costs nothing, because nothing has to start a runtime
to find that out. `Math` is there because the sandbox is a full context — what
is missing from it is host functions, not the language.

### It runs on arrival, not on draw

Three properties, and the first is what makes the other two affordable.

- **The message is drawn before any annotator runs.** An annotation arrives
  afterwards, as an update to a message already on screen. A slow annotator
  delays its own note and never the conversation, so the deadline stays a
  question about the plugin rather than about message latency.
- **It runs once per message.** The answer is stored beside the message, keyed by
  the message and the plugin, so scrolling redraws it instead of recomputing it,
  and a restart still has it — an `annotations` table keyed by the network, the
  message and the plugin, alongside the one reactions use. The 0.021 ms in
  `docs/measurements.md` is per slash command, something a person types; calling
  into QuickJS while a timeline scrolls is not an option at any figure.
- **An annotator never sees your own messages.** A line you sent is handed back
  to the caller that submitted it rather than appended, and its echo arrives as
  an update to that copy, so neither path reaches an annotator. This is not a
  rule that was decided; it falls out of how a sent message is delivered, and
  `crates/ircx-core/tests/ergo.rs` is what established it. Anything that wants
  to annotate what you said would have to change that path first.
- **Messages are handed over in batches.** A netsplit rejoin or a history
  backfill is hundreds of messages, and one call per batch keeps the call count
  near the command path's rather than multiplying it by the channel's traffic.
  Measured: fifty messages cost 0.207 ms together against about 1.3 ms one at a
  time, and a conversation nothing annotates costs the 0.0014 ms map lookup and
  no runtime at all. `docs/measurements.md` has the method.

### What an annotate handler cannot reach

| host function | inside an annotate handler |
|---|---|
| `ircx.send` | throws, whatever the grants say |
| `ircx.fetch` | throws, whatever the grants say |
| `ircx.store` | works |

`ircx.send` throws because an annotator that can send **is** the reactive send,
and the bound that makes a plugin's sends safe is the keystroke: `MAX_SENDS` is
eight a command because a command is one thing a person asked for. A send caused
by an arrival has no such unit. Two plugins answering each other's messages pass
every check in `tests/failure_modes.rs` individually while the pair never stops,
and nothing in this crate can see that, because every bound it has is inside a
single call. Opening this means a loop-breaker first — a send caused by an
arrival marked as such, and arrival hooks not firing on a marked message — which
is provenance rather than a rate, and is not designed here.

`ircx.fetch` throws because a fetch per arriving message is the client reaching a
remote URL on its own, which is the rule attachments already keep: a preview
loads when the user asks for one. An annotator that wants a fetch is asking for
the one exclusion this milestone made deliberately.

`ircx.store` works, and is the only way an annotator remembers anything — that
this link has been posted before, say. It is a write per message rather than per
command, which is the one cost the permission's own floor does not already
bound.

### It annotates and does not transform

The handler is handed the message and answers with its own text. No signature in
the host surface takes a message and returns a different one, which is the
standing constraint above holding as a type rather than as a convention. The
annotation is drawn beside what it is about and carries the plugin's id, for the
reason a command's answer does: it is how a reader tells what somebody else's
code said from what the person said.

Sanitising is the host's, as everywhere else: control characters go, newlines
with them, and the answer is cut to 200 characters. A command's 40-line ceiling
is the wrong shape for a note that sits beside one line.

### The permission

`annotate-messages` — *Read every message as it arrives in the channels you
choose, and show its own note beside them*. Scoped by `access-channels`, the way
`ircx.send` and `call.messages` are.

It is a new permission rather than `read-messages` widened, because
`read-messages` says "the conversation it is used in" and means it: the archive
is read for one call, on demand, and not at all otherwise. Reading on arrival is
continuous and has no conversation it was used in, so widening the grant would
leave the install dialogue's sentence describing something smaller than what the
user agreed to.

It is also the eighth. The spec's list is "such as", so an eighth is not a
departure from it, and neither is the ninth below.

### What a broken annotator costs

| what it does | what happens |
|---|---|
| throws | no annotation for that batch, reported once against the plugin's name |
| throws every time | the annotator is dropped for the session, after three batches in a row |
| overruns the deadline | runtime thrown away, as for a command; drawn messages are untouched |
| returns a promise | refused, because hooks are synchronous |

The second row is the one a command does not need. A command reports its failure
to the person who typed it, and there is one of those. An annotator that fails on
every message would report as often as the channel talks, so the first failure is
the report and the rest are silence.

## The notification rule

The third extension point. A rule is handed a message that arrived and answers
whether it is worth interrupting the user for. Same trigger as the annotator and
a different consent — it reads on arrival and shows nothing — so it owns a
permission of its own rather than borrowing `annotate-messages`.

**The plugin half is built**: the permission, the manifest flag, the batch call,
what the handler cannot reach, and the check that a rule may only speak about
the batch it was handed. What the host does with a raised message is #90's
next slice.

```json
{
  "id": "deploys",
  "name": "Deploys",
  "version": "1.0.0",
  "description": "Raises the build bot when a deploy fails",
  "entry": "main.js",
  "notifies": true,
  "permissions": ["raise-notifications", "access-channels"],
  "channels": ["#ops"]
}
```

```js
ircx.notify((message) => message.nick === "buildbot" && message.text.includes("failed"));
```

### It raises and cannot lower

The reply carries the messages to raise and has no field for a message the
plugin wants quiet. So a rule cannot take back what the user's own nick raised,
and cannot take back what another rule raised.

This is deliberate and it is the same constraint the annotator holds as a type,
said about attention rather than about text. A plugin that could silence could
hide a person talking to you, and the person would have no way to know it
happened: an interruption that does not arrive leaves nothing behind. Muting a
noisy bot is the use this gives up, and it is the user's setting to make rather
than a plugin's.

`false` is therefore not "silence this" but "I have nothing to say about it",
which is what the handler returning nothing at all also means.

### It answers whether, and only about what it was handed

A handler returns `true` or `false`. Anything else is refused rather than read
as truthy — a promise is an object, and a rule that returned one would raise
every message it was ever handed.

The answer is a list of ids, and the host drops any the batch did not contain.
The bootstrap builds that list out of the ids it was given, but the bootstrap is
a global on the plugin's own object and the plugin's top level runs after it, so
the check that matters is the one on the host side. Without it, a plugin granted
one channel could raise a message in a channel it was never allowed to read.

### What a rule cannot reach

The same three as an annotator, for the same reasons: `ircx.send` is closed
because the bound that makes a plugin's sends safe is the keystroke, `ircx.fetch`
is closed because a fetch per arriving message is the client reaching a remote
URL on its own, and `ircx.store` works — it is the only way a rule can be about
more than the message in front of it, such as the third failure this hour.

## What is not built

- **What the host does with a raised message.** The plugin half of the
  notification rule is built and nothing drives it: no arrival reaches a rule,
  and nothing is raised.
- **The other two extension points' shapes.** Providers and protocol adapters
  are still only described.
- **Which channels a plugin may reach, chosen from the ones it is in.** The
  install dialogue offers the channels the manifest named, and lets the user
  type one when the manifest asked for `*`. Neither is a list of the channels
  they are actually in, so naming one is spelling rather than picking.
- **A second plugin's marginal cost.** Every figure in `docs/measurements.md` is
  one plugin.
