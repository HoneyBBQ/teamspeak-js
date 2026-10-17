import { describe, expect, it } from "vitest";
import { CommandName } from "../command-name.js";
import { NotificationName } from "../notification-name.js";
import { RESPONSES, responseSpec } from "./responses.js";

describe("responseSpec", () => {
  it("knows the privilege key commands and their token aliases", () => {
    expect(responseSpec("privilegekeyadd")?.notifications).toEqual(["notifytokenadd"]);
    expect(responseSpec("privilegekeylist")?.notifications).toEqual(["notifytokenlist"]);
    expect(responseSpec("tokenadd")?.notifications).toEqual(["notifytokenadd"]);
    expect(responseSpec("tokenlist")?.notifications).toEqual(["notifytokenlist"]);
  });

  // Each answer was measured on TS3 3.13.8 and TS6 6.0.0-beta13.1 over the voice
  // protocol: the rows arrive in this notification, not as nameless rows.
  it.each([
    ["apikeyadd", "notifyapikeyadd"],
    ["apikeylist", "notifyapikeylist"],
    ["permget", "notifypermget"],
    ["getconnectioninfo", "notifyconnectioninfo"],
    ["clientgetvariables", "notifyclientupdated"],
    ["servergetvariables", "notifyserverupdated"],
    ["clientsetserverquerylogin", "notifyclientserverqueryloginpassword"],
  ])("answers %s with %s", (command, notification) => {
    expect(responseSpec(command)?.notifications).toEqual([notification]);
    expect(responseSpec(command)?.correlated).toBeUndefined();
  });
});

describe("RESPONSES", () => {
  // Every name the table keys on or waits for is one the name tables know, so
  // a typo here cannot go unnoticed.
  it("uses only names CommandName and NotificationName list", () => {
    const commands = new Set<string>(Object.values(CommandName));
    const notifications = new Set<string>(Object.values(NotificationName));
    for (const [command, spec] of Object.entries(RESPONSES)) {
      expect(commands.has(command), command).toBe(true);
      const answers = [
        ...(spec.notifications ?? []),
        ...(spec.correlated?.notifications ?? []),
        ...(spec.correlated?.failure ? [spec.correlated.failure] : []),
      ];
      for (const name of answers) expect(notifications.has(name), name).toBe(true);
    }
  });
});
