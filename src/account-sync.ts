import { manageUpdate } from "./ecosystem-updates.js";
import crypto from "node:crypto";
import { Store, uid, digest } from "./database.js";
import { MediaError } from "./errors.js";

type Transport = (
  method: string,
  endpoint: string,
  data?: Record<string, unknown>,
  token?: string,
) => Promise<any>;
export class AccountProfiles {
  readonly issuer: string;
  constructor(
    private store: Store,
    private origin: string,
    private transport?: Transport,
  ) {
    this.issuer = (
      process.env.KAGNODE_ACCOUNT_ISSUER || "https://nebulacoder.com"
    ).replace(/\/$/, "");
    const parsed = new URL(this.issuer);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== this.issuer ||
      parsed.username
    )
      throw new Error("Use an HTTPS KagNode Account issuer origin");
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS account_sync_policy(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1);INSERT OR IGNORE INTO account_sync_policy(id) VALUES(1);
   CREATE TABLE IF NOT EXISTS account_profile_links(local_id TEXT PRIMARY KEY,subject TEXT UNIQUE NOT NULL,profile TEXT NOT NULL,refresh TEXT NOT NULL,updated INTEGER NOT NULL,busy INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS account_profile_epochs(local_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS account_profile_issuer(id INTEGER PRIMARY KEY CHECK(id=1),issuer TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS account_profile_revocations(token TEXT PRIMARY KEY,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS account_profile_pending(local_id TEXT PRIMARY KEY,device TEXT NOT NULL,user_code TEXT NOT NULL,verification TEXT NOT NULL,expires INTEGER NOT NULL,polled INTEGER NOT NULL DEFAULT 0,interval INTEGER NOT NULL DEFAULT 5000,generation TEXT NOT NULL);`);
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS account_sign_in(id TEXT PRIMARY KEY,browser TEXT NOT NULL,nonce TEXT NOT NULL,started INTEGER NOT NULL,expires INTEGER NOT NULL,generation INTEGER NOT NULL,status TEXT NOT NULL,device TEXT NOT NULL DEFAULT '',user_code TEXT NOT NULL DEFAULT '',verification TEXT NOT NULL DEFAULT '',polled INTEGER NOT NULL DEFAULT 0,interval INTEGER NOT NULL DEFAULT 5000,profile TEXT NOT NULL DEFAULT '',tokens TEXT NOT NULL DEFAULT '',local_id TEXT NOT NULL DEFAULT '',stamp TEXT NOT NULL DEFAULT '');CREATE INDEX IF NOT EXISTS account_sign_in_browser ON account_sign_in(browser);`,
    );
    const previous = store.one(
      "SELECT issuer FROM account_profile_issuer WHERE id=1",
    );
    if (previous && previous.issuer !== this.issuer) {
      store.transaction(() => {
        store.run("DELETE FROM account_profile_links");
        store.run("DELETE FROM account_profile_pending");
        store.run("DELETE FROM account_profile_revocations");
        store.run(
          "UPDATE account_sync_policy SET enabled=0,generation=generation+1 WHERE id=1",
        );
        store.audit(
          "configuration",
          "account.profile.issuer_changed",
          this.issuer,
        );
      });
    }
    store.run(
      "INSERT OR REPLACE INTO account_profile_issuer VALUES(1,?)",
      this.issuer,
    );
  }
  loginEnabled() {
    return !!this.policy().enabled && !this.configuredOff();
  }
  private loginRow(browser: string, attempt: string) {
    const row = this.store.one(
      "SELECT * FROM account_sign_in WHERE id=? AND browser=?",
      attempt,
      digest(browser),
    );
    if (!this.loginEnabled())
      throw new MediaError("KagNode access is disabled. Sign in locally.", 403);
    if (
      !row ||
      row.expires <= Date.now() ||
      row.generation !== this.policy().generation
    )
      throw new MediaError(
        "The sign-in attempt expired or changed. Start again.",
        410,
      );
    return row;
  }
  private forgetLogin(row: any) {
    if (row.tokens) {
      const refresh = JSON.parse(row.tokens).refresh_token;
      if (refresh)
        this.store.run(
          "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
          refresh,
          Date.now(),
        );
    }
    this.store.run("DELETE FROM account_sign_in WHERE id=?", row.id);
  }
  private loginPublic(row: any) {
    return {
      pending: row.status !== "ready",
      authorized: row.status === "ready",
      attempt_id: row.id,
      user_code: row.user_code,
      verification_uri: row.verification,
      interval: row.interval / 1000,
      expires_in: Math.max(1, Math.ceil((row.expires - Date.now()) / 1000)),
    };
  }
  private async cancelDevice(device: string) {
    if (device)
      try {
        await this.request("POST", "device/cancel", {
          client_id: "kagnode-media",
          device_code: device,
        });
      } catch {
        /* Local invalidation is authoritative. */
      }
  }
  async login(browser: string, action: string, attempt = "") {
    if (!browser || browser.length > 512)
      throw new MediaError("Reload the sign-in page.", 403);
    if (action === "cancel") {
      const row = this.store.one(
        "SELECT * FROM account_sign_in WHERE id=? AND browser=?",
        attempt,
        digest(browser),
      );
      if (row) {
        this.forgetLogin(row);
        await this.cancelDevice(row.device);
        await this.flushRevocations();
      }
      return { pending: false, authorized: false };
    }
    if (!this.loginEnabled())
      throw new MediaError("KagNode access is disabled. Sign in locally.", 403);
    if (action === "start") {
      const id = crypto.randomBytes(32).toString("base64url"),
        nonce = crypto.randomBytes(32).toString("base64url"),
        generation = this.policy().generation;
      const previous = this.store.all(
        "SELECT * FROM account_sign_in WHERE browser=? OR expires<=? OR generation!=?",
        digest(browser),
        Date.now(),
        generation,
      );
      this.store.transaction(() => {
        previous.forEach((row) => this.forgetLogin(row));
        if (
          this.store.one("SELECT COUNT(*) count FROM account_sign_in").count >=
          128
        )
          throw new MediaError("Sign-in is busy. Try again later.", 429);
        this.store.run(
          "INSERT INTO account_sign_in(id,browser,nonce,started,expires,generation,status) VALUES(?,?,?,?,?,?,'starting')",
          id,
          digest(browser),
          nonce,
          Date.now(),
          Date.now() + 600000,
          generation,
        );
      });
      for (const old of previous) await this.cancelDevice(old.device);
      let value: any;
      try {
        value = await this.request("POST", "device", {
          client_id: "kagnode-media",
          installation: this.origin,
          purpose: "sign_in",
          scope: "profile.read email.read",
          nonce,
        });
        if (
          value.error ||
          !/^[A-Za-z0-9_-]{40,200}$/.test(value.device_code || "") ||
          !/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(value.user_code || "") ||
          typeof value.verification_uri_complete !== "string" ||
          !value.verification_uri_complete.startsWith(
            this.issuer + "/account/apps/device?code=",
          )
        )
          throw new MediaError("KagNode could not start sign-in.", 502);
        this.loginRow(browser, id);
        const changed = this.store.run(
          "UPDATE account_sign_in SET status='pending',device=?,user_code=?,verification=? WHERE id=? AND status='starting'",
          value.device_code,
          value.user_code,
          value.verification_uri_complete,
          id,
        ).changes;
        if (!changed)
          throw new MediaError("Sign-in changed. Start again.", 409);
        return this.loginPublic(this.loginRow(browser, id));
      } catch (error) {
        this.store.run("DELETE FROM account_sign_in WHERE id=?", id);
        await this.cancelDevice(value?.device_code || "");
        throw error;
      }
    }
    if (action !== "status") throw new MediaError("Invalid sign-in action.");
    const row = this.loginRow(browser, attempt);
    if (row.status === "ready" || row.status === "polling")
      return this.loginPublic(row);
    if (row.status !== "pending")
      throw new MediaError("Sign-in is still starting.", 409);
    const changed = this.store.run(
      "UPDATE account_sign_in SET status='polling',polled=? WHERE id=? AND status='pending' AND polled<=?",
      Date.now(),
      attempt,
      Date.now() - row.interval,
    ).changes;
    if (!changed) return this.loginPublic(this.loginRow(browser, attempt));
    let value: any;
    try {
      value = await this.request("POST", "token", {
        client_id: "kagnode-media",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: row.device,
      });
      if (["authorization_pending", "slow_down"].includes(value.error)) {
        this.store.run(
          "UPDATE account_sign_in SET status='pending',interval=? WHERE id=? AND status='polling'",
          Math.min(
            30000,
            row.interval + (value.error === "slow_down" ? 5000 : 0),
          ),
          attempt,
        );
        return this.loginPublic(this.loginRow(browser, attempt));
      }
      const proof = value.authorization,
        now = Date.now() / 1000;
      if (
        value.error ||
        !proof ||
        proof.issuer !== this.issuer ||
        proof.client_id !== "kagnode-media" ||
        proof.installation !== this.origin ||
        proof.purpose !== "sign_in" ||
        proof.nonce !== row.nonce ||
        ![
          proof.auth_time,
          proof.approved_at,
          proof.issued_at,
          proof.expires_at,
        ].every((v) => typeof v === "number" && Number.isFinite(v)) ||
        !(
          proof.auth_time > 0 &&
          proof.auth_time <= proof.approved_at + 30 &&
          proof.approved_at >= row.started / 1000 - 30 &&
          proof.approved_at <= proof.issued_at &&
          proof.issued_at <= now + 30 &&
          proof.expires_at > now &&
          proof.expires_at <= proof.issued_at + 120
        ) ||
        !/^[A-Za-z0-9_-]{40,200}$/.test(value.access_token || "") ||
        !/^[A-Za-z0-9_-]{40,200}$/.test(value.refresh_token || "") ||
        !String(value.scope || "")
          .split(" ")
          .includes("profile.read")
      )
        throw new MediaError(
          "KagNode did not return a matching fresh authorization. Start again.",
          502,
        );
      const profile = this.validate(
        await this.request(
          "GET",
          "profile?client_id=kagnode-media",
          undefined,
          value.access_token,
        ),
      );
      if (
        !String(value.scope || "")
          .split(" ")
          .includes("email.read")
      ) {
        profile.email = "";
        profile.email_verified = false;
      }
      if (profile.subject !== proof.subject)
        throw new MediaError(
          "KagNode identity did not match its authorization.",
          502,
        );
      this.loginRow(browser, attempt);
      const linked = this.store.one(
        "SELECT local_id FROM account_profile_links WHERE subject=?",
        profile.subject,
      );
      const changed = this.store.run(
        "UPDATE account_sign_in SET status='ready',profile=?,tokens=?,expires=?,local_id=?,stamp=? WHERE id=? AND status='polling'",
        JSON.stringify(profile),
        JSON.stringify({ refresh_token: value.refresh_token }),
        Math.min(row.expires, proof.expires_at * 1000),
        linked?.local_id || "",
        linked ? this.stamp(linked.local_id) : "",
        attempt,
      ).changes;
      if (!changed) throw new MediaError("Sign-in changed. Start again.", 409);
      return this.loginPublic(this.loginRow(browser, attempt));
    } catch (error) {
      this.store.run("DELETE FROM account_sign_in WHERE id=?", attempt);
      if (/^[A-Za-z0-9_-]{40,200}$/.test(value?.refresh_token || ""))
        this.store.run(
          "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
          value.refresh_token,
          Date.now(),
        );
      await this.flushRevocations();
      await this.cancelDevice(row.device);
      throw error;
    }
  }
  finishLogin(browser: string, attempt: string) {
    return this.store.transaction(() => {
      const row = this.loginRow(browser, attempt);
      if (row.status !== "ready")
        throw new MediaError("Confirm your KagNode identity first.", 409);
      const profile = JSON.parse(row.profile),
        tokens = JSON.parse(row.tokens);
      let user = row.local_id ? this.store.user(row.local_id) : null;
      if (row.local_id) {
        if (!user || this.stamp(row.local_id) !== row.stamp)
          throw new MediaError(
            "The local account or its connection changed. Sign in locally.",
            403,
          );
        const current = this.store.one(
          "SELECT subject FROM account_profile_links WHERE local_id=?",
          row.local_id,
        );
        if (current?.subject !== profile.subject)
          throw new MediaError("The account connection changed.", 409);
      } else {
        if (!this.store.policy().registration)
          throw new MediaError(
            "Registration is closed. Link an existing account from its settings.",
            403,
          );
        if (!profile.email_verified || !profile.email)
          throw new MediaError(
            "Verify your KagNode email before creating a Media account.",
            409,
          );
        const email = profile.email.toLowerCase();
        if (
          this.store.one("SELECT id FROM users WHERE email=?", email) ||
          this.store.one(
            "SELECT local_id FROM account_profile_links WHERE subject=?",
            profile.subject,
          )
        )
          throw new MediaError(
            "An account already exists. Sign in locally and explicitly link it in Account settings.",
            409,
          );
        const id = uid();
        this.store.run(
          "INSERT INTO users VALUES(?,?,?,?,?,1,?,?,?,?)",
          id,
          email,
          profile.name,
          "kagnode-provider",
          "viewer",
          "none",
          0,
          this.store.policy().creatorQuota,
          Date.now(),
        );
        this.store.audit(id, "account.create.kagnode", id);
        user = this.store.user(id);
      }
      const old = this.store.one(
        "SELECT refresh FROM account_profile_links WHERE local_id=?",
        user.id,
      );
      if (old?.refresh && old.refresh !== tokens.refresh_token)
        this.store.run(
          "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
          old.refresh,
          Date.now(),
        );
      this.store.run(
        "INSERT OR REPLACE INTO account_profile_links VALUES(?,?,?,?,?,0)",
        user.id,
        profile.subject,
        JSON.stringify(profile),
        tokens.refresh_token,
        Date.now(),
      );
      this.store.run("DELETE FROM account_sign_in WHERE id=?", attempt);
      this.store.audit(user.id, "account.sign_in.kagnode", user.id);
      return user;
    });
  }

  private stamp(uid: string) {
    const policy = this.policy(),
      row = this.store.one(
        "SELECT epoch FROM account_profile_epochs WHERE local_id=?",
        uid,
      );
    return String(policy.generation) + ":" + String(row?.epoch || 0);
  }
  private bump(uid: string) {
    this.store.run(
      "INSERT INTO account_profile_epochs VALUES(?,1) ON CONFLICT(local_id) DO UPDATE SET epoch=epoch+1",
      uid,
    );
    return this.stamp(uid);
  }
  private configuredOff() {
    const stored = this.store.one(
      "SELECT issuer FROM account_profile_issuer WHERE id=1",
    );
    return (
      ["off", "false", "0"].includes(
        (process.env.KAGNODE_ACCOUNT_SYNC || "on").toLowerCase(),
      ) || !!(stored && stored.issuer !== this.issuer)
    );
  }
  private policy() {
    return this.store.one("SELECT * FROM account_sync_policy WHERE id=1");
  }
  private async request(
    method: string,
    endpoint: string,
    data?: Record<string, unknown>,
    token?: string,
  ): Promise<any> {
    if (this.transport) return this.transport(method, endpoint, data, token);
    try {
      const response = await fetch(
        this.issuer + "/api/v1/account-sync/" + endpoint,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: "application/json",
            ...(data ? { "Content-Type": "application/json" } : {}),
            ...(token ? { Authorization: "Bearer " + token } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        },
      );
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) throw Error("Empty response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > 262144) {
          await reader.cancel();
          throw Error("Response too large");
        }
        chunks.push(item.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (!response.ok && !value.error)
      )
        throw Error("Invalid response");
      return value;
    } catch {
      throw new MediaError(
        "KagNode Account could not be reached. Your local account is available.",
        502,
      );
    }
  }
  private validate(profile: any) {
    if (
      profile?.issuer !== this.issuer ||
      typeof profile.subject !== "string" ||
      !profile.subject ||
      profile.subject.length > 200 ||
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      profile.name.length > 100 ||
      /[\x00-\x1f]/.test(profile.name) ||
      typeof profile.photo !== "string" ||
      profile.photo.length > 180000 ||
      (profile.photo &&
        !/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(profile.photo))
    )
      throw new MediaError("The KagNode profile could not be verified.", 502);
    const email = profile.email_verified === true ? profile.email : "";
    if (
      typeof email !== "string" ||
      email.length > 254 ||
      /[\x00-\x1f\x7f]/.test(email) ||
      (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    )
      throw new MediaError("Invalid verified KagNode email.", 502);
    return {
      email,
      email_verified: !!email,
      issuer: this.issuer,
      subject: profile.subject,
      name: profile.name,
      photo: profile.photo,
    };
  }
  private async revoke(token: string) {
    if (!token) return true;
    try {
      await this.request("POST", "revoke", {
        client_id: "kagnode-media",
        token,
      });
      return true;
    } catch {
      return false;
    }
  }
  private async flushRevocations(limit = 1) {
    for (const row of this.store.all(
      "SELECT token FROM account_profile_revocations ORDER BY created LIMIT ?",
      limit,
    )) {
      if (await this.revoke(row.token))
        this.store.run(
          "DELETE FROM account_profile_revocations WHERE token=?",
          row.token,
        );
    }
  }
  private async save(uid: string, result: any, expectedStamp: string) {
    if (
      !/^[A-Za-z0-9_-]{40,200}$/.test(result?.access_token || "") ||
      !/^[A-Za-z0-9_-]{40,200}$/.test(result?.refresh_token || "")
    )
      throw new MediaError("Invalid KagNode account token response.", 502);
    try {
      const profile = this.validate(
        await this.request(
          "GET",
          "profile?client_id=kagnode-media",
          undefined,
          result.access_token,
        ),
      );
      this.store.transaction(() => {
        const policy = this.policy();
        if (
          !policy.enabled ||
          this.configuredOff() ||
          this.stamp(uid) !== expectedStamp
        )
          throw new MediaError(
            "Account sync settings changed. Try again.",
            409,
          );
        const other = this.store.one(
            "SELECT local_id FROM account_profile_links WHERE subject=? AND local_id!=?",
            profile.subject,
            uid,
          ),
          own = this.store.one(
            "SELECT subject FROM account_profile_links WHERE local_id=?",
            uid,
          );
        if (other || (own && own.subject !== profile.subject))
          throw new MediaError(
            "Disconnect the previous account link before linking a different account.",
            409,
          );
        this.store.run(
          "INSERT OR REPLACE INTO account_profile_links VALUES(?,?,?,?,?,0)",
          uid,
          profile.subject,
          JSON.stringify(profile),
          result.refresh_token,
          Date.now(),
        );
        this.store.audit(uid, "account.profile.sync", profile.subject);
      });
    } catch (error) {
      this.store.run(
        "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
        result.refresh_token,
        Date.now(),
      );
      await this.flushRevocations(1);
      throw error;
    }
  }
  private async refresh(uid: string, force = false) {
    const expectedStamp = this.stamp(uid);
    const policy = this.policy();
    if (!policy.enabled || this.configuredOff()) return;
    const row = this.store.transaction(() => {
      const row = this.store.one(
        "SELECT * FROM account_profile_links WHERE local_id=?",
        uid,
      );
      if (
        !row?.refresh ||
        row.busy > Date.now() ||
        (!force && Date.now() - row.updated <= 900000)
      )
        return null;
      this.store.run(
        "UPDATE account_profile_links SET busy=? WHERE local_id=?",
        Date.now() + 25000,
        uid,
      );
      return row;
    });
    if (!row) return;
    try {
      const result = await this.request("POST", "token", {
        client_id: "kagnode-media",
        grant_type: "refresh_token",
        refresh_token: row.refresh,
      });
      if (result.error) {
        this.store.run(
          "UPDATE account_profile_links SET refresh='' WHERE local_id=? AND refresh=?",
          uid,
          row.refresh,
        );
        throw new MediaError(
          "Reconnect your KagNode Account to resume profile sync.",
          401,
        );
      }
      await this.save(uid, result, expectedStamp);
    } finally {
      this.store.run(
        "UPDATE account_profile_links SET busy=0 WHERE local_id=?",
        uid,
      );
    }
  }
  async state(uid: string, name: string, admin: boolean, refresh = true) {
    const enabled = !!this.policy().enabled && !this.configuredOff();
    let warning = "";
    if (enabled && refresh)
      try {
        await this.refresh(uid);
      } catch (error) {
        warning =
          error instanceof Error ? error.message : "Profile sync unavailable";
      }
    const row = this.store.one(
      "SELECT * FROM account_profile_links WHERE local_id=?",
      uid,
    );
    const connected = !!(enabled && row?.refresh);
    const pending =
      enabled && !connected
        ? this.store.one(
            "SELECT user_code,verification,expires,interval,generation FROM account_profile_pending WHERE local_id=? AND expires>? AND generation=?",
            uid,
            Date.now(),
            this.stamp(uid),
          )
        : null;
    return {
      pending: !!pending,
      ...(pending
        ? {
            user_code: pending.user_code,
            verification_uri: pending.verification,
            expires_in: Math.max(
              1,
              Math.ceil((pending.expires - Date.now()) / 1000),
            ),
            interval: pending.interval / 1000,
            attempt_id: pending.generation,
          }
        : {}),
      revocations_pending: admin
        ? this.store.one(
            "SELECT COUNT(*) count FROM account_profile_revocations",
          ).count
        : 0,
      enabled,
      admin,
      connected,
      profile: enabled && row ? JSON.parse(row.profile) : null,
      local_name: name,
      warning,
      configured_off: this.configuredOff(),
    };
  }
  async handle(
    uid: string,
    name: string,
    admin: boolean,
    action = "state",
    data: any = {},
  ) {
    if (action === "cancel") {
      this.store.transaction(() => {
        const pending = this.store.one(
          "SELECT generation FROM account_profile_pending WHERE local_id=?",
          uid,
        );
        if (
          !pending ||
          pending.generation !== data.attempt_id ||
          pending.generation !== this.stamp(uid)
        )
          throw new MediaError(
            "The account-link attempt changed. Reload its status.",
            409,
          );
        this.bump(uid);
        this.store.run(
          "DELETE FROM account_profile_pending WHERE local_id=?",
          uid,
        );
        this.store.audit(uid, "account.profile.cancel", uid);
      });
      return this.state(uid, name, admin, false);
    }
    if (action.startsWith("updates.")) {
      if (!admin)
        throw new MediaError("Local administrator access is required.", 403);
      return manageUpdate(action.slice(8), data);
    }
    if (action === "retry_disconnections") {
      if (!admin)
        throw new MediaError("Local administrator access is required.", 403);
      await this.flushRevocations(2);
      return this.state(uid, name, admin, false);
    }
    if (action === "policy") {
      if (!admin)
        throw new MediaError("Local administrator access is required.", 403);
      if (typeof data.enabled !== "boolean")
        throw new MediaError("Choose whether account sync is enabled.");
      if (data.enabled && this.configuredOff())
        throw new MediaError(
          "Account sync is disabled in this installation’s configuration.",
          403,
        );
      const tokens = this.store.transaction(() => {
        const rows = data.enabled
          ? []
          : this.store.all("SELECT refresh FROM account_profile_links");
        this.store.run(
          "UPDATE account_sync_policy SET enabled=?,generation=generation+1 WHERE id=1",
          data.enabled ? 1 : 0,
        );
        this.store.run("DELETE FROM account_profile_pending");
        for (const attempt of this.store.all("SELECT * FROM account_sign_in"))
          this.forgetLogin(attempt);
        if (!data.enabled) {
          for (const row of rows)
            this.store.run(
              "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
              row.refresh,
              Date.now(),
            );
          this.store.run("DELETE FROM account_profile_links");
        }
        this.store.audit(uid, "account.profile.policy", String(data.enabled));
        return rows;
      });
      if (tokens.length) await this.flushRevocations();
      return this.state(uid, name, admin, false);
    }
    if (action === "disconnect") {
      this.bump(uid);
      const row = this.store.one(
        "SELECT refresh FROM account_profile_links WHERE local_id=?",
        uid,
      );
      this.store.run("DELETE FROM account_profile_links WHERE local_id=?", uid);
      this.store.run(
        "DELETE FROM account_profile_pending WHERE local_id=?",
        uid,
      );
      this.store.audit(uid, "account.profile.disconnect", uid);
      if (row) {
        this.store.run(
          "INSERT OR IGNORE INTO account_profile_revocations VALUES(?,?)",
          row.refresh,
          Date.now(),
        );
        await this.flushRevocations();
      }
      return this.state(uid, name, admin, false);
    }
    if (action === "state") return this.state(uid, name, admin);
    const policy = this.policy();
    if (!policy.enabled || this.configuredOff())
      throw new MediaError(
        "KagNode Account sync is disabled for this installation.",
        403,
      );
    if (action === "start") {
      const expectedStamp = this.bump(uid);
      const result = await this.request("POST", "device", {
        client_id: "kagnode-media",
        installation: this.origin,
        scope: "profile.read email.read",
      });
      if (
        result.error ||
        !/^[A-Za-z0-9_-]{40,200}$/.test(result.device_code || "") ||
        !/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(result.user_code || "") ||
        !String(result.verification_uri_complete || "").startsWith(
          this.issuer + "/account/apps/device?code=",
        )
      )
        throw new MediaError(
          "The KagNode account connection response is invalid.",
          502,
        );
      this.store.transaction(() => {
        const current = this.policy();
        if (
          !current.enabled ||
          this.stamp(uid) !== expectedStamp ||
          this.configuredOff()
        )
          throw new MediaError(
            "Account sync settings changed. Try again.",
            409,
          );
        this.store.run(
          "INSERT OR REPLACE INTO account_profile_pending VALUES(?,?,?,?,?,0,5000,?)",
          uid,
          result.device_code,
          result.user_code,
          result.verification_uri_complete,
          Date.now() + 600000,
          expectedStamp,
        );
      });
      return this.state(uid, name, admin, false);
    }
    if (action === "poll") {
      const row = this.store.transaction(() => {
        const row = this.store.one(
          "SELECT * FROM account_profile_pending WHERE local_id=?",
          uid,
        );
        if (
          !row ||
          row.expires < Date.now() ||
          String(row.generation) !== this.stamp(uid)
        )
          throw new MediaError(
            "The account-link code expired. Start again.",
            410,
          );
        if (Date.now() - row.polled < row.interval)
          return { ...row, wait: true };
        this.store.run(
          "UPDATE account_profile_pending SET polled=? WHERE local_id=?",
          Date.now(),
          uid,
        );
        return row;
      });
      if (row.wait) return { pending: true, interval: row.interval / 1000 };
      const result = await this.request("POST", "token", {
        client_id: "kagnode-media",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: row.device,
      });
      if (["authorization_pending", "slow_down"].includes(result.error)) {
        const interval =
          row.interval + (result.error === "slow_down" ? 5000 : 0);
        this.store.run(
          "UPDATE account_profile_pending SET interval=? WHERE local_id=? AND generation=?",
          interval,
          uid,
          row.generation,
        );
        return { pending: true, interval: interval / 1000 };
      }
      if (result.error)
        throw new MediaError(
          "The account link was denied or expired. Start again.",
          410,
        );
      await this.save(uid, result, String(row.generation));
      this.store.run(
        "DELETE FROM account_profile_pending WHERE local_id=? AND generation=?",
        uid,
        row.generation,
      );
      return this.state(uid, name, admin, false);
    }
    if (action === "refresh") {
      await this.refresh(uid, true);
      return this.state(uid, name, admin, false);
    }
    throw new MediaError("Unknown account-link action.");
  }
}
