import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { Store, uid } from "./database.js";
import { creator, administrator } from "./auth.js";
import { metadata, ownedMedia } from "./media.js";
import { MediaError } from "./errors.js";
import type { User } from "./types.js";
const maxChunk = 16 * 1024 ** 2;
export function storageUsage(store: Store, owner?: string) {
  const filter = owner
    ? "WHERE media_id IN (SELECT id FROM media WHERE owner=?)"
    : "";
  const parameters = owner ? [owner] : [];
  return (
    Number(
      store.one(
        `SELECT COALESCE(SUM(size),0) n FROM (SELECT source,MAX(size) size FROM versions ${filter} GROUP BY source)`,
        ...parameters,
      ).n,
    ) +
    Number(
      store.one(
        `SELECT COALESCE(SUM(bytes),0) n FROM (SELECT derived,MAX(COALESCE(json_extract(processing,'$.bytes'),0)) bytes FROM versions ${filter} GROUP BY derived)`,
        ...parameters,
      ).n,
    ) +
    Number(
      store.one(
        `SELECT COALESCE(SUM(size),0) n FROM uploads WHERE state IN ('open','finalizing') ${owner ? "AND owner=?" : ""}`,
        ...parameters,
      ).n,
    )
  );
}
function quota(store: Store, user: User, size: number) {
  const policy = store.policy();
  if (!Number.isSafeInteger(size) || size < 1 || size > policy.uploadLimit)
    throw new MediaError("File exceeds the installation upload limit.", 413);
  if (
    storageUsage(store, user.id) + size > user.quota ||
    storageUsage(store) + size > policy.globalQuota
  )
    throw new MediaError("Storage quota exceeded.", 413);
  const disk = fs.statfsSync(store.config.data);
  if (Number(disk.bavail) * Number(disk.bsize) < size + 100 * 1024 ** 2)
    throw new MediaError("Insufficient free storage.", 507);
  if (
    store.one(
      "SELECT COUNT(*) n FROM uploads WHERE owner=? AND state='open'",
      user.id,
    ).n >= 10
  )
    throw new MediaError("Finish or cancel an existing upload first.", 429);
}
export function createUpload(store: Store, user: User, value: any) {
  const actor = creator(store, user),
    data = metadata(value.metadata),
    size = Number(value.size),
    filename = String(value.filename || "media")
      .replace(/[\x00-\x1f\x7f/\\]/g, "_")
      .slice(0, 200);
  if (
    data.artwork &&
    !store.one(
      "SELECT v.id FROM versions v JOIN media m ON m.id=v.media_id WHERE v.id=? AND m.owner=? AND v.state='ready' AND json_extract(v.metadata,'$.kind')='image'",
      data.artwork,
      actor.id,
    )
  )
    throw new MediaError("Choose your own ready image artwork.");
  if (value.mediaId) ownedMedia(store, actor, String(value.mediaId));
  const id = uid(),
    version = uid();
  store.transaction(() => {
    quota(store, actor, size);
    store.run(
      "INSERT INTO uploads(id,owner,media_id,version_id,filename,size,metadata,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      actor.id,
      value.mediaId || null,
      version,
      filename,
      size,
      JSON.stringify(data),
      Date.now(),
    );
  });
  try {
    fs.writeFileSync(
      path.join(store.config.data, "uploads", id),
      Buffer.alloc(0),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    store.run("UPDATE uploads SET state='cancelled' WHERE id=?", id);
    throw error;
  }
  return { id, size, offset: 0, maxChunk };
}
export function uploadFor(store: Store, user: User, key: string) {
  const actor = store.user(user.id),
    row = store.one("SELECT * FROM uploads WHERE id=?", key);
  if (!actor || !row || (row.owner !== actor.id && actor.role !== "admin"))
    throw new MediaError("Upload not found.", 404);
  return row;
}
export async function appendChunk(
  store: Store,
  user: User,
  key: string,
  range: string,
  length: number,
  input: IncomingMessage | Readable,
) {
  creator(store, user);
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || "");
  if (!match) throw new MediaError("Send a single Content-Range.");
  const start = Number(match[1]),
    end = Number(match[2]),
    total = Number(match[3]);
  if (
    ![start, end, total, length].every(Number.isSafeInteger) ||
    length < 1 ||
    length > maxChunk ||
    end - start + 1 !== length
  )
    throw new MediaError("Invalid or oversized chunk.", 413);
  const lease = uid(),
    row = store.transaction(() => {
      const r = uploadFor(store, user, key);
      if (
        r.state !== "open" ||
        r.size !== total ||
        r.offset !== start ||
        end >= total
      )
        throw new MediaError(
          "Upload offset changed. Refresh upload status.",
          409,
        );
      if (r.lease_until > Date.now())
        throw new MediaError("Another chunk is still uploading.", 409);
      store.run(
        "UPDATE uploads SET lease=?,lease_until=? WHERE id=?",
        lease,
        Date.now() + 60000,
        key,
      );
      return r;
    });
  const temporary = path.join(
    store.config.data,
    "uploads",
    key + "-" + lease + ".part",
  );
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(
        received > length
          ? new MediaError("Chunk exceeds its declared size.", 413)
          : null,
        chunk,
      );
    },
  });
  try {
    await pipeline(
      input,
      meter,
      fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal: AbortSignal.timeout(30000) },
    );
    if (received !== length)
      throw new MediaError(
        "Chunk was interrupted. Resume from the saved offset.",
        409,
      );
    store.transaction(() => {
      creator(store, user);
      const current = uploadFor(store, user, key);
      if (
        current.lease !== lease ||
        current.offset !== start ||
        current.state !== "open"
      )
        throw new MediaError("Upload changed while receiving this chunk.", 409);
      const destination = path.join(store.config.data, "uploads", key),
        read = fs.openSync(
          temporary,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        ),
        write = fs.openSync(
          destination,
          fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
        );
      try {
        fs.ftruncateSync(write, start);
        const buffer = Buffer.alloc(65536);
        let offset = 0,
          count;
        while (
          (count = fs.readSync(read, buffer, 0, buffer.length, offset)) > 0
        ) {
          let written = 0;
          while (written < count)
            written += fs.writeSync(
              write,
              buffer,
              written,
              count - written,
              start + offset + written,
            );
          offset += count;
        }
        fs.fsyncSync(write);
      } finally {
        fs.closeSync(read);
        fs.closeSync(write);
      }
      store.run(
        "UPDATE uploads SET offset=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?",
        end + 1,
        key,
        lease,
      );
    });
    return { id: key, offset: end + 1, size: row.size };
  } finally {
    fs.rmSync(temporary, { force: true });
    store.run(
      "UPDATE uploads SET lease=NULL,lease_until=0 WHERE id=? AND lease=?",
      key,
      lease,
    );
  }
}
async function checksum(file: string) {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
export async function completeUpload(store: Store, user: User, key: string) {
  creator(store, user);
  const row = store.transaction(() => {
    const r = uploadFor(store, user, key);
    if (r.state === "complete") return r;
    if (r.state === "finalizing" && r.lease_until < Date.now()) {
      store.run("UPDATE uploads SET state='open' WHERE id=?", key);
      r.state = "open";
    }
    if (r.state !== "open" || r.offset !== r.size || r.lease_until > Date.now())
      throw new MediaError("Finish uploading before processing.", 409);
    store.run(
      "UPDATE uploads SET state='finalizing',lease_until=? WHERE id=?",
      Date.now() + 60000,
      key,
    );
    return r;
  });
  if (row.state === "complete")
    return { id: row.media_id, version: row.version_id };
  const relative = path.join("originals", row.version_id, "source"),
    folder = path.join(store.config.data, "originals", row.version_id),
    destination = path.join(store.config.data, relative),
    source = path.join(store.config.data, "uploads", key);
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(destination)) fs.renameSync(source, destination);
    if (fs.statSync(destination).size !== row.size)
      throw new MediaError("Stored upload size does not match.", 409);
    const hash = await checksum(destination);
    return store.transaction(() => {
      creator(store, user);
      const current = uploadFor(store, user, key);
      if (current.state !== "finalizing")
        throw new MediaError("Upload was cancelled.", 409);
      if (
        Number(
          store.one(
            "SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','processing')",
          ).n,
        ) >= store.policy().maxQueuedJobs
      )
        throw new MediaError(
          "Processing queue is full. Retry completion later.",
          429,
        );
      const media = row.media_id || uid();
      if (row.media_id) ownedMedia(store, user, media);
      else
        store.run(
          "INSERT INTO media VALUES(?,?,NULL,NULL,0,?,?)",
          media,
          row.owner,
          Date.now(),
          Date.now(),
        );
      const number = Number(
        store.one(
          "SELECT COALESCE(MAX(number),0)+1 n FROM versions WHERE media_id=?",
          media,
        ).n,
      );
      store.run(
        "INSERT INTO versions(id,media_id,number,metadata,source,mime,size,checksum,state,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
        row.version_id,
        media,
        number,
        JSON.stringify({
          ...JSON.parse(row.metadata),
          originalName: row.filename,
        }),
        relative,
        "application/octet-stream",
        row.size,
        hash,
        "queued",
        Date.now(),
      );
      store.run(
        "UPDATE media SET draft=?,updated=? WHERE id=?",
        row.version_id,
        Date.now(),
        media,
      );
      store.run(
        "UPDATE uploads SET state='complete',media_id=?,lease_until=0 WHERE id=?",
        media,
        key,
      );
      store.run(
        "INSERT INTO jobs(id,version_id,created,updated) VALUES(?,?,?,?)",
        uid(),
        row.version_id,
        Date.now(),
        Date.now(),
      );
      store.audit(user.id, "media.upload", media, {
        version: row.version_id,
        size: row.size,
      });
      return { id: media, version: row.version_id };
    });
  } catch (error) {
    store.run(
      "UPDATE uploads SET state='open',lease_until=0 WHERE id=? AND state='finalizing'",
      key,
    );
    throw error;
  }
}
export function cancelUpload(store: Store, user: User, key: string) {
  const row = uploadFor(store, user, key);
  if (row.state === "complete")
    throw new MediaError("Use media removal for a completed upload.");
  store.run(
    "UPDATE uploads SET state='cancelled',lease_until=0 WHERE id=?",
    key,
  );
  store.audit(user.id, "upload.cancel", key);
}
export function libraryFiles(store: Store, user: User, index: number) {
  administrator(store, user);
  const configured = store.config.libraryRoots[index];
  if (!configured) throw new MediaError("Choose a configured library root.");
  const root = fs.realpathSync(configured),
    files: string[] = [];
  function walk(folder: string, depth: number) {
    if (depth > 8 || files.length >= 10000) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) files.push(path.relative(root, file));
      if (files.length >= 10000) break;
    }
  }
  walk(root, 0);
  return files;
}
export async function importLibrary(
  store: Store,
  user: User,
  index: number,
  relative: string,
  value: any,
) {
  administrator(store, user);
  const configured = store.config.libraryRoots[index];
  if (
    !configured ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === "..")
  )
    throw new MediaError("Choose a file inside a configured root.");
  const root = fs.realpathSync(configured);
  let part = root;
  for (const name of relative.split(/[\\/]/)) {
    part = path.join(part, name);
    if (fs.lstatSync(part).isSymbolicLink())
      throw new MediaError("Library symlinks are not imported.");
  }
  const file = fs.realpathSync(path.join(root, relative));
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile())
    throw new MediaError("Library file unavailable.");
  const size = fs.statSync(file).size,
    upload = createUpload(store, user, {
      size,
      filename: path.basename(file),
      metadata: value,
    });
  try {
    for (let offset = 0; offset < size; offset += maxChunk) {
      const end = Math.min(size - 1, offset + maxChunk - 1);
      await appendChunk(
        store,
        user,
        upload.id,
        `bytes ${offset}-${end}/${size}`,
        end - offset + 1,
        fs.createReadStream(file, { start: offset, end }),
      );
    }
    return await completeUpload(store, user, upload.id);
  } catch (error) {
    cancelUpload(store, user, upload.id);
    throw error;
  }
}
