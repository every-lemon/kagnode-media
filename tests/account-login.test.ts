import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { configuration } from "../src/config.js";
import { Store } from "../src/database.js";
import { AccountProfiles } from "../src/account-sync.js";
import { createUser, verifyPassword } from "../src/auth.js";
import { createApp } from "../src/app.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "media-provider-"));
  const config = configuration({
      DATA_DIR: directory,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
    store = new Store(config);
  let device: any,
    pending = false,
    override: any,
    hook: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  const transport = async (_method: string, endpoint: string, data?: any) => {
    calls.push(endpoint);
    if (endpoint === "device") {
      device = data;
      return {
        device_code: "D".repeat(43),
        user_code: "ABCDE-12345",
        verification_uri_complete:
          "https://nebulacoder.com/account/apps/device?code=ABCDE12345",
      };
    }
    if (endpoint === "token") {
      if (hook) await hook();
      if (pending) return { error: "authorization_pending" };
      const now = Date.now() / 1000;
      return (
        override || {
          scope: "profile.read email.read",
          access_token: "A".repeat(43),
          refresh_token: "R".repeat(43),
          authorization: {
            issuer: "https://nebulacoder.com",
            subject: "subject-a",
            client_id: "kagnode-media",
            installation: "http://localhost",
            purpose: "sign_in",
            nonce: device.nonce,
            auth_time: now - 20,
            approved_at: now,
            issued_at: now,
            expires_at: now + 120,
          },
        }
      );
    }
    if (endpoint.startsWith("profile?"))
      return {
        issuer: "https://nebulacoder.com",
        subject: "subject-a",
        name: "KagNode fixture",
        photo: "",
        email: "fixture@example.test",
        email_verified: true,
      };
    return {};
  };
  const links = new AccountProfiles(store, config.origin, transport);
  return {
    store,
    config,
    links,
    calls,
    transport,
    setPending: (v: boolean) => (pending = v),
    setReply: (v: any) => (override = v),
    setHook: (v: () => Promise<void>) => (hook = v),
    close: () => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function ready(
  f: ReturnType<typeof fixture>,
  browser = "browser-fixture",
) {
  const start: any = await f.links.login(browser, "start");
  const result = await f.links.login(browser, "status", start.attempt_id);
  assert.equal(result.authorized, true);
  return start.attempt_id;
}
test("first KagNode login creates only a viewer when signup is enabled; proof is single use", async () => {
  const f = fixture();
  try {
    const id = await ready(f);
    const user = f.links.finishLogin("browser-fixture", id);
    assert.equal(user.role, "viewer");
    assert.equal(user.creator_status, "none");
    assert.equal(user.trusted, 0);
    assert.equal(user.password, "kagnode-provider");
    assert.equal(await verifyPassword("anything", user.password), false);
    assert.throws(
      () => f.links.finishLogin("browser-fixture", id),
      /expired|changed/,
    );
    const state = await f.links.state(user.id, user.name, false, false);
    assert.equal(state.profile.email, "fixture@example.test");
    assert.ok(!JSON.stringify(state).includes("R".repeat(43)));
  } finally {
    f.close();
  }
});
test("disabled registration never creates users and same-email accounts never merge", async () => {
  const f = fixture();
  try {
    const id = await ready(f);
    const policy = f.store.policy();
    f.store.run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES('policy',?)",
      JSON.stringify({ ...policy, registration: false }),
    );
    // Store policy is serialized in its existing settings row.
    if (f.store.policy().registration)
      throw Error("Fixture failed to disable registration");
    assert.throws(
      () => f.links.finishLogin("browser-fixture", id),
      /Registration is closed/,
    );
    assert.equal(f.store.one("SELECT COUNT(*) n FROM users").n, 0);
    f.store.run(
      "INSERT OR REPLACE INTO settings(key,value) VALUES('policy',?)",
      JSON.stringify({ ...policy, registration: true }),
    );
    await createUser(
      f.store,
      "fixture@example.test",
      "Local",
      "Fictional local password!",
    );
    assert.throws(
      () => f.links.finishLogin("browser-fixture", id),
      /explicitly link/,
    );
    assert.equal(
      f.store.one("SELECT COUNT(*) n FROM account_profile_links").n,
      0,
    );
  } finally {
    f.close();
  }
});
test("provider-only or wrong nonce proof is rejected, and other browsers cannot consume it", async () => {
  const f = fixture();
  try {
    const start: any = await f.links.login("a", "start");
    await assert.rejects(
      f.links.login("b", "status", start.attempt_id),
      /expired|changed/,
    );
    f.setReply({ access_token: "A".repeat(43), refresh_token: "R".repeat(43) });
    await assert.rejects(
      f.links.login("a", "status", start.attempt_id),
      /fresh authorization/,
    );
    assert.ok(f.calls.includes("revoke"));
  } finally {
    f.close();
  }
});
test("admin disable and cancellation prevent a late sign-in authorization", async () => {
  const f = fixture();
  try {
    const start: any = await f.links.login("a", "start");
    f.setHook(async () => {
      await f.links.login("a", "cancel", start.attempt_id);
    });
    await assert.rejects(
      f.links.login("a", "status", start.attempt_id),
      /expired|changed/,
    );
    assert.ok(f.calls.includes("revoke"));
    f.setHook(async () => {});
    const id = await ready(f);
    await f.links.handle("admin", "Admin", true, "policy", { enabled: false });
    assert.throws(() => f.links.finishLogin("browser-fixture", id), /disabled/);
    assert.equal(f.store.one("SELECT COUNT(*) n FROM account_sign_in").n, 0);
  } finally {
    f.close();
  }
});
test("parallel polls exchange only once, even after polling interval", async () => {
  const f = fixture();
  try {
    const start: any = await f.links.login("a", "start");
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
    f.setHook(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const first = f.links.login("a", "status", start.attempt_id);
    await enteredPromise;
    f.store.run(
      "UPDATE account_sign_in SET polled=0 WHERE id=?",
      start.attempt_id,
    );
    assert.equal(
      (await f.links.login("a", "status", start.attempt_id)).pending,
      true,
    );
    release();
    assert.equal((await first).authorized, true);
    assert.equal(f.calls.filter((v) => v === "token").length, 1);
  } finally {
    f.close();
  }
});
test("HTTP routes require anonymous CSRF, create viewer session and permit initial local password setup", async () => {
  const f = fixture();
  try {
    const { app } = createApp(f.config, f.store);
    (app.locals.accountProfiles as any).transport = f.transport;
    const agent = request.agent(app),
      page = await agent.get("/login").set("Host", "localhost");
    assert.equal(page.status, 200, page.text);
    const csrf = /name="csrf-token" content="([^"]+)"/.exec(page.text)?.[1];
    assert.ok(csrf);
    assert.equal(
      (
        await agent
          .post("/api/v1/kagnode-login")
          .set("Host", "localhost")
          .send({ action: "start" })
      ).status,
      403,
    );
    const start = await agent
      .post("/api/v1/kagnode-login")
      .set("Host", "localhost")
      .set("X-CSRF-Token", csrf!)
      .send({ action: "start" });
    assert.equal(start.status, 200, start.text);
    const result = await agent
      .post("/api/v1/kagnode-login")
      .set("Host", "localhost")
      .set("X-CSRF-Token", csrf!)
      .send({ action: "status", attempt_id: start.body.attempt_id });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.continuation, "signed_in");
    const account = await agent.get("/account").set("Host", "localhost");
    assert.equal(account.status, 200);
    assert.match(account.text, /Set a local password/);
    const sessionCsrf = /name="csrf-token" content="([^"]+)"/.exec(
      account.text,
    )?.[1];
    assert.ok(sessionCsrf);
    const saved = await agent
      .post("/account/password")
      .set("Host", "localhost")
      .type("form")
      .send({ _csrf: sessionCsrf, password: "Offline fictional password!" });
    assert.equal(saved.status, 303, saved.text);
    const user = f.store.one("SELECT * FROM users");
    assert.equal(user.role, "viewer");
    assert.equal(
      await verifyPassword("Offline fictional password!", user.password),
      true,
    );
  } finally {
    f.close();
  }
});
