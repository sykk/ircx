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

A refusal is thrown into the plugin, so it can catch it and do less rather than
die — the same shape the client uses when a server is missing an IRCv3
capability.

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

Three properties hold only as long as the host surface keeps them. They are
constraints on future work, not things already banked.

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
- **The install dialogue.** `Permission::summary` is the plain-terms line each
  grant needs; nothing draws it yet, and no Tauri command installs, lists or
  grants. The runtime is driveable from `ircx-core`.
- **Attribution in the timeline.** A plugin's answer arrives as a client note
  like `/help` output does, so the timeline does not say which plugin said it.
  That wants the message renderer seam.
- **A second plugin's marginal cost.** Every figure in `docs/measurements.md` is
  one plugin.
