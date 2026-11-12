/** Disposable local browser fixture. Never starts native codecs or a worker. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { configuration } from "../src/config.js";
import { Store } from "../src/database.js";
import { createUser } from "../src/auth.js";
import { createApp } from "../src/app.js";
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "media-login-browser-"),
);
const server = http.createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number },
  origin = `http://127.0.0.1:${address.port}`;
const config = configuration({
    DATA_DIR: directory,
    PUBLIC_URL: origin,
    NODE_ENV: "test",
  }),
  store = new Store(config);
const password = "Only a fictional local password!";
await createUser(store, "local@example.test", "Local reader", password);
const { app } = createApp(config, store),
  links = app.locals.accountProfiles;
let pending = true,
  offline = false,
  device: any;
const control = crypto.randomBytes(24).toString("hex");
links.transport = async (_method: string, endpoint: string, data?: any) => {
  if (offline) throw Error("Fictional issuer unavailable");
  if (endpoint === "browser/start") {
    device = data;
    return {
      request_id: "Q".repeat(43),
      authorization_uri:
        "https://nebulacoder.com/oauth/authorize?request=" + "Q".repeat(43),
      expires_in: 600,
    };
  }
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
    if (data.grant_type === "refresh_token")
      return { access_token: "A".repeat(43), refresh_token: "Q".repeat(43) };

    const now = Date.now() / 1000;
    return {
      scope: "profile.read email.read",
      access_token: "A".repeat(43),
      refresh_token: "R".repeat(43),
      authorization: {
        issuer: "https://nebulacoder.com",
        subject: "fixture-viewer",
        client_id: "kagnode-media",
        installation: origin,
        purpose: "sign_in",
        nonce: device.nonce,
        auth_time: now - 20,
        approved_at: now,
        issued_at: now,
        expires_at: now + 120,
      },
    };
  }
  if (endpoint.startsWith("profile?"))
    return {
      issuer: "https://nebulacoder.com",
      subject: "fixture-viewer",
      name: "Fictional KagNode viewer",
      photo: "",
      email: "provider@example.test",
      email_verified: true,
    };
  return {};
};
server.on("request", (q, r) => {
  if (
    q.url?.startsWith("/__fixture/") &&
    q.headers["x-fixture-key"] === control
  ) {
    const action = q.url.slice("/__fixture/".length);
    if (action === "pending") {
      pending = true;
      offline = false;
    }
    if (action === "approved") {
      pending = false;
      offline = false;
    }
    if (action === "offline") offline = true;
    if (action === "disabled")
      store.run(
        "UPDATE account_sync_policy SET enabled=0,generation=generation+1",
      );
    if (action === "enabled")
      store.run(
        "UPDATE account_sync_policy SET enabled=1,generation=generation+1",
      );
    r.setHeader("Content-Type", "application/json");
    r.end(JSON.stringify(action === "request" ? device : { ok: true }));
    return;
  }
  app(q, r);
});
console.log(JSON.stringify({ origin, control, password }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close(() => {
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
      process.exit(0);
    });
  });
