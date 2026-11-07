import { installCore, managerRequest } from "../vendor/kagnode-core.mjs";
import { AccountProfiles } from "./account-sync.js";
import { icon } from "./icons.js";
import express from "express";
import type { Request, Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Store, uid } from "./database.js";
import { MediaError } from "./errors.js";
import {
  identity,
  createUser,
  emailAddress,
  verifyPassword,
  requireUser,
  signIn,
  signOut,
  creator,
  administrator,
  passwordHash,
} from "./auth.js";
import {
  catalog,
  publicMedia,
  visibleVersion,
  ownedMedia,
  metadata,
  updateMetadata,
  publishMedia,
  rejectMedia,
  removeMedia,
  safeFile,
} from "./media.js";
import {
  createUpload,
  appendChunk,
  completeUpload,
  uploadFor,
  cancelUpload,
  libraryFiles,
  importLibrary,
} from "./uploads.js";
import { original, derived, sendFile } from "./streaming.js";
import { reviewCreator, savePolicy } from "./policy.js";
import { retryJob, cleanupCache, cancelJob } from "./worker.js";
const root = path.resolve(import.meta.dirname, "..");
export function createApp(config: Config, store = new Store(config)) {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(root, "views"));
  app.use(
    helmet({
      referrerPolicy: { policy: "same-origin" },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          workerSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.secure ? [] : null,
        },
      },
      strictTransportSecurity: config.secure ? undefined : false,
    }),
  );
  installCore(app, {
    appId: "media",
    context: (q) => ({
      authenticated: !!q.mediaUser,
      subject: q.mediaUser?.id || "",
    }),
  });
  app.get("/healthz", (_q, r) => {
    store.one("SELECT 1");
    r.json({ ok: true, service: "kagnode-media", version: "0.1.0-preview.1" });
  });
  app.use((q, r, next) => {
    if (q.get("Host") !== new URL(config.origin).host) return r.sendStatus(421);
    if (/\.(?:map|ts|sqlite3?)$/i.test(q.path)) return r.sendStatus(404);
    r.set("Cache-Control", "no-store");
    next();
  });
  const manifestFile = path.join(root, "dist/assets.json"),
    assets = fs.existsSync(manifestFile)
      ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
      : {};
  app.get("/static/:name", (q, r) => {
    const name = String(q.params.name);
    if (!/^[a-z0-9_.-]+\.(css|js|svg)$/.test(name)) return r.sendStatus(404);
    const built =
      assets[name] || Object.values(assets).find((x: any) => x === name);
    if (built) {
      r.set("Cache-Control", "public, max-age=31536000, immutable");
      return r.sendFile(String(built), {
        root: path.join(root, "dist/assets"),
      });
    }
    if (!config.testing && !["favicon.svg"].includes(name))
      return r.sendStatus(404);
    r.sendFile(name, { root: path.join(root, "public"), dotfiles: "deny" });
  });
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "512kb" }));
  app.use(identity(store));
  const authLimit = rateLimit({
      windowMs: 60000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    writes = rateLimit({
      windowMs: 60000,
      limit: 240,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    });
  app.use((q, r, next) =>
    ["GET", "HEAD"].includes(q.method) ? next() : writes(q, r, next),
  );
  const accountProfiles = new AccountProfiles(store, config.origin);
  app
    .route("/api/v1/kagnode-account")
    .get(async (q, r) => {
      const user = requireUser(q);
      r.set("Cache-Control", "no-store").json(
        await accountProfiles.state(user.id, user.name, user.role === "admin"),
      );
    })
    .post(async (q, r) => {
      const user = requireUser(q);
      r.set("Cache-Control", "no-store").json(
        await accountProfiles.handle(
          user.id,
          user.name,
          user.role === "admin",
          String(q.body.action || "state"),
          q.body,
        ),
      );
    });
  app.all("/api/v1/kagnode-core/:action", async (q, r) => {
    const user = requireUser(q);
    if (user.role !== "admin")
      return r
        .status(403)
        .json({ error: "Local administrator access is required." });
    if (
      !["GET", "POST"].includes(q.method) ||
      (q.method === "GET" && q.params.action !== "status")
    )
      return r.sendStatus(405);
    try {
      r.json(
        await managerRequest(
          "media",
          String(q.params.action),
          q.method === "POST" ? q.body : {},
        ),
      );
    } catch (error) {
      r.status(400).json({
        error: error instanceof Error ? error.message : "Core request failed.",
      });
    }
  });
  const asset = (name: string) => "/static/" + (assets[name] || name);
  const render = (
    q: Request,
    r: Response,
    page: string,
    title: string,
    data: any = {},
  ) =>
    r.render("layout", {
      page,
      title,
      user: q.mediaUser || null,
      csrf: r.locals.csrf || "",
      path: q.path,
      asset,
      icon,
      policy: store.policy(),
      config: { origin: config.origin },
      items: [],
      entry: null,
      collection: null,
      collections: [],
      query: q.query.q || "",
      error: "",
      notice: "",
      data: null,
      jobRows: [],
      users: [],
      reviewRows: [],
      reports: [],
      uploads: [],
      ...data,
    });
  const api =
    (handler: (q: Request, r: Response) => any) =>
    (q: Request, r: Response, next: any) =>
      Promise.resolve()
        .then(() => handler(q, r))
        .catch(next);
  const mediaVersion = (q: Request) =>
    String(q.query.version || "") || undefined;
  const ownerJobs = (q: Request) => {
    const user = creator(store, q.mediaUser);
    return store.all(
      "SELECT j.id,j.version_id,j.state,j.progress,j.error,j.updated,v.media_id,json_extract(v.metadata,'$.title') title FROM jobs j JOIN versions v ON v.id=j.version_id JOIN media m ON m.id=v.media_id WHERE m.owner=? OR ?='admin' ORDER BY j.created DESC LIMIT 100",
      user.id,
      user.role,
    );
  };
  const jobOwned = (q: Request) => {
    const user = creator(store, q.mediaUser),
      job = store.one(
        "SELECT j.*,v.media_id FROM jobs j JOIN versions v ON v.id=j.version_id WHERE j.id=?",
        String(q.params.id),
      );
    if (!job) throw new MediaError("Job not found.", 404);
    ownedMedia(store, user, job.media_id);
    return job;
  };
  app.get("/login", (q, r) =>
    q.mediaUser
      ? r.redirect("/")
      : render(q, r, "auth", "Sign in", { mode: "login" }),
  );
  app.get("/signup", (q, r) =>
    q.mediaUser
      ? r.redirect("/")
      : render(q, r, "auth", "Create your account", { mode: "signup" }),
  );
  app.post(
    "/signup",
    authLimit,
    api(async (q, r) => {
      if (!store.policy().registration)
        throw new MediaError("Registration is closed.", 403);
      const user = await createUser(
        store,
        q.body.email,
        q.body.name,
        q.body.password,
      );
      signIn(store, r, user);
      r.redirect(303, "/account");
    }),
  );
  app.post(
    "/login",
    authLimit,
    api(async (q, r) => {
      const email = emailAddress(q.body.email),
        user = store.one("SELECT * FROM users WHERE email=?", email);
      const valid = await verifyPassword(q.body.password, user?.password || "");
      if (!valid || !user.active)
        throw new MediaError("Email or password was not accepted.", 401);
      signIn(store, r, user);
      r.redirect(303, "/");
    }),
  );
  app.post("/logout", (q, r) => {
    signOut(store, q, r);
    r.redirect(303, "/login");
  });
  app.get("/account", (q, r) =>
    render(q, r, "account", "Your account", { data: requireUser(q) }),
  );
  app.post(
    "/account/password",
    authLimit,
    api(async (q, r) => {
      const user = requireUser(q);
      if (!(await verifyPassword(q.body.current, user.password)))
        throw new MediaError("Current password was not accepted.", 403);
      const hash = await passwordHash(q.body.password);
      store.transaction(() => {
        const current = store.user(user.id);
        if (current.password !== user.password)
          throw new MediaError("Account changed. Sign in again.", 409);
        store.run("UPDATE users SET password=? WHERE id=?", hash, user.id);
        store.run("DELETE FROM sessions WHERE user_id=?", user.id);
        store.audit(user.id, "account.password", user.id);
      });
      signIn(store, r, user);
      r.redirect(303, "/account");
    }),
  );
  app.post("/creator/apply", (q, r) => {
    const user = requireUser(q);
    if (user.role === "admin" || user.creator_status === "approved")
      return r.redirect(303, "/creator");
    store.run("UPDATE users SET creator_status='pending' WHERE id=?", user.id);
    store.audit(user.id, "creator.apply", user.id);
    r.redirect(303, "/account");
  });
  app.get(
    ["/", "/browse", "/movies", "/series", "/music", "/photos"],
    (q, r) => {
      const filter =
        q.path === "/movies"
          ? { category: "movie" }
          : q.path === "/series"
            ? { category: "series" }
            : q.path === "/music"
              ? { kind: "audio" }
              : q.path === "/photos"
                ? { kind: "image" }
                : {};
      render(
        q,
        r,
        "browse",
        q.path === "/movies"
          ? "Movies"
          : q.path === "/series"
            ? "Series"
            : q.path === "/music"
              ? "Music"
              : q.path === "/photos"
                ? "Photos"
                : "Your next discovery",
        { items: catalog(store, { ...q.query, ...filter }, q.mediaUser) },
      );
    },
  );
  app.get("/search", (q, r) =>
    render(q, r, "browse", "Search your library", {
      items: catalog(store, q.query, q.mediaUser),
    }),
  );
  app.get("/favorites", (q, r) => {
    const user = requireUser(q);
    const items = store
      .all("SELECT media_id FROM favorites WHERE user_id=?", user.id)
      .flatMap((row) => {
        try {
          return [publicMedia(store, row.media_id, user)];
        } catch {
          return [];
        }
      });
    render(q, r, "browse", "Favorites", { items });
  });
  app.get("/media/:id", (q, r) => {
    const entry = publicMedia(
      store,
      String(q.params.id),
      q.mediaUser,
      mediaVersion(q),
    );
    render(q, r, "media", entry.metadata.title, {
      entry,
      favorite:
        !!q.mediaUser &&
        !!store.one(
          "SELECT 1 FROM favorites WHERE user_id=? AND media_id=?",
          q.mediaUser.id,
          entry.id,
        ),
    });
  });
  app.get(["/watch/:id", "/listen/:id", "/photos/:id"], (q, r) => {
    const entry = publicMedia(
        store,
        String(q.params.id),
        q.mediaUser,
        mediaVersion(q),
      ),
      expected = q.path.startsWith("/watch")
        ? "video"
        : q.path.startsWith("/listen")
          ? "audio"
          : "image";
    if (entry.metadata.kind !== expected)
      throw new MediaError("Media not found.", 404);
    render(
      q,
      r,
      expected === "image" ? "photo" : "player",
      entry.metadata.title,
      {
        entry,
        progress: q.mediaUser
          ? store.one(
              "SELECT position FROM progress WHERE user_id=? AND media_id=?",
              q.mediaUser.id,
              entry.id,
            )?.position || 0
          : 0,
      },
    );
  });
  app.get("/m/:id", (q, r) => {
    const entry = publicMedia(store, String(q.params.id), q.mediaUser),
      policy = store.policy();
    if (entry.metadata.delivery === "inline" && policy.allowInline)
      return r.redirect("/api/v1/media/" + entry.id + "/raw");
    if (entry.metadata.delivery === "download" && policy.allowDownload)
      return r.redirect("/api/v1/media/" + entry.id + "/raw?download=1");
    r.redirect("/media/" + entry.id);
  });
  app.get(["/albums/:id", "/collections/:id"], (q, r) => {
    const collection = store.one(
      "SELECT * FROM collections WHERE id=?",
      String(q.params.id),
    );
    if (!collection) throw new MediaError("Collection not found.", 404);
    const ownerView =
      q.mediaUser &&
      (q.mediaUser.id === collection.owner || q.mediaUser.role === "admin");
    const items = (
      ownerView
        ? store
            .all(
              "SELECT id,published,draft FROM media WHERE owner=? AND removed=0 ORDER BY updated DESC",
              collection.owner,
            )
            .flatMap((row) => {
              try {
                const entry = publicMedia(
                  store,
                  row.id,
                  q.mediaUser,
                  row.published || row.draft,
                );
                return [{ ...entry, preview: !row.published }];
              } catch {
                return [];
              }
            })
        : catalog(store, {}, q.mediaUser)
    ).filter((item) => item.metadata.collection === collection.id);
    if (
      !items.length &&
      q.mediaUser?.id !== collection.owner &&
      q.mediaUser?.role !== "admin"
    )
      throw new MediaError("Collection not found.", 404);
    render(q, r, "browse", collection.title, { items, collection });
  });
  app.get("/api/v1/session", (q, r) =>
    r.json({
      user: q.mediaUser
        ? {
            id: q.mediaUser.id,
            name: q.mediaUser.name,
            role: q.mediaUser.role,
            creatorStatus: q.mediaUser.creator_status,
          }
        : null,
      csrf: r.locals.csrf,
    }),
  );
  app.get("/api/v1/media", (q, r) =>
    r.json({ items: catalog(store, q.query, q.mediaUser) }),
  );
  app.get("/api/v1/media/:id", (q, r) =>
    r.json(
      publicMedia(store, String(q.params.id), q.mediaUser, mediaVersion(q)),
    ),
  );
  app.get("/api/v1/media/:id/raw", (q, r) =>
    original(store, q, r, String(q.params.id), q.mediaUser),
  );
  app.get("/api/v1/media/:id/versions/:version/streams/:name", (q, r) =>
    derived(
      store,
      q,
      r,
      String(q.params.id),
      String(q.params.name),
      q.mediaUser,
      String(q.params.version),
    ),
  );
  app.get("/api/v1/media/:id/streams/:name", (q, r) =>
    derived(
      store,
      q,
      r,
      String(q.params.id),
      String(q.params.name),
      q.mediaUser,
    ),
  );
  app.get("/api/v1/media/:id/thumbnail", (q, r) => {
    const parent = visibleVersion(
      store,
      String(q.params.id),
      q.mediaUser,
      mediaVersion(q),
    );
    let row = parent.version;
    if (parent.metadata.artwork) {
      const artwork = store.one(
        "SELECT v.*,m.owner FROM versions v JOIN media m ON m.id=v.media_id WHERE v.id=? AND v.state='ready'",
        parent.metadata.artwork,
      );
      if (artwork && artwork.owner === parent.item.owner) row = artwork;
    }
    const info = JSON.parse(row.processing),
      name = info.files?.includes("thumbnail.webp")
        ? "thumbnail.webp"
        : info.files?.includes("thumbnail.jpg")
          ? "thumbnail.jpg"
          : null;
    if (!name) return r.redirect("/static/favicon.svg");
    sendFile(
      q,
      r,
      safeFile(store, path.join(row.derived, name)),
      name.endsWith("webp") ? "image/webp" : "image/jpeg",
      name,
    );
  });
  app.post("/api/v1/media/:id/metadata", (q, r) => {
    const user = requireUser(q);
    r.json({
      version: updateMetadata(
        store,
        user,
        String(q.params.id),
        String(q.body.version),
        q.body.metadata,
      ),
    });
  });
  app.post("/api/v1/media/:id/publication", (q, r) => {
    const user = requireUser(q),
      approve = q.body.action === "approve";
    if (!approve && q.body.action !== "submit")
      throw new MediaError("Choose submit or approve.");
    r.json({
      state: publishMedia(
        store,
        user,
        String(q.params.id),
        String(q.body.version),
        approve,
        String(q.body.note || ""),
      ),
    });
  });
  app.delete("/api/v1/media/:id", (q, r) => {
    removeMedia(store, requireUser(q), String(q.params.id), "remove");
    r.json({ ok: true });
  });
  app.post("/api/v1/media/:id/restore", (q, r) => {
    removeMedia(store, requireUser(q), String(q.params.id), "restore");
    r.json({ ok: true, published: false });
  });
  app.post("/api/v1/media/:id/favorite", (q, r) => {
    const user = requireUser(q),
      key = String(q.params.id);
    visibleVersion(store, key, user);
    if (q.body.favorite === false)
      store.run(
        "DELETE FROM favorites WHERE user_id=? AND media_id=?",
        user.id,
        key,
      );
    else store.run("INSERT OR IGNORE INTO favorites VALUES(?,?)", user.id, key);
    r.json({ ok: true });
  });
  app.post("/api/v1/media/:id/progress", (q, r) => {
    const user = requireUser(q),
      entry = visibleVersion(store, String(q.params.id), user),
      position = Number(q.body.position);
    if (
      !Number.isFinite(position) ||
      position < 0 ||
      position > (entry.metadata.duration || 43200) + 1
    )
      throw new MediaError("Invalid playback position.");
    store.run(
      "INSERT INTO progress VALUES(?,?,?,?) ON CONFLICT(user_id,media_id) DO UPDATE SET position=excluded.position,updated=excluded.updated",
      user.id,
      entry.item.id,
      position,
      Date.now(),
    );
    r.json({ ok: true });
  });
  app.post("/api/v1/media/:id/reports", (q, r) => {
    const user = requireUser(q),
      key = String(q.params.id);
    visibleVersion(store, key, user);
    const reason = String(q.body.reason || "").trim();
    if (!reason || reason.length > 2000)
      throw new MediaError("Describe the problem in under 2000 characters.");
    store.run(
      "INSERT INTO reports VALUES(?,?,?,?,'open',?)",
      uid(),
      key,
      user.id,
      reason,
      Date.now(),
    );
    r.json({ ok: true });
  });
  app.post("/api/v1/uploads", (q, r) =>
    r.status(201).json(createUpload(store, requireUser(q), q.body)),
  );
  app.get("/api/v1/uploads/:id", (q, r) => {
    const row = uploadFor(store, requireUser(q), String(q.params.id));
    r.json({
      id: row.id,
      size: row.size,
      offset: row.offset,
      state: row.state,
      mediaId: row.media_id,
      version: row.version_id,
      maxChunk: 16 * 1024 ** 2,
    });
  });
  app.put(
    "/api/v1/uploads/:id",
    api(async (q, r) =>
      r.json(
        await appendChunk(
          store,
          requireUser(q),
          String(q.params.id),
          String(q.get("Content-Range") || ""),
          Number(q.get("Content-Length")),
          q,
        ),
      ),
    ),
  );
  app.post(
    "/api/v1/uploads/:id/complete",
    api(async (q, r) =>
      r.json(await completeUpload(store, requireUser(q), String(q.params.id))),
    ),
  );
  app.delete("/api/v1/uploads/:id", (q, r) => {
    cancelUpload(store, requireUser(q), String(q.params.id));
    r.json({ ok: true });
  });
  app.get("/api/v1/processing-jobs", (q, r) => r.json({ items: ownerJobs(q) }));
  app.post("/api/v1/processing-jobs/:id/cancel", (q, r) => {
    const job = jobOwned(q);
    cancelJob(store, job.id);
    r.json({ ok: true });
  });
  app.post("/api/v1/processing-jobs/:id/retry", (q, r) => {
    jobOwned(q);
    retryJob(store, String(q.params.id));
    r.json({ ok: true });
  });
  app.get("/creator", (q, r) => {
    const user = creator(store, q.mediaUser);
    render(q, r, "creator", "Creator workspace", {
      items: store
        .all(
          "SELECT m.*,v.metadata,v.state,v.publication FROM media m LEFT JOIN versions v ON v.id=m.draft WHERE m.owner=? OR ?='admin' ORDER BY m.updated DESC",
          user.id,
          user.role,
        )
        .map((item) => ({
          ...item,
          metadata: JSON.parse(item.metadata || "{}"),
        })),
      uploads: store.all(
        "SELECT id,filename,size,offset,state FROM uploads WHERE owner=? AND state IN ('open','finalizing') ORDER BY created DESC",
        user.id,
      ),
    });
  });
  app.get("/creator/upload", (q, r) => {
    const user = creator(store, q.mediaUser);
    render(q, r, "upload", "Upload media", {
      collections: store.all(
        "SELECT * FROM collections WHERE owner=?",
        user.id,
      ),
    });
  });
  app.get("/creator/media/:id", (q, r) => {
    const user = creator(store, q.mediaUser),
      item = ownedMedia(store, user, String(q.params.id)),
      version = store.one("SELECT * FROM versions WHERE id=?", item.draft);
    render(q, r, "creator-edit", "Edit media", {
      entry: {
        ...item,
        version: version.id,
        metadata: JSON.parse(version.metadata),
        state: version.state,
        publication: version.publication,
      },
      collections: store.all(
        "SELECT * FROM collections WHERE owner=?",
        item.owner,
      ),
      artwork: store.all(
        "SELECT v.id,json_extract(v.metadata,'$.title') title FROM media m JOIN versions v ON v.id=m.draft WHERE m.owner=? AND v.state='ready' AND json_extract(v.metadata,'$.kind')='image'",
        item.owner,
      ),
      reviews: store.all(
        "SELECT outcome,note,created FROM reviews WHERE version_id IN (SELECT id FROM versions WHERE media_id=?) ORDER BY created DESC",
        item.id,
      ),
    });
  });
  app.post("/creator/media/:id/save", (q, r) => {
    const next = updateMetadata(
      store,
      requireUser(q),
      String(q.params.id),
      String(q.body.version),
      q.body,
    );
    r.redirect(303, "/creator/media/" + q.params.id + "?version=" + next);
  });
  app.post("/creator/media/:id/publish", (q, r) => {
    publishMedia(
      store,
      requireUser(q),
      String(q.params.id),
      String(q.body.version),
    );
    r.redirect(303, "/creator/media/" + q.params.id);
  });
  app.post("/creator/media/:id/:action", (q, r) => {
    const action = String(q.params.action);
    if (
      !["remove", "withdraw", "restore"].includes(action) ||
      q.body.confirm !== "yes"
    )
      throw new MediaError("Confirm the content action.");
    removeMedia(store, requireUser(q), String(q.params.id), action as any);
    r.redirect(303, "/creator");
  });
  app.get("/creator/processing", (q, r) =>
    render(q, r, "processing", "Processing queue", { jobRows: ownerJobs(q) }),
  );
  app.get("/creator/collections", (q, r) => {
    const user = creator(store, q.mediaUser);
    render(q, r, "collections", "Your collections", {
      collections: store.all(
        "SELECT * FROM collections WHERE owner=?",
        user.id,
      ),
    });
  });
  app.post("/creator/collections", (q, r) => {
    const user = creator(store, q.mediaUser),
      title = String(q.body.title || "").trim(),
      kind = String(q.body.kind);
    if (
      !title ||
      title.length > 200 ||
      !["series", "audio", "photos"].includes(kind)
    )
      throw new MediaError("Choose a collection title and type.");
    store.run(
      "INSERT INTO collections VALUES(?,?,?,?,?)",
      uid(),
      user.id,
      title,
      kind,
      String(q.body.description || "").slice(0, 5000),
    );
    r.redirect(303, "/creator/collections");
  });
  app.get("/admin", (q, r) => {
    administrator(store, q.mediaUser);
    render(q, r, "admin", "Administration", {
      users: store.all(
        "SELECT id,name,email,role,creator_status,trusted,quota FROM users ORDER BY created DESC",
      ),
      reviewRows: store
        .all(
          "SELECT v.id,v.media_id,v.metadata,u.name author FROM versions v JOIN media m ON m.id=v.media_id JOIN users u ON u.id=m.owner WHERE v.publication='submitted' AND m.removed=0 ORDER BY v.created",
        )
        .map((row) => ({ ...row, metadata: JSON.parse(row.metadata) })),
      reports: store.all(
        "SELECT r.*,json_extract(v.metadata,'$.title') title FROM reports r JOIN media m ON m.id=r.media_id LEFT JOIN versions v ON v.id=m.published ORDER BY r.created DESC LIMIT 100",
      ),
    });
  });
  app.post("/admin/creators/:id", (q, r) => {
    reviewCreator(store, requireUser(q), String(q.params.id), {
      approved: q.body.approved === "on",
      trusted: q.body.trusted === "on",
      quota: Number(q.body.quota),
    });
    r.redirect(303, "/admin");
  });
  app.post("/admin/review/:id", (q, r) => {
    const user = administrator(store, q.mediaUser),
      version = store.one(
        "SELECT * FROM versions WHERE id=?",
        String(q.params.id),
      );
    if (!version) throw new MediaError("Submission not found.", 404);
    if (q.body.action === "approve")
      publishMedia(
        store,
        user,
        version.media_id,
        version.id,
        true,
        String(q.body.note || ""),
      );
    else rejectMedia(store, user, version.id, String(q.body.note || ""));
    r.redirect(303, "/admin");
  });
  app.post("/admin/reports/:id", (q, r) => {
    const user = administrator(store, q.mediaUser),
      report = store.one(
        "SELECT * FROM reports WHERE id=?",
        String(q.params.id),
      );
    if (!report) throw new MediaError("Report not found.", 404);
    if (q.body.action === "withdraw")
      removeMedia(store, user, report.media_id, "withdraw");
    store.run("UPDATE reports SET state='resolved' WHERE id=?", report.id);
    store.audit(user.id, "report.resolve", report.id);
    r.redirect(303, "/admin");
  });
  app.get("/admin/settings", (q, r) => {
    administrator(store, q.mediaUser);
    render(q, r, "settings", "Media settings");
  });
  app.post("/admin/settings", (q, r) => {
    const user = administrator(store, q.mediaUser),
      policy = {
        ...store.policy(),
        allowInline: q.body.allowInline === "on",
        allowDownload: q.body.allowDownload === "on",
        registration: q.body.registration === "on",
        acceleration: q.body.acceleration,
        device: q.body.device,
        uploadLimit: Number(q.body.uploadLimit),
        creatorQuota: Number(q.body.creatorQuota),
        globalQuota: Number(q.body.globalQuota),
        threads: Number(q.body.threads),
        concurrency: Number(q.body.concurrency),
        jobTimeout: Number(q.body.jobTimeout),
        maxQueuedJobs: Number(q.body.maxQueuedJobs),
        maxOutputBytes: Number(q.body.maxOutputBytes),
        profiles: JSON.parse(q.body.profiles),
      };
    savePolicy(store, user, policy);
    r.redirect(303, "/admin/settings");
  });
  app.get("/admin/library", (q, r) => {
    administrator(store, q.mediaUser);
    const index = Number(q.query.root || 0);
    render(q, r, "library", "Import local media", {
      roots: config.libraryRoots,
      selectedRoot: index,
      files: config.libraryRoots.length
        ? libraryFiles(store, q.mediaUser!, index)
        : [],
    });
  });
  app.post(
    "/admin/library",
    api(async (q, r) => {
      const user = administrator(store, q.mediaUser),
        result = await importLibrary(
          store,
          user,
          Number(q.body.root),
          String(q.body.file),
          metadata(q.body),
        );
      r.redirect(303, "/creator/media/" + result.id);
    }),
  );
  app.post("/admin/cache", (q, r) => {
    administrator(store, q.mediaUser);
    const files = cleanupCache(store, q.body.confirm === "cleanup");
    render(q, r, "message", "Cache maintenance", {
      notice:
        (q.body.confirm === "cleanup" ? "Removed " : "Would remove ") +
        files.length +
        " stale processing directories. Originals and published derivatives are retained.",
    });
  });
  app.use((_q, r) =>
    r.status(404).render("layout", {
      page: "message",
      title: "Page not found",
      path: "",
      asset,
      icon,
      user: null,
      csrf: "",
      policy: store.policy(),
      notice: "Choose a page from the navigation.",
      error: "",
      config: { origin: config.origin },
    }),
  );
  app.use((error: any, q: Request, r: Response, _next: any) => {
    if (r.headersSent) return r.destroy();
    const status =
      error instanceof MediaError
        ? error.status
        : error.code === "ENOENT"
          ? 404
          : error.type === "entity.parse.failed"
            ? 400
            : error.type === "entity.too.large"
              ? 413
              : 503;
    const message =
      error instanceof MediaError
        ? error.message
        : status === 404
          ? "File not found."
          : "This request could not complete. Please try again.";
    if (q.path.startsWith("/api/"))
      return r.status(status).json({ error: { message, status } });
    render(
      q,
      r.status(status),
      "message",
      status === 401 ? "Sign in to continue" : "Unable to complete request",
      { error: message },
    );
  });
  return { app, store };
}
