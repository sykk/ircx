import { describe, expect, it } from "vitest";
import { sameTarget, splitTargetKey, targetKey } from "./keys";

/**
 * #190. A query opened as `nickserv` and answered by `NickServ` was two
 * timelines, one of them the one on screen and empty. This map is an identity
 * map, and IRC target identity ignores case.
 */
describe("the key a conversation is held under", () => {
  it("is the same key however the target was spelled", () => {
    expect(targetKey("libera", "NickServ")).toBe(targetKey("libera", "nickserv"));
    expect(targetKey("libera", "#Test")).toBe(targetKey("libera", "#test"));
  });

  it("still tells two conversations apart", () => {
    expect(targetKey("libera", "nickserv")).not.toBe(targetKey("libera", "chanserv"));
  });

  /** One network's #test is not another's. */
  it("still tells two networks apart", () => {
    expect(targetKey("libera", "#test")).not.toBe(targetKey("localhost", "#test"));
  });

  it("agrees with the comparison beside it", () => {
    const pairs: [string, string][] = [
      ["NickServ", "nickserv"],
      ["#Test", "#test"],
      ["nickserv", "chanserv"],
    ];
    for (const [a, b] of pairs) {
      expect(targetKey("libera", a) === targetKey("libera", b)).toBe(sameTarget(a, b));
    }
  });

  it("can be taken apart again", () => {
    expect(splitTargetKey(targetKey("libera", "#test"))).toEqual({
      network: "libera",
      target: "#test",
    });
  });
});
