import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import request from "supertest";
import { configuration } from "../src/config.js";
import { Store, digest } from "../src/database.js";
import { createUser } from "../src/auth.js";
import { createApp } from "../src/app.js";

test("Core summaries require local identity and CSRF; receipts stay per user", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "media-notices-"));
  const oldRoot = process.env.KAGNODE_CORE_ROOT;
  process.env.KAGNODE_CORE_ROOT = folder;
  fs.mkdirSync(path.join(folder, "run"));
  const event = {
    available: true,
    notice: {
      id: "a".repeat(64),
      version: "5.0.6",
      title: "Interface updated",
      items: ["Improved shared controls."],
    },
  };
  const actions: string[] = [];
  const manager = http.createServer((q, r) => {
    let data = "";
    q.on("data", (chunk) => (data += chunk));
    q.on("end", () => {
      const value = JSON.parse(data);
      actions.push(value.action);
      r.setHeader("Content-Type", "application/json");
      r.end(JSON.stringify(event));
    });
  });
  await new Promise<void>((resolve) =>
    manager.listen(path.join(folder, "run/media.sock"), resolve),
  );
  const store = new Store(
    configuration({
      DATA_DIR: path.join(folder, "data"),
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  try {
    const { app } = createApp(store.config, store);
    const owner = await createUser(
      store,
      "owner@notice.test",
      "Owner",
      "Only a disposable test password 91!",
      "admin",
    );
    const member = await createUser(
      store,
      "member@notice.test",
      "Member",
      "Only a disposable test password 91!",
    );
    const session = (user: any, token: string) => {
      store.run(
        "INSERT INTO sessions VALUES(?,?,?,?)",
        digest(token),
        user.id,
        "test-csrf",
        Date.now() + 60000,
      );
      return `kagnode.media.sid=${token}`;
    };
    const first = session(owner, "owner-session"),
      second = session(member, "member-session");
    const url = "/api/v1/kagnode-core/whats-new";
    assert.equal(
      (await request(app).get(url).set("Host", "localhost")).status,
      401,
    );
    assert.equal(actions.length, 0);
    assert.deepEqual(
      (
        await request(app)
          .get(url)
          .set("Host", "localhost")
          .set("Cookie", second)
      ).body,
      event,
    );
    assert.equal(
      (
        await request(app)
          .post(url + "/dismiss")
          .set("Host", "localhost")
          .set("Cookie", second)
          .send({ id: event.notice.id })
      ).status,
      403,
    );
    const dismiss = await request(app)
      .post(url + "/dismiss")
      .set("Host", "localhost")
      .set("Cookie", second)
      .set("X-CSRF-Token", "test-csrf")
      .send({ id: event.notice.id });
    assert.equal(dismiss.status, 200, dismiss.text);
    assert.deepEqual(dismiss.body, { dismissed: true });
    assert.deepEqual(
      (
        await request(app)
          .get(url)
          .set("Host", "localhost")
          .set("Cookie", second)
      ).body,
      { available: true, notice: null },
    );
    assert.deepEqual(
      (
        await request(app)
          .get(url)
          .set("Host", "localhost")
          .set("Cookie", first)
      ).body,
      event,
    );
    assert.equal(
      (
        await request(app)
          .get("/api/v1/kagnode-core/status")
          .set("Host", "localhost")
          .set("Cookie", second)
      ).status,
      403,
    );
    assert.deepEqual(new Set(actions), new Set(["summary"]));
    assert.equal(store.one("SELECT COUNT(*) n FROM core_notice_receipts").n, 1);
  } finally {
    store.close();
    await new Promise<void>((resolve) => manager.close(() => resolve()));
    if (oldRoot === undefined) delete process.env.KAGNODE_CORE_ROOT;
    else process.env.KAGNODE_CORE_ROOT = oldRoot;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
