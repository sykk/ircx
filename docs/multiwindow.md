The member list should belong to the active chat pane, not to the whole application window.

Treat every split as its own independent view:

Chat pane
├─ network
├─ channel/query
├─ scroll position
├─ draft
├─ search/filter state
├─ selected message
└─ context panel
   ├─ members
   ├─ channel info
   ├─ pins/files
   └─ user details

When the user focuses a split, the right context panel immediately updates to match that split:

┌───────────────┬───────────────┬─────────────┐
│ #ctf-ops      │ #libera-dev   │ members for │
│               │ ACTIVE        │ #libera-dev │
└───────────────┴───────────────┴─────────────┘

Clicking back into #ctf-ops changes the member list back to #ctf-ops.

Recommended behavior

This section originally specified three modes for the context panel — follow the
active pane, pin it to one pane, embed it in one pane. All three answered the
same question: which single pane gets the member list. #95 replaced them with
the answer that question was avoiding.

**Every pane on a channel draws its own member list, inside the pane.** A roster
belongs to the conversation it lists, the way the timeline and the composer do.
Two channels side by side means two rosters. A pane on a query or a server
console has nobody to list and draws no column at all, rather than an empty one
standing in for a roster.

`Ctrl+Shift+M` hides the focused pane's roster and leaves every other pane
alone; `rosterHidden` records the panes the user has hidden rather than the ones
they have shown, because shown is the rule. Closing a pane forgets its entry, so
a later pane handed the same id does not inherit it.

The user inspector lives in the same panel and follows it: clicking a nick in
one pane inspects inside that pane.

I would make the default interaction:

Ctrl+\          split chat vertically
Ctrl+Shift+\    split chat horizontally
Alt+Arrow       move focus between panes
Ctrl+W          close active pane
Ctrl+Shift+M    toggle context panel

The active pane needs a very subtle indicator—perhaps a slightly brighter top rule or channel title. Avoid a full highlighted border because that would add too much visual noise.

The rule between two panes is also the handle that moves it: a split carries the
share its first child takes, and dragging the divider or pressing an arrow key
on it changes that share. Neither side goes below 15% of the split, which is a
share rather than a width — on a narrow window that is still a small pane, and
the roster inside it does not shrink. A split with no share of its own is an
even half, so a layout made before any of this reads the way it did.

The share is not persisted. `viewState.ts` keeps the sidebar width and the
collapsed networks across a restart; the layout tree is rebuilt from the
conversations that were open, so a resize lasts as long as the window does.

Important state rule

Do not store the member list as global UI state:

// Avoid
app.activeMemberList

Tie it to a view context:

interface ChatView {
  id: string;
  networkId: string;
  bufferId: string;
  scrollPosition: number;
  draft: string;
  contextTab: "members" | "info" | "files";
  selectedUser?: string;
}

Then the shared sidebar simply renders:

const context = views[activeViewId];

This also means two splits can show the same channel while retaining separate scroll positions—one following live chat and another reading older history.

Visually, the roster's own header is empty and carries the same height and rule
as the pane header beside it, so the line under that header runs on into the
roster and the two read as one conversation rather than as a global application
sidebar. The pane header already names the channel and counts its members, so
the roster repeats neither.
## Reaching a conversation once there is more than one pane

Two things a user does are easy to confuse, and #98 was the first time they came
apart.

**Take me to this conversation** — a click in the sidebar, a palette jump, a
search hit. If a pane is already showing it, that pane takes focus and nothing
is retargeted; only when no pane is showing it does the focused pane go there.
Before this, a sidebar click replaced whatever the focused pane held, so
clicking a channel that was already open beside it left two panes on one channel
and lost the conversation you were reading. `showTarget` is that rule.

**Walk the target list** — `Ctrl+1..9`, and `Alt+ArrowUp`/`Down` when there is
only one pane. These move the pane you are in, and stay on `setActive`. Throwing
focus across the window on the way past a target another pane happens to hold
would make the list unwalkable.

Splitting deliberately opens a second view on one target, so more than one pane
can be showing it; the first in pane order takes focus. Targets are matched the
way a server matches them, case-insensitively, and by network as well as name.
