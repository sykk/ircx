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

describe("default messages", () => {
  it("are on the advanced form and nowhere else", () => {
    form();
    for (const label of [/^Quit message/, /^Part message/, /^Away message/]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("reach the draft as typed", () => {
    const onChange = form();
    fireEvent.change(screen.getByLabelText(/^Quit message/), {
      target: { value: "later" },
    });
    expect(onChange).toHaveBeenCalledWith({ quitMessage: "later" });
  });

  /* An empty quit or part box means no reason at all, so a placeholder naming
   * one would be a promise the wire does not keep. Away is the exception: a
   * bare AWAY is how a client says it is back, so it always carries a word. */
  it("promise a fallback only where there is one", () => {
    form();
    expect(screen.getByLabelText(/^Quit message/).getAttribute("placeholder")).toBeNull();
    expect(screen.getByLabelText(/^Part message/).getAttribute("placeholder")).toBeNull();
    expect(screen.getByLabelText(/^Away message/).getAttribute("placeholder")).toBe("Away");
  });
});

describe("SOCKS5 proxy", () => {
  it("is available in advanced network settings", () => {
    form();
    expect(screen.getByLabelText(/^SOCKS5 proxy/)).toBeTruthy();
  });

  it("refuses an address without a port", () => {
    form({ socks5Proxy: "proxy.example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a SOCKS5 proxy as host:port/)).toBeTruthy();
  });
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
