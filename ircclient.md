# Product direction

This file began as the prompt used to scaffold ircx. It now records the durable
product direction and scope. The original prompt remains available in Git
history; its feature lists are not a roadmap.

ircx is a lightweight desktop IRCv3 client, with Libera.Chat as its primary
compatibility target. It keeps IRC's networks, channels, nicknames, queries,
slash commands, and access to raw server traffic while making connection and
account setup understandable without prior IRC administration knowledge.

## Product principles

- Keep conversations compact, text-focused, and usable from the keyboard.
- Prefer clear defaults for TLS, SASL, capability negotiation, and reconnects,
  while leaving the negotiated server state visible.
- Adapt to each server's IRCv3 capabilities. Missing capabilities reduce the
  available interface instead of making the connection fail.
- Report protocol and connection failures in language that tells the user what
  happened and what they can do next.
- Hold startup, memory, and installation-size claims to recorded measurements.
- Keep configuration and optional message history local to the device.
- Require explicit grants for sandboxed plugins. A plugin failure must not end
  an IRC connection or the application.

## Current scope

The [README status](README.md#status) lists what the current build implements.
The current milestone excludes custom message encryption, voice, built-in file
hosting, threads, and cloud sync. `EncryptionState` remains `Plaintext`.

Attachments are links and metadata rather than files transferred through IRC.
Remote previews load only after an explicit user action. Plugin message
renderers, link and attachment providers, and protocol adapters are documented
constraints for possible future work, not implemented features or scheduled
work.

Use repository issues and pull requests to track active work. A feature named
in the historical prompt is not planned merely because it appeared there.

## Sources of truth

- Code and tests define implemented behavior.
- [AGENTS.md](AGENTS.md) defines layer boundaries, repository conventions, and
  milestone constraints.
- [The visual mockup](docs/mockup.png) defines the minimal application shape;
  [the readability study](readability/READABILITY.md) defines timeline reading
  behavior where the two differ.
- [The plugin document](docs/plugins.md) defines the permission model and the
  extension points that exist today.
- [Measurements](docs/measurements.md) contain performance and size figures
  with their methods.
- [Manual verification](docs/manual-verification.md) lists behavior that cannot
  yet be established by automated tests.
