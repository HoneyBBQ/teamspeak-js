import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseServerCapabilities } from "./capabilities.js";

// `initserver` is the server describing itself, and the only place the version
// and the icon id are read from. Whatever it says, it must be read without
// throwing, into a family and an icon that mean what their types promise.

const text = fc.oneof(
  fc.constantFrom(
    "",
    "3.13.7 [Build: 1]",
    "6.0.0-beta13.1 [Build: 1]",
    "-1",
    "99999999999999999999",
    "x",
    "-2004712318",
    "2290254978",
    "4294967296",
    " https://example.com/banner.png ",
    "   ",
  ),
  fc.string({ unit: "binary", maxLength: 40 }),
);

describe("what a server says about itself", () => {
  it("is read without throwing, whatever it says", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(
            "virtualserver_version",
            "virtualserver_capability_extensions",
            "virtualserver_welcomemessage",
          ),
          text,
        ),
        (params) => {
          const capabilities = parseServerCapabilities(params);
          expect(Number.isInteger(capabilities.major)).toBe(true);
          expect(capabilities.family === "ts3").toBe(capabilities.major === 3);
          expect(capabilities.family === "ts6").toBe(capabilities.major >= 6);
          const names = capabilities.extensions;
          expect(new Set(names).size).toBe(names.length);
          for (const name of names) {
            expect(name).not.toBe("");
            expect(name).toBe(name.trim());
            expect(name).not.toContain(",");
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("is read from a version string alone", () => {
    fc.assert(
      fc.property(text, (version) => {
        const capabilities = parseServerCapabilities(version);
        expect(capabilities.version).toBe(version);
        expect(parseServerCapabilities({ virtualserver_version: version }).family).toBe(
          capabilities.family,
        );
      }),
      { numRuns: 500 },
    );
  });
});
