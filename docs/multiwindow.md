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