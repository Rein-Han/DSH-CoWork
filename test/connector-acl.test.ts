import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// The connector ships as plain JS inside the DSH profile; load it from source.
// This file compiles to dist-test/test/, so the repo root is two levels up.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface ConnectorAcl {
  parseIcacls(stdout: string, pathPrefix?: string): Array<{ principal: string; inherited: boolean }>;
  aclViolations(
    rows: Array<{ principal: string; inherited: boolean }>,
    identity: string | { sid: string; name?: string },
    options?: { allowInherited?: boolean },
  ): string[];
  parseWhoamiUser(stdout: string): { sid: string; name?: string };
}

async function loadAcl(): Promise<ConnectorAcl> {
  return (await import(pathToFileURL(`${ROOT}packages/desktop-connector/lib/acl.js`).href)) as ConnectorAcl;
}

const identity = { name: "laptop-test\\alice", sid: "S-1-5-21-1-2-3-1001" };

describe("connector ACL policy against real icacls formats", () => {
  it("accepts a restricted directory listed by account name", async () => {
    const acl = await loadAcl();
    const rows = acl.parseIcacls(
      [
        "C:\\x BUILTIN\\Administrators:(OI)(CI)(F)",
        "     NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
        "     LAPTOP-TEST\\alice:(OI)(CI)(F)",
      ].join("\n"),
      "C:\\x",
    );
    assert.deepEqual(acl.aclViolations(rows, identity), []);
  });

  it("accepts a file whose only entries are inherited from the private directory", async () => {
    const acl = await loadAcl();
    const rows = acl.parseIcacls(
      [
        "C:\\x\\connection.json BUILTIN\\Administrators:(I)(F)",
        "                       NT AUTHORITY\\SYSTEM:(I)(F)",
        "                       LAPTOP-TEST\\alice:(I)(F)",
      ].join("\n"),
      "C:\\x\\connection.json",
    );
    assert.deepEqual(acl.aclViolations(rows, identity, { allowInherited: true }), []);
    // The directory check itself still refuses inheritance.
    assert.match(acl.aclViolations(rows, identity).join("; "), /inherited entry/u);
  });

  it("still refuses broad or foreign principals on a file, inherited or not", async () => {
    const acl = await loadAcl();
    const rows = acl.parseIcacls(
      ["C:\\f BUILTIN\\Users:(I)(RX)", "     LAPTOP-TEST\\bob:(I)(F)"].join("\n"),
      "C:\\f",
    );
    const problems = acl.aclViolations(rows, identity, { allowInherited: true }).join("; ");
    assert.match(problems, /builtin\\users/iu);
    assert.match(problems, /bob/u);
  });

  it("parses whoami csv output and rejects GNU whoami output", async () => {
    const acl = await loadAcl();
    assert.deepEqual(acl.parseWhoamiUser('"laptop-test\\alice","S-1-5-21-1-2-3-1001"\r\n'), identity);
    assert.throws(() => acl.parseWhoamiUser("whoami: extra operand '/user'"), /SID/u);
  });
});
