import { describe, it, expect } from "vitest";
import { buildFtInitUpload, buildFtInitDownload } from "./transfer.js";
import { prepareClientPassword } from "./handshake.js";

describe("file transfer channel passwords", () => {
  // ftinitupload and ftinitdownload reject a plain channel password with error
  // 781, exactly like clientmove does, so the value must be the same
  // base64(sha1(password)) digest used for the handshake password fields.
  const hashed = prepareClientPassword("hunter2");
  const escaped = hashed.replace(/\//g, "\\/");

  it("ftinitupload sends the hashed password", () => {
    const cmd = buildFtInitUpload(7n, "/a.txt", "hunter2", 4n, 1, true);
    expect(cmd).toContain(`cpw=${escaped}`);
    expect(cmd).not.toContain("cpw=hunter2");
  });

  it("ftinitdownload sends the hashed password", () => {
    const cmd = buildFtInitDownload(7n, "/a.txt", "hunter2", 1);
    expect(cmd).toContain(`cpw=${escaped}`);
    expect(cmd).not.toContain("cpw=hunter2");
  });

  it("leaves an empty password empty", () => {
    const cmd = buildFtInitUpload(7n, "/a.txt", "", 4n, 1, true);
    expect(cmd).toContain("cpw=");
    expect(cmd).not.toContain("cpw=a");
  });
});
