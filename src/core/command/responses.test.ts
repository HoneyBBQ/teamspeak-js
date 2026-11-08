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
    ["servergetvariables", "notifyserverupdated"],
    ["clientsetserverquerylogin", "notifyclientserverqueryloginpassword"],
  ])("answers %s with %s", (command, notification) => {
    expect(responseSpec(command)?.notifications).toEqual([notification]);
    expect(responseSpec(command)?.correlated).toBeUndefined();
  });
});

describe("banfind", () => {
  // Measured on TS6 6.0.0-beta13.1 over the voice protocol: the matching rows
  // arrive as notifybanfind, so a table without it returned no rows at all.
  it("is answered by notifybanfind", () => {
    expect(responseSpec("banfind")?.notifications).toEqual([NotificationName.BanFind]);
  });
});

describe("clientgetvariables", () => {
  it("is answered by notifyclientupdated echoing the clid", () => {
    expect(responseSpec("clientgetvariables")?.correlated).toEqual({
      notifications: ["notifyclientupdated"],
      key: "clid",
    });
  });
});

describe("getconnectioninfo", () => {
  // The row is matched on the client it names, wherever it falls against the
  // command's error.
  it("is answered by notifyconnectioninfo echoing the clid", () => {
    expect(responseSpec("getconnectioninfo")?.correlated).toEqual({
      notifications: ["notifyconnectioninfo"],
      key: "clid",
    });
  });
});

describe("setupstream", () => {
  // The announcement echoes the number the client appended; the publisher's
  // streams of the same name differ in nothing else.
  it("is answered by notifystreamstarted echoing the return_code", () => {
    expect(responseSpec("setupstream")?.correlated).toEqual({
      notifications: ["notifystreamstarted"],
      key: "return_code",
    });
  });
});

describe("S3 file transfer", () => {
  // Measured on TeamSpeak 6 6.0.0-beta13.1: every answer echoes the command's
  // return_code; the upload-done and delete answers are the command's last line.
  it("pairs each command with the answer that echoes its return_code", () => {
    expect(responseSpec("s3ft_getpresignedurl")?.correlated).toEqual({
      notifications: ["notify_presigned_urls"],
      key: "return_code",
    });
    expect(responseSpec("s3ft_list_files")?.correlated).toEqual({
      notifications: ["notify_s3ft_file_list"],
      key: "return_code",
    });
    expect(responseSpec("s3ft_upload_done_notification")?.correlated).toEqual({
      notifications: ["notify_s3ft_upload_done"],
      key: "return_code",
      endsCommand: true,
    });
    expect(responseSpec("s3ft_deletefile")?.correlated).toEqual({
      notifications: ["notify_s3ft_delete"],
      key: "return_code",
      endsCommand: true,
    });
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

  // A command whose answer the server also sends unprompted, and which carries a
  // key the answer echoes, is told from the unprompted row by that key.
  it("names the echoed key of the answers that also arrive unprompted", () => {
    expect(responseSpec("clientgetvariables")?.correlated?.key).toBe("clid");
    expect(responseSpec("getconnectioninfo")?.correlated?.key).toBe("clid");
    expect(responseSpec("channelgetdescription")?.echoKey).toBe("cid");
  });
});
