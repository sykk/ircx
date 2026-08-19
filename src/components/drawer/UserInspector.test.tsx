import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type * as Ipc from "@/lib/ipc";
import type { Member } from "@/types";
import { UserInspector } from "./UserInspector";
import { CTF_OPS_MEMBERS, member } from "./fixtures";

const CHANNEL = "#ctf-ops";

const setIgnored = vi.fn();

vi.mock("@/lib/ipc", async (importOriginal) => {
  const original = await importOriginal<typeof Ipc>();
  return {
    ...original,
    ipc: { ...original.ipc, setIgnored: (...args: unknown[]) => setIgnored(...args) },
  };
});

beforeEach(() => {
  setIgnored.mockReset();
  setIgnored.mockResolvedValue(undefined);
  useAppStore.setState({
    ignored: {},
    members: {
      [targetKey("libera", CHANNEL)]: CTF_OPS_MEMBERS,
      [targetKey("libera", "#ctf-web")]: [member("wren"), member("sable")],
      [targetKey("libera", "#marrow")]: [member("sable")],
      [targetKey("oftc", "#linux")]: [member("wren")],
    },
  });
});

function inspect(target: Member) {
  return render(
    <UserInspector
      network="libera"
      member={target}
      onBack={vi.fn()}
    />,
  );
}

const wren = CTF_OPS_MEMBERS.find((m) => m.nick === "wren")!;

describe("UserInspector", () => {
  it("lists the channels shared on this network only", () => {
    inspect(wren);
    const shared = screen.getByRole("list");
    expect(within(shared).getByText(CHANNEL)).toBeTruthy();
    expect(within(shared).getByText("#ctf-web")).toBeTruthy();
    expect(within(shared).queryByText("#linux")).toBeNull();
  });

  it("shows the account and the away reason", () => {
    inspect(wren);
    expect(screen.getByText("wren", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("away — sleep")).toBeTruthy();
  });

  it("says so when the nick is not identified to services", () => {
    inspect(member("guest41"));
    expect(screen.getByText("not identified")).toBeTruthy();
  });

  it("offers to ignore somebody who is not", () => {
    inspect(wren);
    expect(screen.getByRole("button", { name: "Ignore" })).toBeTruthy();
    expect(screen.queryByText(/You are ignoring/)).toBeNull();
  });

  /** Without this the reader is looking at a person whose messages are missing
   * for no reason the window gives. */
  it("names the ignore when there is one, and offers to undo it", () => {
    useAppStore.setState({ ignored: { libera: ["Wren"] } });
    inspect(wren);

    expect(screen.getByText("You are ignoring wren. Nothing they say is kept.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop ignoring" })).toBeTruthy();
  });

  it("asks the backend to ignore, naming the network it is on", async () => {
    inspect(wren);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));

    await waitFor(() => expect(setIgnored).toHaveBeenCalledWith("libera", "wren", true));
  });

  it("says why it could not be changed", async () => {
    setIgnored.mockRejectedValue("The archive is locked.");
    inspect(wren);
    fireEvent.click(screen.getByRole("button", { name: "Ignore" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The archive is locked.");
  });
});
