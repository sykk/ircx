# The eighth run: the plugin picker, refused

Run on 2026-08-03 against a local `ergo` on `127.0.0.1:6667`, in the assembled
app on `Xvfb :90`.

The plugins section of `docs/manual-verification.md` had four things no test
reaches. Two of them are what a person does wrong with a native folder chooser,
and both were reachable the moment the export walk showed a dialogue could be
answered at all.

**Neither found a defect.** That is the result, and it is worth writing down at
the same length a defect would get: these two paths are the ones a user meets by
accident, and until today the only evidence that they behaved was that somebody
had read the code.

## Cancelling

`01-cancel-changes-nothing.png`. Install from folder, then Escape out of the
chooser. The sheet is exactly as it was — `Nothing installed. A plugin is a
folder holding a plugin.json and the script it names.` — with no error drawn,
`Plugins 0` still in the status bar, and nothing installed under a blank name,
which is what the entry was written to check.

`install()` returns on the `null` a dismissal gives, before `setBusy` and before
the command. That is the branch #167 exists to keep separate from a rejection,
and it is the same shape the archive sheet's export uses.

**The sheet takes the keyboard back**, which is the part worth having watched
rather than reasoned about. A native dialogue takes focus away from the webview
and nothing in the client hands it back explicitly. Escape closed the sheet on
the first press after the chooser had been and gone.

## A folder that is not a plugin

`03-names-the-file.png`. A folder holding a `README.md` and nothing else:

```text
/home/syk/ircx/.claude/worktrees/export-walk/zznotaplugin holds no plugin.json,
so there is no plugin in it to install
```

Which is #89's whole point — it names the file it went looking for instead of
repeating the operating system's `No such file or directory` — and the library
behind it is untouched.

## What it cost, which was the harness again

**GTK's folder chooser duplicates typed characters.** Four attempts went into
getting a path into it before the pattern was clear —
`02-location-bar-duplicates.png` is the second:

```text
typed   /tmp/notaplugin/                     arrived   /tmp/nootaplugin/
typed   /tmp/claude-1000/…/notaplugin/       arrived   /tmp/claude-aude-1000/…
typed   /tmp/nota                            arrived   /tmp/noota
```

This is not #349, which was keystrokes being *dropped* at speed and was fixed by
typing slower. Characters are being added, a shorter path mangles as readily as
a long one, and the save dialogue's Name field — the same `xsend`, the same
window, an hour of walking in `docs/end-to-end-run-5.md` — takes a full path
without trouble. Whatever the location entry does with an injected key, it does
it only there.

The way round is not to type. The chooser opens on the app's working directory,
so a folder put there is one click and an Open away, and that is how both cases
above were finally reached. SKILL.md carries the warning now.

## What this run did not reach

- **The unresponsive backstop**, still. Nothing in the host surface can produce
  a plugin thread that never returns; the path waits for the next host function
  that blocks.
- **A plugin's `ircx.fetch` crossing a real socket.** The permission tests give
  the sandbox a fetcher with no network behind it, and `ircx-net` has its own
  tests, but nothing exercises the two together. That is the one remaining
  plugin gap a walk could close, and it wants a local HTTP server rather than a
  dialogue.
