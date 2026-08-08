# Example themes

Each theme is a directory with:

- `theme.json` — name, author, version, and `"appearance": "dark"` or `"light"`
- `theme.css` — CSS custom properties on `:root` (colours, spacing, radii)
- `ui.css` *(optional)* — animations, transitions, and layout tweaks

Install by copying a folder into ircx's themes directory:

```
%APPDATA%\chat.ircx.app\themes\cyberpunk\    (Windows)
~/.local/share/chat.ircx.app/themes/cyberpunk/   (Linux)
```

Then choose it in **Appearance** (command palette → appearance).

## ui.css

Rules are injected when the theme is active. Scope with `[data-theme="<folder-name>"]`
and target UI regions with `[data-ui="…"]`:

| `data-ui` | Region |
|-----------|--------|
| `shell` | Outer window grid |
| `titlebar` | Custom title bar |
| `sidebar` | Network / channel list |
| `main` | Conversation area |
| `statusbar` | Bottom connection bar |
| `pane` | One split pane |
| `timeline` | Message scroller |
| `composer` | Input area |
| `message-row` | One message line |
| `typing` | Typing indicator |
| `members` | Member list drawer |
| `palette` | Command palette dialog |

`ui.css` cannot use `@import`, `url()`, or script — themes must not fetch remote
resources.

## cyberpunk

Neon accent palette with fade-in messages, a pulsing typing indicator, and a
short palette entrance animation. Copy from `examples/themes/cyberpunk/`.

## ircx-glass (built-in)

Smoked glass panels, green/purple accents, and a barely-there morphic background.
Select **Glass** in Appearance — no install step. Source lives in
`src/styles/themes/ircx-glass/`.
