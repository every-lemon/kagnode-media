import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RequestHandler, Response, Request } from "express";
import { Store, uid, digest } from "./database.js";
import { MediaError } from "./errors.js";
import type { User } from "./types.js";
const scrypt = (
  password: string,
  salt: string,
  length: number,
  options: crypto.ScryptOptions,
) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
const cookieName = "kagnode.media.sid";
declare global {
  namespace Express {
    interface Request {
      mediaUser?: User;
      mediaSession?: any;
    }
  }
}
export async function passwordHash(password: string) {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) < 12 ||
    Buffer.byteLength(password) > 256
  )
    throw new MediaError("Use a password between 12 and 256 bytes.");
  const salt = crypto.randomBytes(16).toString("hex");
  const value = (await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 ** 2,
  })) as Buffer;
  return "scrypt$" + salt + "$" + value.toString("hex");
}
export async function verifyPassword(password: string, encoded: string) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 256)
    return false;
  const parts = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  const salt = parts?.[1] || "0".repeat(32),
    expected = Buffer.from(parts?.[2] || "0".repeat(128), "hex");
  const actual = (await scrypt(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 ** 2,
  })) as Buffer;
  return !!parts && crypto.timingSafeEqual(actual, expected);
}
export function emailAddress(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^([^\s@<>]+)@([^\s@<>]+\.[^\s@<>]+)$/.test(value.trim()) ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new MediaError("Enter an email address.");
  return value.trim().toLowerCase();
}
export async function createUser(
  store: Store,
  email: string,
  name: string,
  password: string,
  role: "viewer" | "admin" = "viewer",
) {
  const address = emailAddress(email);
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new MediaError("Enter a name under 100 characters.");
  const hash = await passwordHash(password),
    id = uid();
  return store.transaction(() => {
    if (store.one("SELECT id FROM users WHERE email=?", address))
      throw new MediaError("This account could not be created.");
    store.run(
      "INSERT INTO users VALUES(?,?,?,?,?,1,?,?,?,?)",
      id,
      address,
      name.trim(),
      hash,
      role,
      role === "admin" ? "approved" : "none",
      role === "admin" ? 1 : 0,
      store.policy().creatorQuota,
      Date.now(),
    );
    store.audit(id, "account.create", id);
    return store.user(id) as User;
  });
}
export function cookie(req: Request, name: string) {
  const pair = String(req.headers.cookie || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="));
  return pair ? pair.slice(name.length + 1) : "";
}
export function signIn(store: Store, res: Response, user: User) {
  const token = crypto.randomBytes(32).toString("base64url"),
    csrf = crypto.randomBytes(24).toString("base64url");
  store.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(token),
    user.id,
    csrf,
    Date.now() + 86400000,
  );
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: store.config.secure,
    sameSite: "lax",
    maxAge: 86400000,
    path: "/",
  });
}
export function signOut(store: Store, req: Request, res: Response) {
  store.run(
    "DELETE FROM sessions WHERE token=?",
    digest(cookie(req, cookieName)),
  );
  res.clearCookie(cookieName, {
    path: "/",
    httpOnly: true,
    secure: store.config.secure,
    sameSite: "lax",
  });
}
export function identity(store: Store): RequestHandler {
  const file = path.join(store.config.data, "form-secret");
  try {
    fs.writeFileSync(file, crypto.randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const secret = fs.readFileSync(file);
  const signature = (nonce: string) =>
    crypto.createHmac("sha256", secret).update(nonce).digest("hex");
  return (req, res, next) => {
    const token = cookie(req, cookieName),
      session =
        token &&
        store.one(
          "SELECT * FROM sessions WHERE token=? AND expires>?",
          digest(token),
          Date.now(),
        ),
      user = session && store.user(session.user_id);
    if (user) {
      req.mediaUser = user;
      req.mediaSession = session;
      res.locals.csrf = session.csrf;
    } else {
      let token = cookie(req, "kagnode.media.form"),
        match = /^([a-f0-9]{32}\.\d{13})\.([a-f0-9]{64})$/.exec(token);
      if (
        !match ||
        Number(match[1].split(".")[1]) < Date.now() ||
        !crypto.timingSafeEqual(
          Buffer.from(match[2], "hex"),
          Buffer.from(signature(match[1]), "hex"),
        )
      ) {
        const nonce =
          crypto.randomBytes(16).toString("hex") +
          "." +
          (Date.now() + 14400000);
        token = nonce + "." + signature(nonce);
        res.cookie("kagnode.media.form", token, {
          httpOnly: true,
          sameSite: "lax",
          secure: store.config.secure,
          maxAge: 14400000,
          path: "/",
        });
      }
      res.locals.csrf = token;
    }
    res.locals.user = user || null;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("Origin");
      if (
        (origin && origin !== store.config.origin) ||
        req.get("Sec-Fetch-Site") === "cross-site"
      )
        return next(new MediaError("Use a same-origin request.", 403));
      const actual = req.get("X-CSRF-Token") || req.body?._csrf,
        expected = res.locals.csrf;
      if (
        typeof actual !== "string" ||
        Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
      )
        return next(new MediaError("Refresh this form and try again.", 403));
    }
    next();
  };
}
export function requireUser(req: Request) {
  if (!req.mediaUser) throw new MediaError("Sign in to continue.", 401);
  return req.mediaUser;
}
export function creator(store: Store, user: User | undefined) {
  const current = user && store.user(user.id);
  if (
    !current ||
    (current.role !== "admin" &&
      (current.role !== "creator" || current.creator_status !== "approved"))
  )
    throw new MediaError("Approved creator access is required.", 403);
  return current as User;
}
export function administrator(store: Store, user: User | undefined) {
  const current = user && store.user(user.id);
  if (!current || current.role !== "admin")
    throw new MediaError("Administrator access is required.", 403);
  return current as User;
}
