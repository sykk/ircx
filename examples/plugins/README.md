# Example plugins

Installable as they are: point the install dialogue at one of these directories.

- **units** — reads Fahrenheit in Celsius, as a note beside the message. The
  annotator from `docs/plugins.md`, and the smallest thing that shows what an
  extension point is: one hook, one permission, no way to say anything as you.
- **deploys** — interrupts you when a build bot says something failed. The
  notification rule from `docs/plugins.md`: it can raise a message and cannot
  quiet one.

`crates/ircx-plugin/tests/examples.rs` installs and runs every plugin here, so
an example that stopped working fails the build rather than the person who
trusted it.
