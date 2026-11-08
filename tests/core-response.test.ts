import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import request from "supertest";
import { configuration } from "../src/config.js";
import { Store } from "../src/database.js";
import { createUser } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { metadata, publishMedia } from "../src/media.js";
import { createUpload, appendChunk, completeUpload } from "../src/uploads.js";
import { runJob } from "../src/worker.js";

test("literal HTML in media metadata stays valid JSON and escaped page text", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kagnode-media-core-"));
  const store = new Store(
    configuration({
      DATA_DIR: folder,
      PUBLIC_URL: "http://localhost",
      NODE_ENV: "test",
    }),
  );
  try {
    const { app } = createApp(store.config, store);
    const admin = await createUser(
      store,
      "core@media.test",
      "Core fixture",
      "Isolated media response password 2026!",
      "admin",
    );
    const title = "Understanding <head> and </head> elements";
    const description =
      'Literal <head data-example="true"> source in a tutorial.';
    const info = metadata({
      title,
      description,
      kind: "file",
      category: "file",
      visibility: "public",
      delivery: "inline",
    });
    const body = Buffer.from(
      "Literal <head> text; this is not an HTML document.",
    );
    const upload = createUpload(store, admin, {
      filename: "lesson.txt",
      size: body.length,
      metadata: info,
    });
    await appendChunk(
      store,
      admin,
      upload.id,
      `bytes 0-${body.length - 1}/${body.length}`,
      body.length,
      Readable.from([body]),
    );
    const media = await completeUpload(store, admin, upload.id);
    await runJob(store, {
      async process(input) {
        assert.equal(input.metadata.kind, "file");
        return {
          metadata: { ...input.metadata, mime: "text/plain" },
          files: [],
          profiles: [],
        };
      },
    });
    publishMedia(store, admin, media.id, media.version, true);
    for (const url of ["/api/v1/media", `/api/v1/media/${media.id}`]) {
      const response = await request(app).get(url).set("Host", "localhost");
      assert.equal(response.status, 200);
      assert.match(response.headers["content-type"], /^application\/json/);
      const item =
        url === "/api/v1/media" ? response.body.items[0] : response.body;
      assert.equal(item.metadata.title, title);
      assert.equal(item.metadata.description, description);
      assert.doesNotMatch(response.text, /name="kagnode-core"/);
      assert.doesNotMatch(
        response.headers["content-security-policy"],
        /https:\/\/nebulacoder\.com/,
      );
    }
    const raw = await request(app)
      .get(`/api/v1/media/${media.id}/raw`)
      .set("Host", "localhost");
    assert.equal(raw.status, 200);
    assert.deepEqual(raw.body, body);
    assert.match(raw.headers["content-type"], /^application\/octet-stream/);
    assert.match(raw.headers["content-disposition"], /^attachment;/);
    const page = await request(app)
      .get(`/media/${media.id}`)
      .set("Host", "localhost");
    assert.equal(page.status, 200);
    assert.match(
      page.text,
      /Understanding &lt;head&gt; and &lt;\/head&gt; elements/,
    );
    assert.equal((page.text.match(/name="kagnode-core"/g) || []).length, 1);
  } finally {
    store.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
