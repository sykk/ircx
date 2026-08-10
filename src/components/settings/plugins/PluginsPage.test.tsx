import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeChannel,
  makeNetwork,
  makeQuery,
  resetStore,
  seedStore,
} from "@/components/shell/fixtures";
import { useAppStore } from "@/store";
import type * as Ipc from "@/lib/ipc";
import type { InstalledPlugin, PluginPermissionInfo } from "@/types";
import { SettingsBusy } from "@/components/settings/SettingsPage";
import { PluginsPage } from "./PluginsPage";

const { ipcMock, chooseFolder } = vi.hoisted(() => ({
  ipcMock: {
    pluginPermissions: vi.fn(),
    installPlugin: vi.fn(),
    setPluginGrants: vi.fn(),
    removePlugin: vi.fn(),
  },
  chooseFolder: vi.fn(),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: ipcMock,
  chooseFolder,
}));

/** The wording is the backend's — `Permission::summary` in ircx-plugin. These
 * are the lines it sends, including for a permission Greeter never asks for. */
const PERMISSIONS: PluginPermissionInfo[] = [
  { permission: "add-commands", summary: "Add slash commands you can type" },
  {
    permission: "send-messages",
    summary:
      "Send messages under your nick, which nobody else can tell from your own",
  },
  {
    permission: "read-messages",
    summary: "Read the recent messages in the conversation it is used in",
  },
  {
    permission: "access-channels",
    summary: "Work in the channels you choose, and no others",
  },
  {
    permission: "network-requests",
    summary: "Fetch data from the websites it names",
  },
];

const GREETER: InstalledPlugin = {
  id: "greeter",
  name: "Greeter",
  version: "1.0.0",
  description: "Says hello for you",
  commands: [{ name: "greet", summary: "Greet the channel" }],
  requests: {
    permissions: [
      "add-commands",
      "send-messages",
      "access-channels",
      "network-requests",
    ],
    channels: ["#ircx", "*"],
    hosts: ["api.example.com"],
  },
  grants: { permissions: [], channels: [], hosts: [] },
};

/** Greeter asking for every conversation, which is the scope the picker exists
 * to narrow. */
const EAGER: InstalledPlugin = {
  ...GREETER,
  requests: { ...GREETER.requests, channels: ["*"] },
};

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  ipcMock.pluginPermissions.mockResolvedValue(PERMISSIONS);
  ipcMock.removePlugin.mockResolvedValue(undefined);
  // The backend answers with the plugin as it now stands, which is how the
  // list and the form stay right without reading everything back.
  ipcMock.setPluginGrants.mockImplementation(
    (plugin: string, grants: unknown) =>
      Promise.resolve({ ...GREETER, id: plugin, grants }),
  );
});

const done = vi.fn();

async function open(plugins: InstalledPlugin[] = [GREETER]) {
  useAppStore.setState({ plugins });
  await act(async () => {
    // Inside the provider the window puts it in: a page reports a request in
    // flight so the window's Escape and its Done both decline while it runs.
    render(
      <SettingsBusy>
        <PluginsPage onDone={done} />
      </SettingsBusy>,
    );
  });
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function box(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

async function permissionsFor(name: string) {
  fireEvent.click(button(`Permissions for ${name}`));
  await screen.findByRole("heading", { name: `What ${name} may do` });
}

async function save() {
  await act(async () => {
    fireEvent.click(button("Save"));
  });
}

const CHANNELS = "Work in the channels you choose, and no others";
const COMMANDS = "Add slash commands you can type";
const WEBSITES = "Fetch data from the websites it names";
const NAME_ONE = "Name one you are not in";

describe("the plugins page", () => {
  it("lists what a plugin adds and how much of what it asked for it holds", async () => {
    await open();

    expect(screen.getByText("Says hello for you")).toBeTruthy();
    expect(screen.getByText("/greet")).toBeTruthy();
    expect(screen.getByText("Granted nothing")).toBeTruthy();
  });

  it("offers exactly the permissions the manifest asked for", async () => {
    await open();
    await permissionsFor("Greeter");

    expect(box(COMMANDS)).toBeTruthy();
    expect(
      box(
        "Send messages under your nick, which nobody else can tell from your own",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText(
        "Read the recent messages in the conversation it is used in",
      ),
    ).toBeNull();
  });

  it("grants nothing at install, so every box starts clear", async () => {
    await open();
    await permissionsFor("Greeter");

    expect(box(COMMANDS).checked).toBe(false);
    expect(box(CHANNELS).checked).toBe(false);
  });

  describe("the channels a plugin may work in", () => {
    it("does not put every conversation in the grant by choosing the permission", async () => {
      await open();
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      expect(box("Every conversation").checked).toBe(false);
      expect(box("#ircx").checked).toBe(false);
      // A permission scoped to nothing gives nothing while reading as if it
      // gives something, so it cannot be saved that way.
      expect(button("Save").disabled).toBe(true);
    });

    it("keeps the channel the user chose, and only that one", async () => {
      await open();
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));
      fireEvent.click(box("#ircx"));
      await save();

      await permissionsFor("Greeter");
      expect(box("#ircx").checked).toBe(true);
      expect(box("Every conversation").checked).toBe(false);
    });

    it("replaces the named channels when every conversation is chosen", async () => {
      await open();
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));
      fireEvent.click(box("#ircx"));
      fireEvent.click(box("Every conversation"));

      expect(box("#ircx").checked).toBe(false);
      expect(box("Every conversation").checked).toBe(true);
    });

    /** A plugin that asked for every conversation asked for all of them, so a
     * single one is less than it asked for and the library takes it. Without
     * this the eager plugin is the one the user cannot narrow, which is the
     * plugin the scope exists for. */
    it("lets the user hand one conversation to a plugin that asked for all of them", async () => {
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      fireEvent.change(screen.getByLabelText(NAME_ONE), {
        target: { value: "#ircx-dev" },
      });
      fireEvent.click(button("Add"));

      expect(box("#ircx-dev").checked).toBe(true);
      expect(box("Every conversation").checked).toBe(false);
      expect(button("Save").disabled).toBe(false);

      await save();
      expect(ipcMock.setPluginGrants).toHaveBeenCalledWith(
        "greeter",
        expect.objectContaining({ channels: ["#ircx-dev"] }),
      );
    });

    /** A lone text input in a form submits it on Enter, which would have saved
     * the grant without the channel just typed. Enter has to add instead. */
    it("adds the conversation on Enter rather than saving without it", async () => {
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      const field = screen.getByLabelText(NAME_ONE);
      fireEvent.change(field, { target: { value: "#ircx-dev" } });
      fireEvent.keyDown(field, { key: "Enter" });

      expect(box("#ircx-dev").checked).toBe(true);
      expect(ipcMock.setPluginGrants).not.toHaveBeenCalled();
      expect((field as HTMLInputElement).value).toBe("");
    });

    /**
     * #163, found by installing a plugin and granting it one channel. Typing
     * `#replytest` and pressing Save stored `"channels": ["*"]` — the typed
     * text never left the input, so the manifest's wildcard stood. The user
     * had narrowed the scope and the client widened it back in silence.
     *
     * This is the consent mechanism, so the rule is that nothing is granted
     * which was not confirmed, and nothing typed is thrown away.
     */
    it("will not save while a typed conversation has not been added", async () => {
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));
      // What the manifest asked for, and what stood when the typed name was
      // dropped: a saveable grant on every conversation.
      fireEvent.click(box("Every conversation"));
      expect(button("Save").disabled).toBe(false);

      fireEvent.change(screen.getByLabelText(NAME_ONE), {
        target: { value: "#replytest" },
      });

      expect(button("Save").disabled).toBe(true);
      expect(screen.getByText(/Add #replytest or clear it/)).toBeTruthy();
      expect(ipcMock.setPluginGrants).not.toHaveBeenCalled();
    });

    it("saves once the typed conversation is added", async () => {
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      fireEvent.change(screen.getByLabelText(NAME_ONE), {
        target: { value: "#replytest" },
      });
      fireEvent.click(button("Add"));

      expect(button("Save").disabled).toBe(false);
      await save();
      expect(ipcMock.setPluginGrants).toHaveBeenCalledWith(
        "greeter",
        expect.objectContaining({ channels: ["#replytest"] }),
      );
    });

    it("saves again once the typed conversation is cleared", async () => {
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));
      fireEvent.click(box("Every conversation"));

      const field = screen.getByLabelText(NAME_ONE);
      fireEvent.change(field, { target: { value: "#replytest" } });
      fireEvent.change(field, { target: { value: "  " } });

      expect(button("Save").disabled).toBe(false);
    });

    it("does not offer to name one when the manifest listed the channels itself", async () => {
      const listed: InstalledPlugin = {
        ...GREETER,
        requests: { ...GREETER.requests, channels: ["#ircx"] },
      };
      await open([listed]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      expect(screen.queryByLabelText(NAME_ONE)).toBeNull();
    });

    /** The gap `docs/plugins.md` recorded: the form offered what the manifest
     * named and a box to type into, and neither was the list of conversations
     * the reader is in — so narrowing an eager plugin was spelling rather than
     * picking. The page can ask now because settings is a dialog inside the
     * client and reads the store the sidebar reads. */
    it("offers the conversations the reader is in", async () => {
      seedStore(
        [makeNetwork("libera")],
        [makeChannel("libera", "#ircx"), makeChannel("libera", "#rust")],
        [makeQuery("libera", "phrack")],
      );
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));
      fireEvent.click(box("#rust"));

      expect(box("#ircx").checked).toBe(false);
      expect(box("phrack").checked).toBe(false);

      await save();
      expect(ipcMock.setPluginGrants).toHaveBeenCalledWith(
        "greeter",
        expect.objectContaining({ channels: ["#rust"] }),
      );
    });

    /** A manifest that listed its channels has said which ones, and
     * `Grants::within` refuses anything outside that list. Offering the
     * reader's own would draw a row whose save the backend rejects. */
    it("offers none of them where the manifest listed the channels itself", async () => {
      seedStore([makeNetwork("libera")], [makeChannel("libera", "#rust")]);
      const listed: InstalledPlugin = {
        ...GREETER,
        requests: { ...GREETER.requests, channels: ["#ircx"] },
      };
      await open([listed]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      expect(box("#ircx")).toBeTruthy();
      expect(screen.queryByLabelText("#rust")).toBeNull();
    });

    /** A conversation the reader is not in has no row, and a plugin can still
     * be given one — the channel it will be joined to next week. */
    it("still takes a conversation that has no row", async () => {
      seedStore([makeNetwork("libera")], [makeChannel("libera", "#ircx")]);
      await open([EAGER]);
      await permissionsFor("Greeter");
      fireEvent.click(box(CHANNELS));

      fireEvent.change(screen.getByLabelText(NAME_ONE), {
        target: { value: "#ircx-dev" },
      });
      fireEvent.click(button("Add"));

      expect(box("#ircx-dev").checked).toBe(true);
      expect(box("#ircx").checked).toBe(false);
    });

    it("asks for a website before a plugin may make requests", async () => {
      await open();
      await permissionsFor("Greeter");
      fireEvent.click(box(WEBSITES));

      expect(box("api.example.com").checked).toBe(false);
      expect(button("Save").disabled).toBe(true);
    });
  });

  it("takes a permission back through the same screen", async () => {
    await open([
      {
        ...GREETER,
        grants: { permissions: ["add-commands"], channels: [], hosts: [] },
      },
    ]);
    await permissionsFor("Greeter");
    expect(box(COMMANDS).checked).toBe(true);

    fireEvent.click(box(COMMANDS));
    await save();

    expect(screen.getByText("Granted nothing")).toBeTruthy();
  });

  it("shows the refusal the backend wrote rather than one of its own", async () => {
    ipcMock.setPluginGrants.mockRejectedValue(
      "Greeter is no longer installed. Install it again to change what it may do.",
    );
    await open();
    await permissionsFor("Greeter");
    fireEvent.click(box(COMMANDS));
    await save();

    expect(screen.getByRole("alert").textContent).toBe(
      "Greeter is no longer installed. Install it again to change what it may do.",
    );
    expect(box(COMMANDS).checked).toBe(true);
  });

  describe("removing", () => {
    it("asks before it removes", async () => {
      await open();
      fireEvent.click(button("Remove Greeter"));

      expect(screen.getByText("Says hello for you")).toBeTruthy();
      expect(useAppStore.getState().plugins).toHaveLength(1);
    });

    it("takes the plugin out of the list once it is gone", async () => {
      await open();
      fireEvent.click(button("Remove Greeter"));
      await act(async () => {
        fireEvent.click(button("Remove Greeter and its permissions"));
      });

      expect(screen.queryByText("Says hello for you")).toBeNull();
      expect(screen.getByText(/Nothing installed/)).toBeTruthy();
      expect(useAppStore.getState().plugins).toHaveLength(0);
    });

    it("keeps the plugin and says why when the backend refuses", async () => {
      ipcMock.removePlugin.mockRejectedValue(
        "greeter is in use and could not be removed.",
      );
      await open();
      fireEvent.click(button("Remove Greeter"));
      await act(async () => {
        fireEvent.click(button("Remove Greeter and its permissions"));
      });

      expect(screen.getByRole("alert").textContent).toBe(
        "greeter is in use and could not be removed.",
      );
      expect(screen.getByText("Says hello for you")).toBeTruthy();
    });
  });

  describe("installing", () => {
    it("asks what the new plugin may do before it can do anything", async () => {
      chooseFolder.mockResolvedValue("/home/sable/plugins/greeter");
      ipcMock.installPlugin.mockResolvedValue(GREETER);
      await open([]);

      await act(async () => {
        fireEvent.click(button("Install from folder"));
      });

      expect(
        screen.getByRole("heading", { name: "What Greeter may do" }),
      ).toBeTruthy();
      expect(box(COMMANDS).checked).toBe(false);
      expect(useAppStore.getState().plugins).toHaveLength(1);
    });

    it("installs nothing when the folder picker is dismissed", async () => {
      chooseFolder.mockResolvedValue(null);
      await open([]);

      await act(async () => {
        fireEvent.click(button("Install from folder"));
      });

      expect(screen.getByText(/Nothing installed/)).toBeTruthy();
    });

    it("carries the reason a folder was refused", async () => {
      chooseFolder.mockResolvedValue("/home/sable/notes");
      ipcMock.installPlugin.mockRejectedValue(
        "That folder has no plugin.json, so there is no plugin in it.",
      );
      await open([]);

      await act(async () => {
        fireEvent.click(button("Install from folder"));
      });

      expect(screen.getByRole("alert").textContent).toBe(
        "That folder has no plugin.json, so there is no plugin in it.",
      );
    });
  });

  /** Firing Escape at the dialog element proves nothing on its own: React
   * listens at the root, so the handler only runs for a keystroke that starts
   * inside. Nothing in the sheet takes focus by itself, so this asserts the
   * sheet takes it — otherwise Escape goes wherever focus was left and the only
   * way out is the mouse. */
  /* Escape belongs to the window now and is asserted there. What is this
     page's is Done, which closes it the same way. */
  it("offers a way out that is not a keystroke", async () => {
    await open();
    fireEvent.click(button("Done"));

    expect(done).toHaveBeenCalled();
  });

  it("stays open while a request it started is still running", async () => {
    let land = (_: InstalledPlugin) => {};
    ipcMock.setPluginGrants.mockReturnValue(
      new Promise<InstalledPlugin>((resolve) => {
        land = resolve;
      }),
    );
    await open();
    await permissionsFor("Greeter");
    fireEvent.click(box(COMMANDS));
    fireEvent.click(button("Save"));

    // Closing here would leave the answer to land on a page that is gone, so
    // the way out is refused for as long as the request is running.
    expect(button("Done").disabled).toBe(true);
    fireEvent.click(button("Done"));
    expect(done).not.toHaveBeenCalled();

    await act(async () => {
      land({
        ...GREETER,
        grants: { permissions: ["add-commands"], channels: [], hosts: [] },
      });
    });
  });

  it("leaves a failure behind on the screen it happened on", async () => {
    ipcMock.removePlugin.mockRejectedValue(
      "Greeter is in use and could not be removed.",
    );
    await open();

    fireEvent.click(button("Remove Greeter"));
    await act(async () => {
      fireEvent.click(button("Remove Greeter and its permissions"));
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be removed",
    );

    // The same alert above Save would read as a rejected permission change.
    await permissionsFor("Greeter");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
