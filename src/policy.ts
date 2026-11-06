import { Store } from "./database.js";
import { administrator } from "./auth.js";
import { MediaError } from "./errors.js";
import type { Policy, User } from "./types.js";
export function savePolicy(store: Store, user: User, value: Policy) {
  administrator(store, user);
  for (const field of ["allowInline", "allowDownload", "registration"])
    if (typeof (value as any)[field] !== "boolean")
      throw new MediaError("Choose delivery and registration options.");
  for (const [field, min, max] of [
    ["uploadLimit", 1, 1024 ** 4],
    ["creatorQuota", 1, 16 * 1024 ** 4],
    ["globalQuota", 1, 1024 ** 5],
    ["threads", 1, 32],
    ["concurrency", 1, 4],
    ["jobTimeout", 60, 86400],
    ["maxQueuedJobs", 1, 10000],
    ["maxOutputBytes", 1048576, 1024 ** 4],
  ] as const)
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < min ||
      value[field] > max
    )
      throw new MediaError("Invalid processing or storage limit: " + field);
  if (
    !["software", "vaapi", "qsv", "nvenc"].includes(value.acceleration) ||
    !/^\/dev\/dri\/renderD\d+$/.test(value.device)
  )
    throw new MediaError("Choose an acceleration mode and render device.");
  if (
    !Array.isArray(value.profiles) ||
    !value.profiles.length ||
    value.profiles.length > 4 ||
    new Set(value.profiles.map((p) => p.id)).size !== value.profiles.length
  )
    throw new MediaError("Use one to four unique output profiles.");
  for (const p of value.profiles)
    if (
      !/^[a-z0-9-]{1,24}$/.test(p.id) ||
      ![p.width, p.height, p.bitrate].every(Number.isSafeInteger) ||
      p.width < 160 ||
      p.width > 3840 ||
      p.height < 90 ||
      p.height > 2160 ||
      p.width % 2 ||
      p.height % 2 ||
      p.bitrate < 128000 ||
      p.bitrate > 30000000
    )
      throw new MediaError("Invalid output profile.");
  store.transaction(() => {
    store.run(
      "INSERT INTO settings VALUES('policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify(value),
    );
    store.audit(user.id, "policy.save", "policy");
  });
}
export function reviewCreator(
  store: Store,
  actor: User,
  key: string,
  value: any,
) {
  administrator(store, actor);
  const user = store.user(key);
  if (!user || user.role === "admin")
    throw new MediaError("Choose a non-administrator account.");
  const approved = value.approved === true,
    trusted = approved && value.trusted === true;
  const quota = Number(value.quota || user.quota);
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 16 * 1024 ** 4)
    throw new MediaError("Invalid creator quota.");
  store.transaction(() => {
    store.run(
      "UPDATE users SET role=?,creator_status=?,trusted=?,quota=? WHERE id=?",
      approved ? "creator" : "viewer",
      approved ? "approved" : "rejected",
      trusted ? 1 : 0,
      quota,
      key,
    );
    store.audit(actor.id, "creator.review", key, { approved, trusted, quota });
  });
}
