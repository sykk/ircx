import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDensity, applyTheme } from "@/lib/theme";
import { catalogue } from "@/lib/theme";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import { activeTarget, oneView } from "@/components/shell/fixtures";
import { SERVER_TARGET, type Channel, type Network, type Query } from "@/types";
import { CommandPalette } from "./CommandPalette";

const { ipcMock } = vi.hoisted(() => ({ ipcMock: { submitInput: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({ ipc: ipcMock }));

const network: Network = {
  id: "libera",
  name: "Libera.Chat",
  host: "irc.libera.chat",
  port: 6697,
  tls: true,
  status: { state: "connected" },
  currentNick: "sable",
  sasl: { state: "notConfigured" },
  capsEnabled: [],
  lagMs: null,
};

function channel(name: string, unread = 0): Channel {
  return {
    network: "libera",
    name,
    topic: null,
    modes: "+nt",
    joined: true,
    memberCount: 2,
    unread,
    highlights: 0,
  };
}

function query(nick: string): Query {
  return { network: "libera", nick, account: null, unread: 0, online: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.submitInput.mockResolvedValue({ kind: "handled" });

  useAppStore.setState({
    networks: { libera: network },
    networkOrder: ["libera"],
    channels: {
      [targetKey("libera", "#ctf-ops")]: channel("#ctf-ops", 36),
      [targetKey("libera", "#ctf-web")]: channel("#ctf-web"),
      [targetKey("libera", "#capture-the-flag-ops")]: channel("#capture-the-flag-ops"),
      [targetKey("libera", "#linux")]: channel("#linux"),
    },
    queries: { [targetKey("libera", "phrack")]: query("phrack") },
    ...oneView(null),
    recent: [],
    paletteOpen: true,
    searchOpen: false,
    rosterHidden: {},
  });
});

function input(): HTMLElement {
  return screen.getByRole("combobox");
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function optionLabels(): string[] {
  return screen.getAllByRole("option").map((el) => el.textContent ?? "");
}

function selectedLabel(): string {
  return screen.getByRole("option", { selected: true }).textContent ?? "";
}

describe("CommandPalette", () => {
  it("renders nothing while the store says it is closed", () => {
    useAppStore.setState({ paletteOpen: false });
    const { container } = render(<CommandPalette />);
    expect(container.innerHTML).toBe("");
  });

  it("lists targets grouped by kind", () => {
    render(<CommandPalette />);
    expect(screen.getByRole("group", { name: "Channels" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Queries" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Commands" })).toBeTruthy();
  });

  it("puts recently visited targets first before anything is typed", () => {
    useAppStore.setState({ recent: [targetKey("libera", "#linux")] });
    render(<CommandPalette />);
    expect(optionLabels()[0]).toContain("#linux");
  });

  it("finds #ctf-ops from ctfo", () => {
    render(<CommandPalette />);
    type("ctfo");
    expect(selectedLabel()).toContain("#ctf-ops");
    expect(optionLabels().some((l) => l.includes("#linux"))).toBe(false);
  });

  it("marks the matched characters in the result", () => {
    const { container } = render(<CommandPalette />);
    type("ctfo");
    const hits = Array.from(container.querySelectorAll("b")).map((b) => b.textContent);
    expect(hits.slice(0, 2)).toEqual(["ctf", "o"]);
  });

  it("moves with the arrow keys and wraps at the ends", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selectedLabel()).not.toBe(first);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selectedLabel()).toBe(first);

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selectedLabel()).toBe(optionLabels().at(-1));
  });

  it("moves with Ctrl+N and Ctrl+P", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "n", ctrlKey: true });
    expect(selectedLabel()).not.toBe(first);

    fireEvent.keyDown(input(), { key: "p", ctrlKey: true });
    expect(selectedLabel()).toBe(first);
  });

  it("types a plain n without moving the selection", () => {
    render(<CommandPalette />);
    type("ctf");
    const first = selectedLabel();

    fireEvent.keyDown(input(), { key: "n" });

    expect(selectedLabel()).toBe(first);
  });

  it("opens the selected target on Enter and closes", () => {
    render(<CommandPalette />);
    type("ctfo");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("opens a target on click", () => {
    render(<CommandPalette />);
    type("phra");
    fireEvent.click(screen.getAllByRole("option")[0]!);

    expect(activeTarget()).toEqual({ network: "libera", target: "phrack" });
  });

  it("opens the network's console, which is where the server files what it says", () => {
    render(<CommandPalette />);
    type("Libera");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(activeTarget()).toEqual({ network: "libera", target: SERVER_TARGET });
  });

  // #80: "settings" is the word someone types when they want to change a saved
  // password, and it used to match nothing at all.
  it("finds a network's saved settings under the word settings", () => {
    render(<CommandPalette />);
    type("settings");
    expect(selectedLabel()).toContain("Libera.Chat settings");

    fireEvent.keyDown(input(), { key: "Enter" });

    expect(useAppStore.getState().setup).toEqual({ network: "libera" });
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  describe("running a command", () => {
    it("fills a command's name in and waits for its argument", () => {
      render(<CommandPalette />);
      type("/join");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect((input() as HTMLInputElement).value).toBe("/join ");
      expect(useAppStore.getState().paletteOpen).toBe(true);
      expect(optionLabels().some((label) => label.startsWith("/join "))).toBe(false);
    });

    // Onboarding without autojoin leaves no conversation and so no composer.
    // The palette's own input is the one place a /join can be typed.
    it("runs the command against the network when nothing is open", async () => {
      render(<CommandPalette />);
      type("/join ##test");

      expect(selectedLabel()).toContain("/join ##test");
      await act(async () => {
        fireEvent.keyDown(input(), { key: "Enter" });
      });

      expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", SERVER_TARGET, "/join ##test");
      expect(useAppStore.getState().paletteOpen).toBe(false);
    });

    // Otherwise the first join of a session ends on "No conversation open".
    it("leaves the pane in the channel a join opened", async () => {
      render(<CommandPalette />);
      type("/join ##test");
      await act(async () => {
        fireEvent.keyDown(input(), { key: "Enter" });
      });

      expect(activeTarget()).toEqual({ network: "libera", target: "##test" });
    });

    it("stays where it is for any other command", async () => {
      useAppStore.setState(oneView({ network: "libera", target: "#ctf-ops" }));
      render(<CommandPalette />);
      type("/whois phrack");
      await act(async () => {
        fireEvent.keyDown(input(), { key: "Enter" });
      });

      expect(activeTarget()).toEqual({ network: "libera", target: "#ctf-ops" });
    });

    it("runs it in the conversation in focus when there is one", async () => {
      useAppStore.setState(oneView({ network: "libera", target: "#ctf-ops" }));
      render(<CommandPalette />);
      type("/topic something");
      await act(async () => {
        fireEvent.keyDown(input(), { key: "Enter" });
      });

      expect(ipcMock.submitInput).toHaveBeenCalledWith("libera", "#ctf-ops", "/topic something");
    });

    it("holds the palette open with the reason when the command is refused", async () => {
      ipcMock.submitInput.mockResolvedValue({ kind: "rejected", value: "No such channel" });
      render(<CommandPalette />);
      type("/join ##test");
      await act(async () => {
        fireEvent.keyDown(input(), { key: "Enter" });
      });

      expect(screen.getByRole("alert").textContent).toBe("No such channel");
      expect(useAppStore.getState().paletteOpen).toBe(true);
    });
  });

  it("runs a settings action", () => {
    // The action acts on the focused pane, so there has to be one.
    act(() => useAppStore.getState().setActive({ network: "libera", target: "#linux" }));
    render(<CommandPalette />);
    type("member list");
    fireEvent.keyDown(input(), { key: "Enter" });

    const focused = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().rosterHidden[focused]).toBe(true);
  });

  it("opens the plugins sheet", () => {
    render(<CommandPalette />);
    type("plugins");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(useAppStore.getState().pluginsOpen).toBe(true);
    expect(useAppStore.getState().paletteOpen).toBe(false);
  });

  it("closes on Escape without letting it reach the global layer", () => {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    render(<CommandPalette />);

    fireEvent.keyDown(input(), { key: "Escape" });

    document.removeEventListener("keydown", outside);
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(outside).not.toHaveBeenCalled();
  });

  it("says so when nothing matches", () => {
    render(<CommandPalette />);
    type("zzzzq");
    expect(screen.getByText(/nothing matches/i)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  describe("choosing a theme", () => {
    const root = document.documentElement;

    beforeEach(() => {
      useAppStore.setState({
        themes: catalogue().themes,
        brokenThemes: [{ id: "solarized", problems: ["theme.css has no --scrim."] }],
        themeId: "ircx-dark",
      });
    });

    afterEach(() => {
      root.removeAttribute("style");
      localStorage.clear();
    });

    it("lists every theme that loaded, and says which is in use", () => {
      render(<CommandPalette />);
      type("theme");

      expect(optionLabels()).toEqual([
        expect.stringContaining("ircx Dark"),
        expect.stringContaining("ircx Light"),
        expect.stringContaining("solarized"),
      ]);
      expect(optionLabels()[0]).toContain("in use");
    });

    it("puts the highlighted theme on the window before it is chosen", () => {
      render(<CommandPalette />);
      type("ircx Light");

      expect(root.style.getPropertyValue("--surface-base")).toBe("#ffffff");
      expect(useAppStore.getState().themeId).toBe("ircx-dark");
    });

    it("puts the chosen theme back when the palette closes without choosing", () => {
      const { unmount } = render(<CommandPalette />);
      type("ircx Light");
      unmount();

      expect(root.style.getPropertyValue("--surface-base")).toBe("#0a0d12");
      expect(root.dataset.theme).toBe("ircx-dark");
    });

    it("goes back to dark from a light theme, not only away from dark", () => {
      // Every other case here starts on dark. The owner hit this one live:
      // switching to a disk theme worked, switching back did nothing.
      useAppStore.setState({ themeId: "ircx-light" });
      applyTheme(catalogue().themes.find((t) => t.id === "ircx-light")!);
      expect(root.style.getPropertyValue("--surface-base")).toBe("#ffffff");

      render(<CommandPalette />);
      type("ircx Dark");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(root.style.getPropertyValue("--surface-base")).toBe("#0a0d12");
      expect(useAppStore.getState().themeId).toBe("ircx-dark");
      expect(localStorage.getItem("ircx.theme")).toBe("ircx-dark");
    });

    it("keeps the theme, and remembers it, on Enter", () => {
      render(<CommandPalette />);
      type("ircx Light");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(useAppStore.getState().themeId).toBe("ircx-light");
      expect(localStorage.getItem("ircx.theme")).toBe("ircx-light");
      expect(useAppStore.getState().paletteOpen).toBe(false);
    });

    it("reads out why a theme will not load rather than applying it", () => {
      render(<CommandPalette />);
      type("solarized");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(screen.getByRole("alert").textContent).toContain("theme.css has no --scrim.");
      expect(useAppStore.getState().themeId).toBe("ircx-dark");
      expect(useAppStore.getState().paletteOpen).toBe(true);
    });
  });

  /**
   * #85. `readability/READABILITY.md` study 05 asked for three densities and
   * left how a person picks one unanswered. The palette is how this client
   * answers "how do I do a thing" everywhere else.
   */
  describe("choosing a density", () => {
    const root = document.documentElement;

    beforeEach(() => {
      useAppStore.setState({ themes: catalogue().themes, themeId: "ircx-dark" });
    });

    afterEach(() => {
      applyDensity("comfortable");
      root.removeAttribute("style");
      localStorage.clear();
    });

    it("offers all three, and says which is in use", () => {
      render(<CommandPalette />);
      type("density");

      // The order is the ranker's, which has its own tests; what matters here
      // is that all three are offered and only the one in force says so.
      const rows = optionLabels();
      expect(rows).toHaveLength(3);
      for (const name of ["Compact", "Comfortable", "Read"]) {
        expect(rows.some((row) => row.includes(`Density: ${name}`))).toBe(true);
      }
      expect(rows.filter((row) => row.includes("in use"))).toEqual([
        expect.stringContaining("Density: Comfortable"),
      ]);
    });

    it("is reachable by the name of the density rather than the word", () => {
      render(<CommandPalette />);
      type("compact");

      expect(optionLabels().some((row) => row.includes("Density: Compact"))).toBe(true);
    });

    it("sets the rhythm, and remembers it, on Enter", () => {
      render(<CommandPalette />);
      type("Density: Compact");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(root.style.getPropertyValue("--timeline-block-gap")).toBe("6px");
      expect(useAppStore.getState().density).toBe("compact");
      expect(localStorage.getItem("ircx.density")).toBe("compact");
      expect(useAppStore.getState().paletteOpen).toBe(false);
    });

    /** The density is not the theme, and picking one must not quietly pick the
     * other. */
    it("leaves the theme where it was", () => {
      render(<CommandPalette />);
      type("Density: Read");
      fireEvent.keyDown(input(), { key: "Enter" });

      expect(useAppStore.getState().themeId).toBe("ircx-dark");
      expect(root.style.getPropertyValue("--surface-base")).toBe("#0a0d12");
    });
  });
});
