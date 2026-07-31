import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store";
import { resetStore } from "@/components/shell/fixtures";
import { UploadSheet } from "../UploadSheet";

const { ipcMock } = vi.hoisted(() => ({
  ipcMock: {
    getUploadProvider: vi.fn(),
    saveUploadProvider: vi.fn(),
    removeUploadProvider: vi.fn(),
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: ipcMock, onIrcxEvent: vi.fn(), chooseFolder: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  ipcMock.getUploadProvider.mockResolvedValue(null);
  ipcMock.saveUploadProvider.mockResolvedValue(undefined);
  ipcMock.removeUploadProvider.mockResolvedValue(undefined);
});

function open() {
  useAppStore.getState().toggleUpload(true);
  render(<UploadSheet />);
}

describe("the upload provider sheet", () => {
  it("stays out of the way until something opens it", () => {
    const { container } = render(<UploadSheet />);
    expect(container.firstChild).toBeNull();
    expect(ipcMock.getUploadProvider).not.toHaveBeenCalled();
  });

  it("saves what was typed", async () => {
    open();
    fireEvent.change(await screen.findByLabelText("Address"), {
      target: { value: "https://files.example.com/{name}" },
    });
    fireEvent.change(screen.getByLabelText(/^Token/), { target: { value: "Bearer sekrit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(ipcMock.saveUploadProvider).toHaveBeenCalledWith({
        endpoint: "https://files.example.com/{name}",
        method: "PUT",
        authHeader: "Authorization",
        token: "Bearer sekrit",
      }),
    );
  });

  /** The user cannot see the stored token, so an endpoint correction must not
   * ask them to retype it — and must not send an empty one that wipes it. */
  it("sends no token when the field is left alone, so the stored one stands", async () => {
    ipcMock.getUploadProvider.mockResolvedValue({
      endpoint: "https://files.example.com/{name}",
      method: "PUT",
      authHeader: "Authorization",
      token: null,
    });
    open();

    expect(await screen.findByText("Saved in your system keyring. Leave empty to keep it."))
      .toBeTruthy();
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://moved.example.com/{name}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(ipcMock.saveUploadProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: "https://moved.example.com/{name}",
          token: null,
        }),
      ),
    );
  });

  /** "No provider" is a configuration, so it is a button rather than an empty
   * address — which would otherwise read as a half-finished form. */
  it("offers removal only when there is one to remove", async () => {
    open();
    await screen.findByLabelText("Address");
    expect(screen.queryByRole("button", { name: "Remove provider" })).toBeNull();
  });

  it("removes the provider and its token together", async () => {
    ipcMock.getUploadProvider.mockResolvedValue({
      endpoint: "https://files.example.com/{name}",
      method: "PUT",
      authHeader: null,
      token: null,
    });
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Remove provider" }));

    await waitFor(() => expect(ipcMock.removeUploadProvider).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().uploadOpen).toBe(false));
  });

  /** An empty address is not "no provider": saving it would leave a provider
   * configured that no upload could reach. */
  it("refuses an empty address and says what to do instead", async () => {
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert").textContent).toContain("Remove the provider instead");
    expect(ipcMock.saveUploadProvider).not.toHaveBeenCalled();
  });

  it("shows why a save was refused and stays open", async () => {
    ipcMock.saveUploadProvider.mockRejectedValue("The keyring is locked");
    open();
    fireEvent.change(await screen.findByLabelText("Address"), {
      target: { value: "https://files.example.com/{name}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("The keyring is locked")).toBeTruthy();
    expect(useAppStore.getState().uploadOpen).toBe(true);
  });
});
