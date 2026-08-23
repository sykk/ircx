import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetwork, resetStore, seedStore } from "@/components/shell/fixtures";
import { SettingsBusy } from "../SettingsPage";
import { DiagnosticsPage } from "./DiagnosticsPage";

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
Object.assign(navigator, { clipboard: { writeText } });

beforeEach(() => {
  resetStore();
  writeText.mockClear();
});

function mount() {
  render(
    <SettingsBusy>
      <DiagnosticsPage onDone={() => {}} />
    </SettingsBusy>,
  );
}

describe("connection diagnostics", () => {
  it("shows live connection details", () => {
    seedStore([
      makeNetwork("libera", {
        name: "Libera.Chat",
        status: { state: "reconnecting", detail: { inSeconds: 12 } },
        currentNick: "sable_",
        sasl: { state: "authenticated", detail: { account: "sable", refused: null } },
        capsEnabled: ["server-time", "batch"],
        lagMs: 42,
      }),
    ]);

    mount();

    expect(screen.getByRole("heading", { name: "Libera.Chat" })).toBeTruthy();
    expect(screen.getByText("Retry in 12s")).toBeTruthy();
    expect(screen.getByText("irc.libera.net:6697")).toBeTruthy();
    expect(screen.getByText("Authenticated as sable")).toBeTruthy();
    expect(screen.getByText("batch, server-time")).toBeTruthy();
    expect(screen.getByText("42 ms")).toBeTruthy();
  });

  it("copies the report without credentials or protocol lines", async () => {
    seedStore([
      makeNetwork("libera", {
        sasl: { state: "failed", detail: { message: "Account rejected" } },
        capsEnabled: ["sasl"],
      }),
    ]);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const report = writeText.mock.calls[0]?.[0] ?? "";
    expect(report).toContain("Endpoint: irc.libera.net:6697");
    expect(report).toContain("SASL: Failed: Account rejected");
    expect(report).toContain("Capabilities: sasl");
    expect(report).not.toContain("password");
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("says when no networks are configured", () => {
    mount();
    expect(screen.getByText("No networks are configured.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy report" })).toBeNull();
  });
});
