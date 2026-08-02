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

The layout survives a restart, alongside the sidebar width and the collapsed
networks `viewState.ts` already kept. What is written down is the tree with each
pane named by the conversation it holds rather than by its view id: ids are
minted per run and mean nothing to the next one, so what a pane was showing is
how it is found again.

That makes the restore answerable. A conversation the client no longer holds —
closed before quitting, or on a network since deleted — takes its pane with it,
and the split around it collapses the way closing a pane collapses one. A stored
tree with nothing left in it opens no panes at all, which is where a first launch
starts anyway. Because the question is which conversations still exist, the
restore waits for the opening snapshot rather than running on mount.

What is not written down is where a pane was looking: the scroll position, the
open inspector, and which pane had focus. The first pane in reading order takes
focus. Those belong to the run that was looking, the same reason `retarget`
discards them when a pane is pointed somewhere else. A hidden roster is left out
for the same reason and is the one worth arguing about, since it changes the
window's proportions on the way back — it is a toggle over a pane rather than
part of what the pane holds, which is where the line was drawn.

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

## What a pane may hold

Nothing a pane needs to keep lives in its component state. A change to the
layout's shape — a split, or a close — unmounts every pane in the window and
mounts fresh ones, because the element at a position changes from a `ChatPane`
to a `div` when a view node becomes a split node. No arrangement of keys fixes
it: the pane genuinely moves to a new position in the element tree, and React
does not reparent a subtree. #308.

So a pane's state goes in the store, keyed by `ViewId`, which is where
`viewAnchor`, `selectedUser`, `raw` and `rosterHidden` already are. The console's
command box is there for that reason: it saves no draft, so a split used to take
a half-typed command and the refusal under it, which is the loss #299 was filed
for reaching the user by a second route.

`rawAnchor` is the last of them and the one that needed a different answer
(#315). A protocol log line has no id to name it by, and its text is not unique
— a `PING` recurs — so the anchor is the line's index rather than the line, and
`null` means the pane is following the tail the way it does for `viewAnchor`.
The index is exact while the buffer only grows; at `RAW_LOG_CAP` each arrival
shifts it, so a pane rebuilt during a flood comes back further down the log than
it left. That is left as it is, because a flood long enough to move the index
has already rolled the line off the front of the buffer, and no anchor recovers
a line that is gone.

`composerError` is the third and was the least obvious, because half of what it
protects already worked. A refused line is given back to the box, and the box
round-trips through the backend draft, so a rebuild returned the line and lost
only the reason — leaving the reader their message back with nothing saying why
it had not gone, which is the state #299 exists to prevent.

The cost of keying by `ViewId` is that a pane's entry has to be let go of
everywhere a pane is: closed, pointed at another conversation, taken by the
conversation it was showing, or blanked when its network is deleted. A pane
handed the same id later would otherwise open holding what the last one did.
Each of the three has a store test at each of those points, which is what caught
`networkRemoved` being missed the first time.
