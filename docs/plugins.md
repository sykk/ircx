# Plugins

A plugin is JavaScript with a manifest. It runs in its own QuickJS runtime on
its own thread and reaches the client only through the functions its grants
allow. `docs/plugin-isolation.md` is why QuickJS: a subprocess enforces two of
the seven permissions the spec names, and this enforces all seven.

The one extension point built is the **custom slash command**. Message
renderers, link and attachment providers, notification rules and protocol
capability adapters are the same shape — the host hands a value over, the plugin
returns one, the host applies a deadline — and are follow-up work.

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
| send messages | Send messages as you | `ircx.send` throws; nothing else can reach the socket |
| add commands | Add slash commands you can type | Routing ignores plugins without it, so the command does not exist |
| store local data | Keep its own settings and data on this computer | `ircx.store` throws; it is the only writing a plugin can do, and only inside its own folder |
| access selected channels | Work in the channels you choose, and no others | Scopes both `ircx.send` and `call.messages`; `*` is every conversation and is a choice the user makes explicitly |
| make external network requests | Fetch data from the websites it names | `ircx.fetch` throws without the grant or off the granted hosts; only `http` and `https` are addresses |
| render message content | Show text in your conversations | A returned answer is refused without it, and sanitised with it |

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

  This is a decision rather than an accident, and it is what the seven
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

## What is not built

- **The other four extension points.** Renderers, providers, notification rules
  and protocol adapters.
- **Which channels a plugin may reach, chosen from the ones it is in.** The
  install dialogue offers the channels the manifest named, and lets the user
  type one when the manifest asked for `*`. Neither is a list of the channels
  they are actually in, so naming one is spelling rather than picking.
- **A renderer that annotates a message.** A plugin's own answer is named, and
  nothing yet lets a plugin add anything beside a message it did not write —
  a link preview under a URL, say. Transforming one is not on this list because
  it is refused above rather than unbuilt.

  What it would need is the per-message budget. The 0.022 ms in
  `docs/measurements.md` is per slash command, something a user types; an
  annotation runs against messages as they arrive, and calling into QuickJS
  while a timeline scrolls is not an option — it would have to run once on
  arrival with its result stored, the way `via` is.
- **A second plugin's marginal cost.** Every figure in `docs/measurements.md` is
  one plugin.
