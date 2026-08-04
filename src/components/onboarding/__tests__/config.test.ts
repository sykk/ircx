import { describe, expect, it } from "vitest";
import type { NetworkConfig } from "@/types";
import {
  draftOf,
  draftProblems,
  emptyDraft,
  hasStoredPassword,
  parseChannels,
  parsePort,
  presetDraft,
  PUBLIC_NETWORKS,
  toConfig,
  type Draft,
} from "../config";

const LIBERA = PUBLIC_NETWORKS[0] as (typeof PUBLIC_NETWORKS)[number];

function liberaDraft(patch: Partial<Draft> = {}): Draft {
  return { ...presetDraft(LIBERA, emptyDraft()), nick: "sable", ...patch };
}

describe("parseChannels", () => {
  it("adds the sigil the user left off", () => {
    expect(parseChannels("linux rust")).toEqual(["#linux", "#rust"]);
  });

  it("splits on commas as well as spaces", () => {
    expect(parseChannels("#linux, #rust")).toEqual(["#linux", "#rust"]);
  });

  it("leaves other channel prefixes alone", () => {
    expect(parseChannels("&local !ABCDEchan +modeless")).toEqual([
      "&local",
      "!ABCDEchan",
      "+modeless",
    ]);
  });

  it("drops a repeated channel rather than joining it twice", () => {
    expect(parseChannels("#linux linux")).toEqual(["#linux"]);
  });

  it("is empty for blank input", () => {
    expect(parseChannels("   ")).toEqual([]);
  });
});

describe("parsePort", () => {
  it("accepts a port in range", () => {
    expect(parsePort(" 6697 ")).toBe(6697);
  });

  it.each(["0", "65536", "abc", "", "66.9"])("rejects %o", (text) => {
    expect(parsePort(text)).toBeNull();
  });
});

describe("toConfig", () => {
  it("connects the Libera preset over TLS on 6697", () => {
    const config = toConfig(liberaDraft());
    expect(config).toMatchObject({
      name: "Libera.Chat",
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      tlsVerify: true,
      clientCertificate: null,
      nick: "sable",
      sasl: null,
      autoConnect: true,
    });
  });

  it("falls back to the nickname for the fields the user did not fill in", () => {
    const config = toConfig(liberaDraft());
    expect(config.username).toBe("sable");
    expect(config.realname).toBe("sable");
  });

  it("names the network after the host when the name is blank", () => {
    expect(toConfig(liberaDraft({ name: "", host: "irc.example.org" })).name).toBe(
      "irc.example.org",
    );
  });

  it("authenticates with PLAIN under the nickname when no account is given", () => {
    const config = toConfig(liberaDraft({ mechanism: "PLAIN", password: "hunter2" }));
    expect(config.sasl).toEqual({
      mechanism: "PLAIN",
      account: "sable",
      password: "hunter2",
    });
  });

  it("keeps an account that differs from the nickname", () => {
    const config = toConfig(
      liberaDraft({ mechanism: "PLAIN", account: "sable-alt", password: "hunter2" }),
    );
    expect(config.sasl?.account).toBe("sable-alt");
  });

  it("sends no password with EXTERNAL, which authenticates by certificate", () => {
    const config = toConfig(liberaDraft({ mechanism: "EXTERNAL", password: "hunter2" }));
    expect(config.sasl).toEqual({
      mechanism: "EXTERNAL",
      account: "sable",
      password: null,
    });
  });

  it("takes the port from the field over the TLS default", () => {
    expect(toConfig(liberaDraft({ port: "7000" })).port).toBe(7000);
  });

  it("falls back to the plaintext port when TLS is off and the port is unusable", () => {
    expect(toConfig(liberaDraft({ tls: false, port: "" })).port).toBe(6667);
  });

  it("strips the leading slash a user types out of habit", () => {
    const config = toConfig(
      liberaDraft({ connectCommands: "/mode sable +i\n\nmsg NickServ help\n" }),
    );
    expect(config.connectCommands).toEqual(["mode sable +i", "msg NickServ help"]);
  });

  it("splits alternate nicknames on whitespace", () => {
    expect(toConfig(liberaDraft({ altNicks: "sable_  sable__" })).altNicks).toEqual([
      "sable_",
      "sable__",
    ]);
  });

  it("produces a config the advanced form can fill in completely", () => {
    const config = toConfig({
      id: null,
      name: "Example",
      host: " irc.example.org ",
      port: "6667",
      tls: false,
      tlsVerify: false,
      clientCertificate: "",
      nick: " sable ",
      altNicks: "sable_",
      username: "sbl",
      realname: "Sable",
      mechanism: "PLAIN",
      account: "sable",
      password: "hunter2",
      connectCommands: "mode sable +i",
      autojoin: "#linux",
      autoConnect: false,
    });

    expect(config).toEqual<NetworkConfig>({
      id: null,
      name: "Example",
      host: "irc.example.org",
      port: 6667,
      tls: false,
      tlsVerify: false,
      clientCertificate: null,
      nick: "sable",
      altNicks: ["sable_"],
      username: "sbl",
      realname: "Sable",
      sasl: { mechanism: "PLAIN", account: "sable", password: "hunter2" },
      connectCommands: ["mode sable +i"],
      autojoin: ["#linux"],
      autoConnect: false,
    });
  });

  /** #401. No form field draws the certificate yet, so nothing would have
   * noticed the draft dropping it — until somebody opened a network's settings,
   * changed their nick, pressed save, and stopped being able to log in. */
  it("carries a certificate through a round trip that never displays it", () => {
    const saved: NetworkConfig = {
      id: "n1",
      name: "Libera",
      host: "irc.libera.chat",
      port: 6697,
      tls: true,
      tlsVerify: true,
      clientCertificate: "/home/sable/.irc/libera.pem",
      nick: "sable",
      altNicks: [],
      username: "sable",
      realname: "Sable",
      sasl: { mechanism: "EXTERNAL", account: "sable", password: null },
      connectCommands: [],
      autojoin: [],
      autoConnect: true,
    };

    expect(toConfig(draftOf(saved)).clientCertificate).toBe("/home/sable/.irc/libera.pem");
    // And a network with none keeps none, rather than gaining an empty path.
    expect(toConfig(draftOf({ ...saved, clientCertificate: null })).clientCertificate).toBeNull();
  });
});

describe("a password already in the keyring", () => {
  const saved: NetworkConfig = {
    ...toConfig(liberaDraft({ mechanism: "PLAIN", password: "hunter2" })),
    id: "net-1",
    // What `list_network_configs` gives back: the account, never the password.
    sasl: { mechanism: "PLAIN", account: "sable", password: null },
  };

  it("is reported as saved rather than shown as an empty field", () => {
    expect(hasStoredPassword(draftOf(saved))).toBe(true);
  });

  it("survives a round trip that does not touch it", () => {
    expect(toConfig(draftOf(saved)).sasl).toEqual({
      mechanism: "PLAIN",
      account: "sable",
      password: null,
    });
  });

  it("is replaced by what the user types instead", () => {
    const replaced = { ...draftOf(saved), password: "correct horse" };
    expect(hasStoredPassword(replaced)).toBe(false);
    expect(toConfig(replaced).sasl?.password).toBe("correct horse");
  });

  it("is not claimed for a network that has never been saved", () => {
    expect(hasStoredPassword(liberaDraft({ mechanism: "PLAIN" }))).toBe(false);
  });

  it("is not claimed once the user turns SASL off", () => {
    expect(hasStoredPassword({ ...draftOf(saved), mechanism: "none" })).toBe(false);
  });
});

describe("draftProblems", () => {
  it("passes a filled-in draft", () => {
    expect(draftProblems(liberaDraft())).toEqual({});
  });

  it("asks for an address with an example", () => {
    expect(draftProblems(liberaDraft({ host: "" })).host).toContain("irc.example.org");
  });

  it("points a pasted host:port at the port field", () => {
    expect(draftProblems(liberaDraft({ host: "irc.example.org:6697" })).host).toContain(
      "port goes in the next field",
    );
  });

  it("rejects a port outside the range", () => {
    expect(draftProblems(liberaDraft({ port: "0" })).port).toContain("1 and 65535");
  });

  it("holds a known network to its own nickname limit", () => {
    expect(draftProblems(liberaDraft({ nick: "a".repeat(17) })).nick).toContain("16");
  });

  it("allows a longer nickname on a server whose limit it does not know", () => {
    expect(
      draftProblems(liberaDraft({ host: "irc.example.org", nick: "a".repeat(17) })).nick,
    ).toBeUndefined();
  });
});
