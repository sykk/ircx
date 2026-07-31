import { describe, expect, it } from "vitest";
import { describeUrl } from "./url";

describe("describeUrl", () => {
  it("leads with the host and keeps a short tail whole", () => {
    expect(describeUrl("https://example.com/a/b")).toEqual({ host: "example.com", tail: "/a/b" });
  });

  it("gives a bare host no tail, with or without the trailing slash", () => {
    expect(describeUrl("https://example.com")).toEqual({ host: "example.com", tail: "" });
    expect(describeUrl("https://example.com/")).toEqual({ host: "example.com", tail: "" });
  });

  it("elides a long tail down to the segment that names the thing", () => {
    expect(describeUrl("https://github.com/ergochat/ergo/blob/master/CHANGELOG.md")).toEqual({
      host: "github.com",
      tail: "/…/CHANGELOG.md",
    });
  });

  it("truncates a last segment that is itself too long to print", () => {
    const label = describeUrl(`https://example.com/x/${"a".repeat(80)}`)!;
    expect(label.tail.length).toBeLessThanOrEqual(28);
    expect(label.tail.endsWith("…")).toBe(true);
  });

  it("keeps a port, which is part of where the link goes", () => {
    expect(describeUrl("https://example.com:8443/x")).toEqual({
      host: "example.com:8443",
      tail: "/x",
    });
  });

  // The reason this parses rather than slices. Read as a string, the host looks
  // like github.com to anyone skimming; it is evil.com.
  it("resolves the real host past a userinfo that imitates one", () => {
    expect(describeUrl("https://github.com@evil.com/ergochat/ergo")).toMatchObject({
      host: "evil.com",
    });
  });

  it("leaves an international domain in the punycode it arrived as", () => {
    expect(describeUrl("https://xn--80ak6aa92e.com/x")).toMatchObject({
      host: "xn--80ak6aa92e.com",
    });
  });

  it("returns nothing when there is no host to lead with", () => {
    expect(describeUrl("mailto:sable@example.com")).toBeNull();
    expect(describeUrl("not a url")).toBeNull();
    expect(describeUrl("/just/a/path")).toBeNull();
  });
});
