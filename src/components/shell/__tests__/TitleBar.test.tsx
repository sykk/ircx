import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { TitleBar } from "../TitleBar";
import { makeNetwork, oneView, resetStore, seedStore } from "../fixtures";

beforeEach(resetStore);

describe("TitleBar", () => {
  it("keeps Settings with the app controls and separates the window controls", () => {
    seedStore([makeNetwork("libera")]);
    render(<TitleBar />);

    const settings = screen.getByRole("button", { name: "Settings" });
    const minimize = screen.getByRole("button", { name: "Minimise" });
    expect(settings.parentElement?.parentElement).not.toBe(minimize.parentElement?.parentElement);
    expect(minimize.parentElement?.parentElement?.className).toContain("border-l");
  });

  it("shows the displayed network with the worst state across the app", () => {
    seedStore([
      makeNetwork("libera", { name: "Libera.Chat" }),
      makeNetwork("oftc", {
        status: { state: "failed", detail: { message: "certificate expired" } },
      }),
    ]);
    useAppStore.setState(oneView({ network: "libera", target: "#ircx" }));
    render(<TitleBar />);

    const problemCount = screen.getByLabelText("1 network needs attention");
    const dot = problemCount.parentElement?.querySelector<HTMLElement>(".size-2");
    expect(problemCount.textContent).toBe("1");
    expect(problemCount.parentElement?.textContent).toContain("Libera.Chat");
    expect(dot?.style.background).toBe("var(--state-error)");
  });
});
