import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import request from "supertest";
import { configuration } from "../src/config.js";
import { Store } from "../src/database.js";
import { createUser } from "../src/auth.js";
import { reviewCreator, savePolicy } from "../src/policy.js";
import {
  createUpload,
  appendChunk,
  completeUpload,
  importLibrary,
} from "../src/uploads.js";
import {
  metadata,
  publishMedia,
  publicMedia,
  updateMetadata,
  removeMedia,
  safeFile,
} from "../src/media.js";
import { runJob, recoverJobs, cleanupCache } from "../src/worker.js";
import { inspectOutputs } from "../src/processing.js";
import { createApp } from "../src/app.js";
import type { Processor, User } from "../src/types.js";
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kagnode-media-tests-")),
  config = configuration({
    DATA_DIR: folder,
    PUBLIC_URL: "http://localhost",
    NODE_ENV: "test",
  }),
  store = new Store(config),
  { app } = createApp(config, store);
const admin = await createUser(
    store,
    "admin@media.test",
    "Admin",
    "Isolated media password 2026!",
    "admin",
  ),
  author = await createUser(
    store,
    "author@media.test",
    "Author",
    "Isolated media password 2026!",
  ),
  other = await createUser(
    store,
    "other@media.test",
    "Other",
    "Isolated media password 2026!",
  );
reviewCreator(store, admin, author.id, {
  approved: true,
  trusted: false,
  quota: store.policy().creatorQuota,
});
const creator = store.user(author.id) as User;
after(() => {
  store.close();
  fs.rmSync(folder, { recursive: true, force: true });
});
const data = (kind = "file", visibility = "public", delivery = "viewer") =>
  metadata({
    title: "Sample media",
    kind,
    category:
      kind === "video"
        ? "movie"
        : kind === "image"
          ? "photo"
          : kind === "audio"
            ? "music"
            : "file",
    visibility,
    delivery,
  });
const processor: Processor = {
  async process(input, signal, progress) {
    assert.equal(signal.aborted, false);
    progress(50);
    if (input.metadata.kind === "file")
      return {
        metadata: { ...input.metadata, mime: "text/plain" },
        files: [],
        profiles: [],
      };
    const files =
      input.metadata.kind === "image"
        ? ["photo.webp", "thumbnail.webp"]
        : ["master.m3u8", "720p.m3u8", "720p-00000.ts", "thumbnail.jpg"];
    for (const name of files)
      fs.writeFileSync(
        path.join(input.destination, name),
        name === "master.m3u8"
          ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n720p.m3u8\n"
          : name === "720p.m3u8"
            ? "#EXTM3U\n#EXTINF:4,\n720p-00000.ts\n#EXT-X-ENDLIST\n"
            : "mocked-output",
      );
    return {
      metadata: {
        ...input.metadata,
        mime: input.metadata.kind === "image" ? "image/png" : "video/mp4",
        duration: 30,
      },
      files,
      profiles: input.metadata.kind === "image" ? [] : ["720p"],
    };
  },
};
async function upload(
  user = creator,
  info = data(),
  body = Buffer.from("0123456789"),
) {
  const u = createUpload(store, user, {
    filename: "example.txt",
    size: body.length,
    metadata: info,
  });
  await appendChunk(
    store,
    user,
    u.id,
    `bytes 0-${body.length - 1}/${body.length}`,
    body.length,
    Readable.from([body]),
  );
  const item = await completeUpload(store, user, u.id);
  return { ...item, upload: u.id };
}
const host = (method: "get" | "post" | "put" | "head", url: string) =>
  request(app)[method](url).set("Host", "localhost");
async function login(email: string) {
  const agent = request.agent(app),
    session = await agent.get("/api/v1/session").set("Host", "localhost");
  const response = await agent.post("/login").set("Host", "localhost").send({
    _csrf: session.body.csrf,
    email,
    password: "Isolated media password 2026!",
  });
  assert.equal(response.status, 303);
  const current = await agent.get("/api/v1/session").set("Host", "localhost");
  return { agent, csrf: current.body.csrf };
}
test("creator approval uses current permissions; viewers and forged roles cannot upload", () => {
  assert.throws(
    () =>
      createUpload(store, other, { size: 10, filename: "x", metadata: data() }),
    /creator/,
  );
  assert.throws(
    () =>
      createUpload(
        store,
        { ...other, role: "admin" },
        { size: 10, filename: "x", metadata: data() },
      ),
    /creator/,
  );
});
test("resumable offsets, quota reservations and repeat completion are consistent", async () => {
  const u = createUpload(store, creator, {
    size: 10,
    filename: "x",
    metadata: data(),
  });
  await appendChunk(
    store,
    creator,
    u.id,
    "bytes 0-4/10",
    5,
    Readable.from(["01234"]),
  );
  await assert.rejects(
    appendChunk(
      store,
      creator,
      u.id,
      "bytes 0-4/10",
      5,
      Readable.from(["56789"]),
    ),
    /offset/,
  );
  assert.equal(
    store.one("SELECT offset FROM uploads WHERE id=?", u.id).offset,
    5,
  );
  await assert.rejects(
    appendChunk(
      store,
      creator,
      u.id,
      "bytes 5-9/10",
      5,
      Readable.from(["too"]),
    ),
    /interrupted/,
  );
  assert.equal(
    store.one("SELECT offset FROM uploads WHERE id=?", u.id).offset,
    5,
  );
  await appendChunk(
    store,
    creator,
    u.id,
    "bytes 5-9/10",
    5,
    Readable.from(["56789"]),
  );
  const result = await completeUpload(store, creator, u.id);
  assert.deepEqual(await completeUpload(store, creator, u.id), result);
  assert.throws(
    () =>
      createUpload(store, creator, {
        size: store.policy().uploadLimit + 1,
        metadata: data(),
      }),
    /limit/,
  );
});
test("processing is mocked; moderation gates original, streams, thumbnail and discovery", async () => {
  const item = await upload(creator, data("video"));
  await runJob(store, processor);
  while (store.one("SELECT id FROM jobs WHERE state='queued'"))
    await runJob(store, processor);
  assert.throws(() => publicMedia(store, item.id), /not found/);
  assert.equal((await host("get", `/api/v1/media/${item.id}/raw`)).status, 404);
  assert.equal(
    publishMedia(store, creator, item.id, item.version),
    "submitted",
  );
  assert.equal(
    (await host("get", `/api/v1/media/${item.id}/thumbnail`)).status,
    404,
  );
  publishMedia(store, admin, item.id, item.version, true);
  assert.equal(publicMedia(store, item.id).metadata.title, "Sample media");
  const playlist = await host(
    "get",
    `/api/v1/media/${item.id}/versions/${item.version}/streams/master.m3u8`,
  );
  assert.equal(playlist.status, 200);
  assert.match(playlist.text, /720p.m3u8/);
  assert.equal(
    (
      await host(
        "get",
        `/api/v1/media/${item.id}/versions/${item.version}/streams/720p.m3u8`,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await host(
        "get",
        `/api/v1/media/${item.id}/versions/${item.version}/streams/not-allowed.ts`,
      )
    ).status,
    404,
  );
});
test("Range, HEAD, delivery modes and administrator policy are enforced", async () => {
  const item = await upload(creator, data("file", "public", "inline"));
  await runJob(store, processor);
  publishMedia(store, admin, item.id, item.version, true);
  let response = await host("get", `/api/v1/media/${item.id}/raw`).set(
    "Range",
    "bytes=2-5",
  );
  assert.equal(response.status, 206);
  assert.equal(response.body.toString(), "2345");
  assert.equal(response.headers["content-range"], "bytes 2-5/10");
  assert.equal(
    (
      await host("get", `/api/v1/media/${item.id}/raw`).set(
        "Range",
        "bytes=99-100",
      )
    ).status,
    416,
  );
  assert.equal(
    (
      await host("get", `/api/v1/media/${item.id}/raw`).set(
        "Range",
        "bytes=0-1,3-4",
      )
    ).status,
    416,
  );
  assert.equal(
    (await host("head", `/api/v1/media/${item.id}/raw`)).headers[
      "content-length"
    ],
    "10",
  );
  assert.equal(
    (await host("get", `/m/${item.id}`)).headers.location,
    `/api/v1/media/${item.id}/raw`,
  );
  savePolicy(store, admin, {
    ...store.policy(),
    allowInline: false,
    allowDownload: false,
  });
  assert.equal((await host("get", `/api/v1/media/${item.id}/raw`)).status, 403);
  assert.equal(
    (await host("get", `/m/${item.id}`)).headers.location,
    `/media/${item.id}`,
  );
  savePolicy(store, admin, {
    ...store.policy(),
    allowInline: true,
    allowDownload: true,
  });
});
test("published revisions remain unchanged until approved; removal blocks every delivery", async () => {
  const item = await upload();
  await runJob(store, processor);
  publishMedia(store, admin, item.id, item.version, true);
  const next = updateMetadata(store, creator, item.id, item.version, {
    ...data(),
    title: "Private revision",
  });
  assert.notEqual(next, item.version);
  assert.equal(publicMedia(store, item.id).metadata.title, "Sample media");
  assert.throws(() => publicMedia(store, item.id, other, next), /not found/);
  assert.equal(
    publicMedia(store, item.id, creator, next).metadata.title,
    "Private revision",
  );
  publishMedia(store, creator, item.id, next);
  assert.equal(publicMedia(store, item.id).version, item.version);
  assert.throws(() => publishMedia(store, other, item.id, next), /creator/);
  removeMedia(store, creator, item.id, "remove");
  assert.equal((await host("get", `/api/v1/media/${item.id}/raw`)).status, 404);
  removeMedia(store, creator, item.id, "restore");
  assert.throws(() => publicMedia(store, item.id), /not found/);
  assert.ok(store.one("SELECT id FROM versions WHERE id=?", item.version));
});
test("private and unlisted media have separate discovery and delivery permissions", async () => {
  for (const visibility of ["private", "unlisted"]) {
    const item = await upload(creator, data("file", visibility));
    await runJob(store, processor);
    publishMedia(store, admin, item.id, item.version, true);
    assert.equal(
      (await host("get", `/api/v1/media/${item.id}/raw`)).status,
      visibility === "private" ? 404 : 200,
    );
    const listing = await host("get", "/api/v1/media");
    assert.equal(
      listing.body.items.some((x: any) => x.id === item.id),
      false,
    );
  }
});
test("processing failure, cancellation and restart recovery retain originals", async () => {
  const item = await upload(),
    job = store.one("SELECT * FROM jobs WHERE version_id=?", item.version);
  await runJob(store, {
    async process() {
      throw Error("private source path must not be exposed");
    },
  });
  assert.equal(
    store.one("SELECT state FROM jobs WHERE id=?", job.id).state,
    "failed",
  );
  assert.doesNotMatch(
    store.one("SELECT error FROM jobs WHERE id=?", job.id).error,
    /private source/,
  );
  store.run(
    "UPDATE jobs SET state='processing',lease='stale',lease_until=0 WHERE id=?",
    job.id,
  );
  recoverJobs(store);
  assert.equal(
    store.one("SELECT state FROM jobs WHERE id=?", job.id).state,
    "queued",
  );
  store.run("UPDATE jobs SET cancel=1 WHERE id=?", job.id);
  recoverJobs(store);
  assert.equal(
    store.one("SELECT state FROM jobs WHERE id=?", job.id).state,
    "cancelled",
  );
  assert.ok(
    fs.existsSync(
      safeFile(
        store,
        store.one("SELECT source FROM versions WHERE id=?", item.version)
          .source,
      ),
    ),
  );
});
test("path traversal, missing derivatives and filesystem symlinks are rejected", () => {
  assert.throws(() => safeFile(store, "../outside"), /not found/);
  fs.symlinkSync(os.tmpdir(), path.join(folder, "outside"));
  assert.throws(() => safeFile(store, "outside/example"), /not found/);
  const output = fs.mkdtempSync(path.join(folder, "jobs/check-"));
  fs.writeFileSync(
    path.join(output, "master.m3u8"),
    "#EXTM3U\nhttps://external.invalid/leak\n",
  );
  assert.throws(() => inspectOutputs(output, ["master.m3u8"]));
  assert.throws(() => inspectOutputs(output, ["../originals/source"]));
});
test("CSRF, account isolation and readable route templates work without processing tools", async () => {
  assert.equal((await host("post", "/api/v1/uploads").send({})).status, 403);
  const { agent, csrf } = await login(creator.email);
  for (const url of [
    "/",
    "/movies",
    "/series",
    "/music",
    "/photos",
    "/account",
    "/creator",
    "/creator/upload",
    "/creator/collections",
    "/creator/processing",
  ]) {
    const result = await agent.get(url).set("Host", "localhost");
    assert.equal(result.status, 200, url + ": " + result.text.slice(-300));
    assert.doesNotMatch(result.text, /Operator console/);
  }
  assert.equal(
    (await agent.get("/admin").set("Host", "localhost")).status,
    403,
  );
  assert.equal(
    (
      await agent
        .post("/api/v1/uploads")
        .set("Host", "localhost")
        .set("Origin", "https://evil.invalid")
        .set("X-CSRF-Token", csrf)
        .send({})
    ).status,
    403,
  );
  const a = await login(admin.email);
  for (const url of ["/admin", "/admin/settings", "/admin/library"])
    assert.equal(
      (await a.agent.get(url).set("Host", "localhost")).status,
      200,
      url,
    );
});
test("cache cleanup cannot erase originals or retained versions", () => {
  const orphan = path.join(folder, "derived", "unreferenced");
  fs.mkdirSync(orphan);
  fs.utimesSync(orphan, 1, 1);
  const dry = cleanupCache(store);
  assert.ok(dry.includes("derived/unreferenced"));
  assert.ok(fs.existsSync(orphan));
  cleanupCache(store, true);
  assert.equal(fs.existsSync(orphan), false);
  assert.ok(store.one("SELECT COUNT(*) n FROM versions").n > 0);
});

test("queue capacity and output limits are bounded without running native tools", async () => {
  const before = store.policy();
  savePolicy(store, admin, {
    ...before,
    maxQueuedJobs: 1,
    maxOutputBytes: 1048576,
  });
  const first = await upload(),
    u = createUpload(store, creator, {
      filename: "next.txt",
      size: 3,
      metadata: data(),
    });
  await appendChunk(
    store,
    creator,
    u.id,
    "bytes 0-2/3",
    3,
    Readable.from(["abc"]),
  );
  await assert.rejects(completeUpload(store, creator, u.id), /queue is full/);
  await runJob(store, processor);
  const second = await completeUpload(store, creator, u.id);
  assert.ok(second.id);
  await runJob(store, {
    async process(input) {
      fs.writeFileSync(
        path.join(input.destination, "oversized.bin"),
        Buffer.alloc(1048577),
      );
      return {
        metadata: input.metadata,
        files: ["oversized.bin"],
        profiles: [],
      };
    },
  });
  assert.equal(
    store.one("SELECT state FROM versions WHERE id=?", second.version).state,
    "failed",
  );
  assert.ok(store.one("SELECT source FROM versions WHERE id=?", first.version));
  savePolicy(store, admin, before);
});
test("trusted publication and subsequent creator revocation use current account state", async () => {
  reviewCreator(store, admin, creator.id, { approved: true, trusted: true });
  const item = await upload();
  await runJob(store, processor);
  assert.equal(
    publishMedia(store, creator, item.id, item.version),
    "published",
  );
  const u = createUpload(store, creator, { size: 1, metadata: data() });
  reviewCreator(store, admin, creator.id, { approved: false });
  await assert.rejects(
    appendChunk(store, creator, u.id, "bytes 0-0/1", 1, Readable.from(["x"])),
    /creator/,
  );
  assert.throws(
    () =>
      publishMedia(store, { ...creator, trusted: 1 }, item.id, item.version),
    /creator/,
  );
  reviewCreator(store, admin, creator.id, { approved: true, trusted: false });
});
test("publication API rejects ordinary viewers, missing CSRF and stale draft versions", async () => {
  const item = await upload();
  await runJob(store, processor);
  const user = await login(creator.email),
    viewer = await login(other.email);
  let response = await user.agent
    .post(`/api/v1/media/${item.id}/publication`)
    .set("Host", "localhost")
    .send({ version: item.version, action: "submit" });
  assert.equal(response.status, 403);
  response = await viewer.agent
    .post(`/api/v1/media/${item.id}/publication`)
    .set("Host", "localhost")
    .set("X-CSRF-Token", viewer.csrf)
    .send({ version: item.version, action: "submit" });
  assert.equal(response.status, 403);
  response = await user.agent
    .post(`/api/v1/media/${item.id}/publication`)
    .set("Host", "localhost")
    .set("X-CSRF-Token", user.csrf)
    .send({ version: "stale", action: "submit" });
  assert.equal(response.status, 409);
  response = await user.agent
    .post(`/api/v1/media/${item.id}/publication`)
    .set("Host", "localhost")
    .set("X-CSRF-Token", user.csrf)
    .send({ version: item.version, action: "submit" });
  assert.equal(response.body.state, "submitted");
});

test("malformed requests fail safely before authentication middleware initializes", async () => {
  const json = await host("post", "/api/v1/uploads")
    .set("Content-Type", "application/json")
    .send("{");
  assert.equal(json.status, 400);
  assert.doesNotMatch(
    JSON.stringify(json.body),
    /ReferenceError|node_modules|\\.ts:/,
  );
  const html = await host("post", "/login")
    .set("Content-Type", "application/json")
    .send("{");
  assert.equal(html.status, 400);
  assert.match(html.text, /Unable to complete request/);
  assert.doesNotMatch(html.text, /ReferenceError|node_modules|\\.ts:/);
});

test("publication retries never demote approved media or duplicate review receipts", async () => {
  const item = await upload();
  await runJob(store, processor);
  publishMedia(store, creator, item.id, item.version);
  const count = store.one(
    "SELECT COUNT(*) n FROM reviews WHERE version_id=?",
    item.version,
  ).n;
  publishMedia(store, creator, item.id, item.version);
  assert.equal(
    store.one("SELECT COUNT(*) n FROM reviews WHERE version_id=?", item.version)
      .n,
    count,
  );
  publishMedia(store, admin, item.id, item.version, true);
  const approved = store.one(
    "SELECT COUNT(*) n FROM reviews WHERE version_id=?",
    item.version,
  ).n;
  assert.equal(
    publishMedia(store, creator, item.id, item.version),
    "published",
  );
  assert.equal(publicMedia(store, item.id).version, item.version);
  assert.equal(
    store.one("SELECT COUNT(*) n FROM reviews WHERE version_id=?", item.version)
      .n,
    approved,
  );
});
test("multiple worker instances respect a global lease bound; queued jobs cancel without a worker", async () => {
  const item = await upload(),
    otherItem = await upload(),
    another = new Store(config);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = runJob(store, {
    async process(input, signal, progress) {
      await pending;
      return processor.process(input, signal, progress);
    },
  });
  let claimed;
  try {
    claimed = await runJob(another, processor);
  } finally {
    release();
    await first;
    another.close();
  }
  assert.equal(claimed, false);
  const { cancelJob } = await import("../src/worker.js");
  const job = store.one(
    "SELECT id FROM jobs WHERE version_id=?",
    otherItem.version,
  );
  cancelJob(store, job.id);
  assert.equal(
    store.one("SELECT state FROM jobs WHERE id=?", job.id).state,
    "cancelled",
  );
  assert.equal(
    store.one("SELECT state FROM versions WHERE id=?", otherItem.version).state,
    "cancelled",
  );
  assert.equal(
    store.one("SELECT state FROM versions WHERE id=?", item.version).state,
    "ready",
  );
});

test("creator album previews include their private media and uploads cannot spoof another collection", async () => {
  store.run(
    "INSERT INTO collections VALUES(?,?,?,?,?)",
    "own-album",
    creator.id,
    "Private album",
    "album",
    "",
  );
  store.run(
    "INSERT INTO collections VALUES(?,?,?,?,?)",
    "other-album",
    other.id,
    "Other album",
    "album",
    "",
  );
  assert.throws(
    () =>
      createUpload(store, creator, {
        size: 3,
        filename: "x",
        metadata: { ...data("image", "private"), collection: "other-album" },
      }),
    /collection/,
  );
  const item = await upload(creator, {
    ...data("image", "private"),
    collection: "own-album",
  });
  await runJob(store, processor);
  const owner = await login(creator.email);
  const page = await owner.agent
    .get("/albums/own-album")
    .set("Host", "localhost");
  assert.equal(page.status, 200);
  assert.match(page.text, /Private preview/);
  assert.match(page.text, new RegExp("version=" + item.version));
  assert.equal((await host("get", "/albums/own-album")).status, 404);
  const viewer = await login(other.email);
  assert.equal(
    (await viewer.agent.get("/albums/own-album").set("Host", "localhost"))
      .status,
    404,
  );
});
