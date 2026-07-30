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

The context panel should have three modes:

Follow active pane — default. One shared right sidebar follows whichever chat split has focus.

Pinned to pane — the user can pin the sidebar to a particular split, useful while comparing two channels.

Embedded — optionally attach a narrow member list directly inside one split for large monitors.

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

Visually, I would place the context panel divider inside the active split’s header alignment so it feels connected to that conversation rather than like a global application sidebar.