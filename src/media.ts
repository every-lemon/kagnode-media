import fs from "node:fs";
import path from "node:path";
import { Store, uid } from "./database.js";
import { administrator, creator } from "./auth.js";
import { MediaError } from "./errors.js";
import type { MediaMetadata, User } from "./types.js";
const clean = (value: unknown, max: number) => {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  )
    throw new MediaError("Invalid media text.");
  return value.trim();
};
export function metadata(value: any): MediaMetadata {
  const title = clean(value.title, 200),
    description = clean(value.description || "", 10000);
  if (!title) throw new MediaError("Add a media title.");
  if (
    !["video", "audio", "image", "file"].includes(value.kind) ||
    !["public", "unlisted", "private"].includes(value.visibility) ||
    !["viewer", "inline", "download"].includes(value.delivery) ||
    !["movie", "series", "video", "music", "photo", "file"].includes(
      value.category,
    )
  )
    throw new MediaError("Choose media type, visibility and delivery.");
  const categories: Record<string, string[]> = {
    video: ["movie", "series", "video"],
    audio: ["music"],
    image: ["photo"],
    file: ["file"],
  };
  if (!categories[value.kind].includes(value.category))
    throw new MediaError("Category does not match the media type.");
  const tags =
    typeof value.tags === "string"
      ? value.tags
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean)
      : value.tags || [];
  if (
    !Array.isArray(tags) ||
    tags.length > 20 ||
    tags.some((t) => typeof t !== "string" || !t.trim() || t.length > 50)
  )
    throw new MediaError("Use up to twenty short tags.");
  const season = Number(value.season || 0),
    episode = Number(value.episode || 0);
  if (
    ![season, episode].every(
      (n) => Number.isInteger(n) && n >= 0 && n <= 100000,
    )
  )
    throw new MediaError("Invalid season or episode.");
  return {
    title,
    description,
    tags: [...new Set(tags)],
    kind: value.kind,
    visibility: value.visibility,
    delivery: value.delivery,
    category: value.category,
    collection: clean(value.collection || "", 80),
    artwork: clean(value.artwork || "", 80),
    season,
    episode,
  };
}
export function ownedMedia(store: Store, user: User, key: string) {
  const current = creator(store, user),
    row = store.one("SELECT * FROM media WHERE id=?", key);
  if (!row || (current.role !== "admin" && row.owner !== current.id))
    throw new MediaError("Media not found.", 404);
  return row;
}
export function visibleVersion(
  store: Store,
  key: string,
  user?: User,
  version?: string,
) {
  const item = store.one("SELECT * FROM media WHERE id=? AND removed=0", key);
  if (!item) throw new MediaError("Media not found.", 404);
  const actor = user && store.user(user.id),
    owner = actor && (actor.id === item.owner || actor.role === "admin");
  const selected = version || item.published;
  if (!selected || (selected !== item.published && !owner))
    throw new MediaError("Media not found.", 404);
  const row = store.one(
    "SELECT * FROM versions WHERE id=? AND media_id=?",
    selected,
    key,
  );
  if (!row || row.state !== "ready")
    throw new MediaError("Media is not ready.", 404);
  const data = JSON.parse(row.metadata) as MediaMetadata;
  if (
    !owner &&
    (selected !== item.published ||
      row.publication !== "published" ||
      data.visibility === "private")
  )
    throw new MediaError("Media not found.", 404);
  return { item, version: row, metadata: data };
}
export function publicMedia(
  store: Store,
  key: string,
  user?: User,
  version?: string,
) {
  const v = visibleVersion(store, key, user, version);
  return {
    id: key,
    version: v.version.id,
    owner: v.item.owner,
    metadata: v.metadata,
    state: v.version.state,
    processing: JSON.parse(v.version.processing),
    created: v.item.created,
  };
}
export function catalog(store: Store, query: any = {}, user?: User) {
  const ids = store.all(
    "SELECT m.id FROM media m JOIN versions v ON v.id=m.published WHERE m.removed=0 AND v.publication='published' AND v.state='ready' AND json_extract(v.metadata,'$.visibility')='public' AND (?='' OR json_extract(v.metadata,'$.kind')=?) AND (?='' OR lower(json_extract(v.metadata,'$.title')||' '||json_extract(v.metadata,'$.description')||' '||json_extract(v.metadata,'$.tags')) LIKE ?) ORDER BY m.updated DESC LIMIT 200",
    String(query.kind || ""),
    String(query.kind || ""),
    String(query.q || "").slice(0, 150),
    "%" +
      String(query.q || "")
        .toLowerCase()
        .slice(0, 150) +
      "%",
  );
  return ids
    .map((row) => publicMedia(store, row.id, user))
    .filter(
      (row) => !query.category || row.metadata.category === query.category,
    );
}
export function updateMetadata(
  store: Store,
  user: User,
  key: string,
  version: string,
  value: any,
) {
  const item = ownedMedia(store, user, key);
  if (item.draft !== version)
    throw new MediaError("Draft changed. Refresh before saving.", 409);
  const old = store.one("SELECT * FROM versions WHERE id=?", version),
    data = metadata(value);
  if (data.collection) {
    const collection = store.one(
      "SELECT * FROM collections WHERE id=?",
      data.collection,
    );
    if (!collection || collection.owner !== item.owner)
      throw new MediaError("Choose one of this creator’s collections.");
  }
  if (data.kind !== JSON.parse(old.metadata).kind)
    throw new MediaError("Upload a new revision to change media type.");
  if (data.artwork) {
    const image = store.one(
      "SELECT v.id FROM versions v JOIN media m ON m.id=v.media_id WHERE v.id=? AND m.owner=? AND v.state='ready' AND json_extract(v.metadata,'$.kind')='image'",
      data.artwork,
      item.owner,
    );
    if (!image)
      throw new MediaError("Choose ready artwork owned by this creator.");
  }
  const info = { ...JSON.parse(old.metadata), ...data };
  return store.transaction(() => {
    let next = version;
    if (item.published === version || old.publication !== "draft") {
      next = uid();
      store.run(
        "INSERT INTO versions SELECT ?,media_id,?, ?,source,mime,size,checksum,state,'draft',derived,processing,? FROM versions WHERE id=?",
        next,
        store.one("SELECT MAX(number) n FROM versions WHERE media_id=?", key)
          .n + 1,
        JSON.stringify(info),
        Date.now(),
        version,
      );
      store.run(
        "UPDATE media SET draft=?,updated=? WHERE id=?",
        next,
        Date.now(),
        key,
      );
    } else
      store.run(
        "UPDATE versions SET metadata=? WHERE id=?",
        JSON.stringify(info),
        version,
      );
    store.audit(user.id, "media.metadata", key, { version: next });
    return next;
  });
}
export function publishMedia(
  store: Store,
  user: User,
  key: string,
  version: string,
  approve = false,
  note = "",
) {
  const actor = approve ? administrator(store, user) : creator(store, user),
    item = approve
      ? store.one("SELECT * FROM media WHERE id=?", key)
      : ownedMedia(store, user, key);
  if (!item || item.removed || item.draft !== version)
    throw new MediaError("This media draft changed or was removed.", 409);
  const row = store.one(
    "SELECT * FROM versions WHERE id=? AND media_id=?",
    version,
    key,
  );
  if (!row || row.state !== "ready")
    throw new MediaError("Wait for processing to complete.");
  const data = JSON.parse(row.metadata),
    policy = store.policy();
  if (
    (data.delivery === "inline" && !policy.allowInline) ||
    (data.delivery === "download" && !policy.allowDownload)
  )
    throw new MediaError(
      "The selected delivery mode is disabled by administration.",
    );
  const outcome =
    approve || actor.role === "admin" || actor.trusted
      ? "published"
      : "submitted";
  return store.transaction(() => {
    store.run("UPDATE versions SET publication=? WHERE id=?", outcome, version);
    if (outcome === "published")
      store.run(
        "UPDATE media SET published=?,updated=? WHERE id=?",
        version,
        Date.now(),
        key,
      );
    store.run(
      "INSERT INTO reviews VALUES(?,?,?,?,?,?)",
      uid(),
      version,
      actor.id,
      outcome,
      clean(note || "", 2000),
      Date.now(),
    );
    store.audit(actor.id, "media." + outcome, key, { version });
    return outcome;
  });
}
export function rejectMedia(
  store: Store,
  user: User,
  version: string,
  note: string,
) {
  administrator(store, user);
  if (!note.trim())
    throw new MediaError("Give a reason for returning this submission.");
  store.transaction(() => {
    store.run(
      "UPDATE versions SET publication='draft' WHERE id=? AND publication='submitted'",
      version,
    );
    store.run(
      "INSERT INTO reviews VALUES(?,?,?,?,?,?)",
      uid(),
      version,
      user.id,
      "changes-requested",
      clean(note, 2000),
      Date.now(),
    );
    store.audit(user.id, "media.review.return", version);
  });
}
export function removeMedia(
  store: Store,
  user: User,
  key: string,
  action: "remove" | "withdraw" | "restore",
) {
  const item = ownedMedia(store, user, key);
  store.transaction(() => {
    if (action === "restore")
      store.run(
        "UPDATE media SET removed=0,published=NULL,updated=? WHERE id=?",
        Date.now(),
        key,
      );
    else {
      store.run(
        "UPDATE media SET removed=?,published=NULL,updated=? WHERE id=?",
        action === "remove" ? 1 : 0,
        Date.now(),
        key,
      );
      store.run(
        "UPDATE versions SET publication='withdrawn' WHERE media_id=? AND publication='published'",
        key,
      );
      store.run(
        "UPDATE jobs SET cancel=1 WHERE version_id IN (SELECT id FROM versions WHERE media_id=?) AND state IN ('queued','processing')",
        key,
      );
    }
    store.audit(user.id, "media." + action, item.id);
  });
}
export function safeFile(store: Store, relative: string) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\"))
    throw new MediaError("File not found.", 404);
  const root = fs.realpathSync(store.config.data),
    file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep))
    throw new MediaError("File not found.", 404);
  let part = root;
  for (const name of path.relative(root, file).split(path.sep)) {
    part = path.join(part, name);
    if (fs.lstatSync(part).isSymbolicLink())
      throw new MediaError("File not found.", 404);
  }
  return file;
}
