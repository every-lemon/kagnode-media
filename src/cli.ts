import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { configuration } from "./config.js";
import { Store } from "./database.js";
import { createUser, passwordHash, emailAddress } from "./auth.js";
import { cleanupCache } from "./worker.js";
const [command, ...args] = process.argv.slice(2);
if (!["admin-create", "password-reset", "cache", "status"].includes(command)) {
  console.log(
    "KagNode Media\n\nadmin-create EMAIL NAME --password-stdin\npassword-reset EMAIL --password-stdin\ncache [--apply]\nstatus\n\nPasswords are read from stdin, never command arguments.",
  );
  process.exit(command ? 1 : 0);
}
const store = new Store(configuration());
async function password() {
  if (!args.includes("--password-stdin"))
    throw Error(
      "Use --password-stdin and pipe the secret privately. Do not put passwords in command arguments.",
    );
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
    if (raw.length > 512) throw Error("Password input too long.");
  }
  return raw.replace(/\r?\n$/, "");
}
try {
  if (command === "admin-create") {
    const email = args[0],
      name = args[1];
    if (!email || !name) throw Error("Provide administrator email and name.");
    const user = await createUser(
      store,
      email,
      name,
      await password(),
      "admin",
    );
    console.log("Administrator created:", user.email);
  } else if (command === "password-reset") {
    const email = emailAddress(args[0]),
      user = store.one("SELECT id FROM users WHERE email=?", email);
    if (!user) throw Error("Account not found.");
    const hash = await passwordHash(await password());
    store.transaction(() => {
      store.run("UPDATE users SET password=? WHERE id=?", hash, user.id);
      store.run("DELETE FROM sessions WHERE user_id=?", user.id);
      store.audit(null, "account.recover", user.id);
    });
    console.log("Password reset; existing sessions revoked.");
  } else if (command === "cache") {
    const files = cleanupCache(store, args.includes("--apply"));
    console.log(
      args.includes("--apply")
        ? "Removed stale processing directories:"
        : "Dry run; stale processing directories:",
      files.length,
    );
  } else
    console.log(
      JSON.stringify(
        {
          service: "KagNode Media",
          accounts: store.one("SELECT COUNT(*) n FROM users").n,
          items: store.one("SELECT COUNT(*) n FROM media WHERE removed=0").n,
          jobs: store.all(
            "SELECT state,COUNT(*) count FROM jobs GROUP BY state",
          ),
          nativeProcessing: "Not exercised by this command.",
        },
        null,
        2,
      ),
    );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
