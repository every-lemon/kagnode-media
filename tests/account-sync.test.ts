import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuration } from "../src/config.js";
import { Store } from "../src/database.js";
import { AccountProfiles } from "../src/account-sync.js";
test("profile linking, local administrator policy and account isolation use mocked networking", async () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "kagnode-media-profiles-"),
  );
  const store = new Store(
    configuration({
      DATA_DIR: folder,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  let subject = "central-one",
    name = "KagNode Name";
  const calls: string[] = [];
  const links = new AccountProfiles(
    store,
    "http://localhost",
    async (_method, endpoint) => {
      calls.push(endpoint);
      if (endpoint === "device")
        return {
          device_code: "D".repeat(43),
          user_code: "ABCDE-12345",
          verification_uri_complete:
            "https://nebulacoder.com/account/apps/device?code=ABCDE12345",
        };
      if (endpoint === "token")
        return { access_token: "A".repeat(43), refresh_token: "R".repeat(43) };
      if (endpoint.startsWith("profile?"))
        return { issuer: "https://nebulacoder.com", subject, name, photo: "" };
      return {};
    },
  );
  try {
    await links.handle("local-one", "Local name", false, "start");
    let result: any = await links.handle(
      "local-one",
      "Local name",
      false,
      "poll",
    );
    assert.equal(result.profile.name, "KagNode Name");
    assert.equal(result.local_name, "Local name");
    assert.ok(!JSON.stringify(result).includes("R".repeat(43)));
    await links.handle("local-two", "Local name", false, "start");
    await assert.rejects(
      links.handle("local-two", "Local name", false, "poll"),
      /Disconnect/,
    );
    subject = "other-central";
    await links.handle("local-one", "Local name", false, "start");
    await assert.rejects(
      links.handle("local-one", "Local name", false, "poll"),
      /Disconnect/,
    );
    subject = "central-one";
    name = "Changed name";
    result = await links.handle("local-one", "Local name", false, "refresh");
    assert.equal(result.profile.name, "Changed name");
    await assert.rejects(
      links.handle("local-one", "Local name", false, "policy", {
        enabled: false,
      }),
      /administrator/,
    );
    result = await links.handle("admin", "Local admin", true, "policy", {
      enabled: false,
    });
    assert.equal(result.enabled, false);
    for (const action of ["updates.state", "updates.check", "updates.apply"]) {
      await assert.rejects(
        links.handle("viewer", "Viewer", false, action, { release_id: 42 }),
        /administrator/,
      );
    }
    const count = calls.length;
    assert.equal(
      (await links.state("local-one", "Local name", false)).profile,
      null,
    );
    await assert.rejects(
      links.handle("local-one", "Local name", false, "start"),
      /disabled/,
    );
    assert.equal(calls.length, count);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("disabling sync has a bounded retry queue when the issuer is offline", async () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "kagnode-media-profile-offline-"),
  );
  const store = new Store(
    configuration({
      DATA_DIR: folder,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  let online = true;
  const links = new AccountProfiles(
    store,
    "http://localhost",
    async (_method, endpoint) => {
      if (endpoint === "revoke" && !online) throw Error("offline");
      return {};
    },
  );
  try {
    store.run(
      "INSERT INTO account_profile_links VALUES(?,?,?,?,?,0)",
      "uid",
      "subject",
      JSON.stringify({
        issuer: "https://nebulacoder.com",
        subject: "subject",
        name: "Cached",
        photo: "",
      }),
      "R".repeat(43),
      Date.now(),
    );
    online = false;
    let state: any = await links.handle("admin", "Admin", true, "policy", {
      enabled: false,
    });
    assert.equal(state.enabled, false);
    assert.equal(state.revocations_pending, 1);
    assert.equal(
      store.one("SELECT COUNT(*) count FROM account_profile_links").count,
      0,
    );
    online = true;
    state = await links.handle("admin", "Admin", true, "retry_disconnections");
    assert.equal(state.revocations_pending, 0);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("an in-flight refresh cannot recreate a disconnected local profile", async () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "kagnode-media-profile-race-"),
  );
  const store = new Store(
    configuration({
      DATA_DIR: folder,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  let links: AccountProfiles;
  links = new AccountProfiles(
    store,
    "http://localhost",
    async (_method, endpoint) => {
      if (endpoint === "token") {
        await links.handle("uid", "Local", false, "disconnect");
        return { access_token: "A".repeat(43), refresh_token: "N".repeat(43) };
      }
      if (endpoint.startsWith("profile?"))
        return {
          issuer: "https://nebulacoder.com",
          subject: "subject",
          name: "Remote",
          photo: "",
        };
      return {};
    },
  );
  try {
    store.run(
      "INSERT INTO account_profile_links VALUES(?,?,?,?,?,0)",
      "uid",
      "subject",
      JSON.stringify({
        issuer: "https://nebulacoder.com",
        subject: "subject",
        name: "Cached",
        photo: "",
      }),
      "R".repeat(43),
      Date.now(),
    );
    await assert.rejects(
      links.handle("uid", "Local", false, "refresh"),
      /settings changed/,
    );
    const state = await links.state("uid", "Local", false);
    assert.equal(state.connected, false);
    assert.equal(state.profile, null);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("pending links resume privately and cancellation rejects stale or in-flight approvals", async () => {
  const folder = fs.mkdtempSync(
    path.join(os.tmpdir(), "kagnode-media-link-recovery-"),
  );
  const store = new Store(
    configuration({
      DATA_DIR: folder,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  let cancelOnToken = false;
  let revokeOffline = false;
  let attempt = "";
  const links = new AccountProfiles(
    store,
    "http://localhost",
    async (_method, endpoint) => {
      if (endpoint === "revoke" && revokeOffline)
        throw new Error("Issuer offline");
      if (endpoint === "device")
        return {
          device_code: "D".repeat(43),
          user_code: "ABCDE-12345",
          verification_uri_complete:
            "https://nebulacoder.com/account/apps/device?code=ABCDE12345",
        };
      if (endpoint === "token") {
        if (cancelOnToken) {
          cancelOnToken = false;
          await links.handle("local-one", "Local", false, "cancel", {
            attempt_id: attempt,
          });
        }
        return { access_token: "A".repeat(43), refresh_token: "R".repeat(43) };
      }
      if (endpoint.startsWith("profile?"))
        return {
          issuer: "https://nebulacoder.com",
          subject: "central-one",
          name: "KagNode member",
          photo: "",
        };
      return {};
    },
  );
  try {
    const initial = await links.handle("local-one", "Local", false, "start");
    const reopened = new AccountProfiles(store, "http://localhost");
    let state = await reopened.state("local-one", "Local", false);
    assert.equal(state.pending, true);
    assert.equal(state.user_code, initial.user_code);
    assert.equal(state.attempt_id, initial.attempt_id);
    assert.ok(state.expires_in! > 0 && state.expires_in! <= 600);
    assert.ok(!JSON.stringify(state).includes("D".repeat(43)));
    assert.equal(
      (await reopened.state("other-local", "Other", false)).pending,
      false,
    );
    store.run("UPDATE account_profile_pending SET expires=?", Date.now() - 1);
    assert.equal(
      (await reopened.state("local-one", "Local", false)).pending,
      false,
    );
    const latest = await links.handle("local-one", "Local", false, "start");
    attempt = latest.attempt_id!;
    await assert.rejects(
      links.handle("local-one", "Local", false, "cancel", {
        attempt_id: initial.attempt_id,
      }),
      /changed/,
    );
    revokeOffline = true;
    cancelOnToken = true;
    await assert.rejects(
      links.handle("local-one", "Local", false, "poll"),
      /changed/,
    );
    assert.equal(
      (await links.state("local-one", "Local", true)).revocations_pending,
      1,
    );
    revokeOffline = false;
    await links.handle("admin", "Admin", true, "retry_disconnections");
    assert.equal(
      (await links.state("local-one", "Local", true)).revocations_pending,
      0,
    );
    state = await links.state("local-one", "Local", false);
    assert.equal(state.pending, false);
    assert.equal(state.connected, false);
    await links.handle("local-one", "Local", false, "start");
    await links.handle("local-one", "Local", false, "poll");
    await assert.rejects(
      links.handle("local-one", "Local", false, "cancel", {
        attempt_id: attempt,
      }),
      /changed/,
    );
    assert.equal(
      (await links.state("local-one", "Local", false)).connected,
      true,
    );
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
