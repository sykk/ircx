import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { useAppStore } from "@/store";
import { targetKey } from "@/store/keys";
import type { Member } from "@/types";
import { UserInspector } from "./UserInspector";
import { CTF_OPS_MEMBERS, member } from "./fixtures";

const CHANNEL = "#ctf-ops";

beforeEach(() => {
  useAppStore.setState({
    members: {
      [targetKey("libera", CHANNEL)]: CTF_OPS_MEMBERS,
      [targetKey("libera", "#ctf-web")]: [member("wren"), member("sable")],
      [targetKey("libera", "#marrow")]: [member("sable")],
      [targetKey("oftc", "#linux")]: [member("wren")],
    },
  });
});

function inspect(target: Member, self: Member | undefined) {
  return render(
    <UserInspector
      network="libera"
      channel={CHANNEL}
      member={target}
      self={self}
      onBack={vi.fn()}
    />,
  );
}

function button(name: string) {
  return screen.getByRole("button", { name });
}

const wren = CTF_OPS_MEMBERS.find((m) => m.nick === "wren")!;
const nyx = CTF_OPS_MEMBERS.find((m) => m.nick === "nyx")!;

describe("UserInspector", () => {
  it("lists the channels shared on this network only", () => {
    inspect(wren, undefined);
    const shared = screen.getByRole("list");
    expect(within(shared).getByText(CHANNEL)).toBeTruthy();
    expect(within(shared).getByText("#ctf-web")).toBeTruthy();
    expect(within(shared).queryByText("#linux")).toBeNull();
  });

  it("shows the account and the away reason", () => {
    inspect(wren, undefined);
    expect(screen.getByText("wren", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText("away — sleep")).toBeTruthy();
  });

  it("says so when the nick is not identified to services", () => {
    inspect(member("guest41"), undefined);
    expect(screen.getByText("not identified")).toBeTruthy();
  });

  it("offers nothing privileged to a member with no prefix", () => {
    inspect(wren, member("sable"));
    for (const label of ["Give ops", "Give voice", "Kick", "Ban"]) {
      expect(button(label)).toHaveProperty("disabled", true);
    }
    expect(button("Message")).toHaveProperty("disabled", false);
    expect(button("Whois")).toHaveProperty("disabled", false);
  });

  it("offers nothing privileged when the local user is missing from NAMES", () => {
    inspect(wren, undefined);
    expect(button("Kick")).toHaveProperty("disabled", true);
  });

  it("lets a halfop kick and voice but not touch ops or bans", () => {
    inspect(wren, member("sable", { prefixes: ["%"] }));
    expect(button("Kick")).toHaveProperty("disabled", false);
    expect(button("Give voice")).toHaveProperty("disabled", false);
    expect(button("Give ops")).toHaveProperty("disabled", true);
    expect(button("Ban")).toHaveProperty("disabled", true);
  });

  it("opens everything to an operator", () => {
    inspect(wren, member("sable", { prefixes: ["@"] }));
    for (const label of ["Give ops", "Give voice", "Kick", "Ban"]) {
      expect(button(label)).toHaveProperty("disabled", false);
    }
  });

  it("offers to take back the privileges the target already holds", () => {
    inspect(nyx, member("sable", { prefixes: ["@"] }));
    expect(button("Take ops")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Give ops" })).toBeNull();
  });
});
