import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { Store } from "./database.js";
import { visibleVersion, safeFile } from "./media.js";
import { MediaError } from "./errors.js";
import type { User } from "./types.js";
export function byteRange(header: string | undefined, size: number) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]))
    throw new MediaError("Unsatisfiable byte range.", 416);
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new MediaError("Unsatisfiable byte range.", 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new MediaError("Unsatisfiable byte range.", 416);
  return { start, end };
}
export function sendFile(
  req: Request,
  res: Response,
  file: string,
  mime: string,
  filename: string,
  attachment = false,
) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new MediaError("File not found.", 404);
  let range;
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n/\\]/g, "_"))}`,
  });
  try {
    range = byteRange(req.get("Range"), stat.size);
  } catch (error) {
    res.set("Content-Range", "bytes */" + stat.size);
    throw error;
  }
  if (range)
    res
      .status(206)
      .set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  res
    .type(mime)
    .set(
      "Content-Length",
      String(range ? range.end - range.start + 1 : stat.size),
    );
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(file, {
    ...(range || {}),
    fd: fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    autoClose: true,
  });
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}
export function original(
  store: Store,
  req: Request,
  res: Response,
  key: string,
  user?: User,
) {
  const { version, metadata } = visibleVersion(
      store,
      key,
      user,
      String(req.query.version || "") || undefined,
    ),
    policy = store.policy(),
    download = req.query.download === "1";
  if ((download && !policy.allowDownload) || (!download && !policy.allowInline))
    throw new MediaError("Original delivery is disabled.", 403);
  const safe = [
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/flac",
    "audio/wav",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
  ].includes(version.mime);
  return sendFile(
    req,
    res,
    safeFile(store, version.source),
    safe ? version.mime : "application/octet-stream",
    (metadata as any).originalName || metadata.title,
    download || !safe,
  );
}
export function derived(
  store: Store,
  req: Request,
  res: Response,
  key: string,
  name: string,
  user?: User,
  override?: string,
) {
  const { version } = visibleVersion(
    store,
    key,
    user,
    override || String(req.query.version || "") || undefined,
  );
  if (!/^[a-z0-9][a-z0-9_.-]{0,100}$/.test(name) || name.includes(".."))
    throw new MediaError("File not found.", 404);
  const info = JSON.parse(version.processing);
  if (!Array.isArray(info.files) || !info.files.includes(name))
    throw new MediaError("File not found.", 404);
  const mime = name.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : name.endsWith(".m4s")
      ? "video/iso.segment"
      : name.endsWith(".ts")
        ? "video/mp2t"
        : name.endsWith(".jpg")
          ? "image/jpeg"
          : name.endsWith(".webp")
            ? "image/webp"
            : name.endsWith(".vtt")
              ? "text/vtt"
              : "application/octet-stream";
  return sendFile(
    req,
    res,
    safeFile(store, path.join(version.derived, name)),
    mime,
    name,
  );
}
