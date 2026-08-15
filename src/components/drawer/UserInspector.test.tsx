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

});
