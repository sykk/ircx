import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ipc from "@/lib/ipc";
import { emptyDraft, type Draft } from "../config";
import { ServerForm } from "../ServerForm";

const certificateFingerprint = vi.fn<(path: string) => Promise<string>>();

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof Ipc>()),
  ipc: {
    certificateFingerprint: (path: string) => certificateFingerprint(path),
    announce: vi.fn(),
  },
}));

const FINGERPRINT = "4c2c2e3f8b8a5d6e7f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60";

const onSubmit = vi.fn();

/** The advanced form, since that is the only place SASL is chosen. */
function form(patch: Partial<Draft> = {}) {
  const draft: Draft = {
    ...emptyDraft(),
    host: "irc.libera.chat",
    nick: "sable",
    ...patch,
  };
  const onChange = vi.fn();
  render(
    <ServerForm
      draft={draft}
      advanced
      onChange={onChange}
      onSubmit={onSubmit}
      onBack={vi.fn()}
      onAdvanced={vi.fn()}
      busy={false}
      error={null}
    />,
  );
  return onChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  certificateFingerprint.mockResolvedValue(FINGERPRINT);
});

describe("choosing SASL EXTERNAL", () => {
  /** #373 took it out because nothing could present a certificate. #401 built
   * one, so the label stops naming something the client cannot do. */
  it("is a choice again", () => {
    form();

    const options = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);

    expect(options).toContain("EXTERNAL");
  });

  it("asks for a certificate, which no other mechanism does", () => {
    form({ mechanism: "EXTERNAL" });

    expect(screen.getByLabelText("Certificate file")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("leaves the field out for a mechanism with a password instead", () => {
    form({ mechanism: "PLAIN" });

    expect(screen.queryByLabelText("Certificate file")).toBeNull();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  /** A certificate authenticates nothing until the account service has been
   * told about it, so the fingerprint and the command that registers it are the
   * point of the field. */
  it("shows the fingerprint and the line that registers it", async () => {
    form({ mechanism: "EXTERNAL", clientCertificate: "/home/sable/.irc/libera.pem" });

    expect(await screen.findByText(`/msg NickServ CERT ADD ${FINGERPRINT}`)).toBeTruthy();
    expect(certificateFingerprint).toHaveBeenCalledWith("/home/sable/.irc/libera.pem");
  });

  it("says why a file it cannot read is no good", async () => {
    certificateFingerprint.mockRejectedValue(
      "/home/sable/notes.txt holds a private key and no certificate, so there is nothing to present",
    );
    form({ mechanism: "EXTERNAL", clientCertificate: "/home/sable/notes.txt" });

    const said = await screen.findByRole("alert");
    expect(said.textContent).toContain("no certificate");
  });

  /** The fingerprint belongs to the path it was read from. Half a path typed
   * over the top of a working one used to keep the old number on screen, which
   * is the one number in this form somebody copies without re-reading. */
  it("drops the fingerprint as soon as the path changes", async () => {
    const { rerender } = renderWith("/home/sable/.irc/libera.pem");
    expect(await screen.findByText(new RegExp(FINGERPRINT))).toBeTruthy();

    let resolve: (value: string) => void = () => {};
    certificateFingerprint.mockReturnValue(
      new Promise<string>((keep) => {
        resolve = keep;
      }),
    );
    rerender("/home/sable/.irc/lib");

    await waitFor(() => expect(screen.queryByText(new RegExp(FINGERPRINT))).toBeNull());

    resolve("aa".repeat(32));
    expect(await screen.findByText(new RegExp("aa".repeat(32)))).toBeTruthy();
  });

  it("refuses to submit until a file has been named", () => {
    form({ mechanism: "EXTERNAL" });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/EXTERNAL logs in with a certificate/)).toBeTruthy();
  });

  it("submits once one has been", async () => {
    form({ mechanism: "EXTERNAL", clientCertificate: "/home/sable/.irc/libera.pem" });
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onSubmit).toHaveBeenCalled();
  });
});

/** Rendering the same form again with a different path, which is what typing
 * into the field does by way of the parent's `onChange`. */
function renderWith(path: string) {
  const draft = (clientCertificate: string): Draft => ({
    ...emptyDraft(),
    host: "irc.libera.chat",
    nick: "sable",
    mechanism: "EXTERNAL",
    clientCertificate,
  });
  const view = render(
    <ServerForm
      draft={draft(path)}
      advanced
      onChange={vi.fn()}
      onSubmit={onSubmit}
      onBack={vi.fn()}
      onAdvanced={vi.fn()}
      busy={false}
      error={null}
    />,
  );
  return {
    rerender: (next: string) =>
      view.rerender(
        <ServerForm
          draft={draft(next)}
          advanced
          onChange={vi.fn()}
          onSubmit={onSubmit}
          onBack={vi.fn()}
          onAdvanced={vi.fn()}
          busy={false}
          error={null}
        />,
      ),
  };
}
