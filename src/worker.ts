import { storageUsage } from "./uploads.js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store, uid } from "./database.js";
import { configuration } from "./config.js";
import { NativeProcessor, inspectOutputs } from "./processing.js";
import { safeFile } from "./media.js";
import type { Processor } from "./types.js";
export function recoverJobs(store: Store) {
  store.transaction(() => {
    store.run(
      "UPDATE jobs SET state=CASE WHEN cancel=1 THEN 'cancelled' ELSE 'queued' END,lease=NULL,lease_until=0,updated=? WHERE state='processing' AND lease_until<?",
      Date.now(),
      Date.now(),
    );
    store.run(
      "UPDATE versions SET state='queued' WHERE id IN (SELECT version_id FROM jobs WHERE state='queued') AND state='processing'",
    );
    store.run(
      "UPDATE jobs SET state='cancelled',updated=? WHERE state='queued' AND cancel=1",
      Date.now(),
    );
    store.run(
      "UPDATE versions SET state='cancelled' WHERE id IN (SELECT version_id FROM jobs WHERE state='cancelled') AND state IN ('queued','processing')",
    );
    store.run(
      "UPDATE uploads SET state='open' WHERE state='finalizing' AND lease_until<?",
      Date.now(),
    );
  });
}
export async function runJob(
  store: Store,
  processor: Processor,
  externalSignal?: AbortSignal,
) {
  recoverJobs(store);
  const lease = uid(),
    job = store.transaction(() => {
      if (
        Number(
          store.one("SELECT COUNT(*) n FROM jobs WHERE state='processing'").n,
        ) >= store.policy().concurrency
      )
        return null;
      const row = store.one(
        "SELECT j.*,v.source,v.metadata,v.media_id FROM jobs j JOIN versions v ON v.id=j.version_id WHERE j.state='queued' AND j.cancel=0 ORDER BY j.created LIMIT 1",
      );
      if (!row) return null;
      store.run(
        "UPDATE jobs SET state='processing',lease=?,lease_until=?,updated=? WHERE id=?",
        lease,
        Date.now() + 30000,
        Date.now(),
        row.id,
      );
      store.run(
        "UPDATE versions SET state='processing' WHERE id=?",
        row.version_id,
      );
      return row;
    });
  if (!job) return false;
  const controller = new AbortController(),
    signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(store.policy().jobTimeout * 1000),
      ...(externalSignal ? [externalSignal] : []),
    ]),
    folder = path.join(store.config.data, "jobs", job.id + "-" + lease),
    finalRelative = path.join("derived", job.version_id + "-" + lease),
    final = path.join(store.config.data, finalRelative);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const heartbeat = setInterval(() => {
    try {
      const row = store.one("SELECT lease,cancel FROM jobs WHERE id=?", job.id);
      const disk = fs.statfsSync(store.config.data);
      if (
        !row ||
        row.lease !== lease ||
        row.cancel ||
        Number(disk.bavail) * Number(disk.bsize) < 100 * 1024 ** 2
      )
        controller.abort();
      else
        store.run(
          "UPDATE jobs SET lease_until=?,updated=? WHERE id=? AND lease=?",
          Date.now() + 30000,
          Date.now(),
          job.id,
          lease,
        );
    } catch {
      controller.abort();
    }
  }, 2000);
  try {
    const result = await processor.process(
      {
        source: safeFile(store, job.source),
        destination: folder,
        metadata: JSON.parse(job.metadata),
        policy: store.policy(),
      },
      signal,
      (percent) =>
        store.run(
          "UPDATE jobs SET progress=?,updated=? WHERE id=? AND lease=?",
          Math.min(99, Math.max(0, percent)),
          Date.now(),
          job.id,
          lease,
        ),
    );
    inspectOutputs(folder, result.files);
    const outputBytes = result.files.reduce(
      (total, name) => total + fs.statSync(path.join(folder, name)).size,
      0,
    );
    if (outputBytes > store.policy().maxOutputBytes)
      throw Error("Processing output exceeds configured limit.");
    if (
      result.metadata.kind !== JSON.parse(job.metadata).kind ||
      (["video", "audio"].includes(result.metadata.kind) &&
        !result.files.includes("master.m3u8")) ||
      (result.metadata.kind === "image" && !result.files.includes("photo.webp"))
    )
      throw Error("Incomplete output");
    if (signal.aborted) throw Error("Cancelled");
    store.transaction(() => {
      const row = store.one("SELECT lease,cancel FROM jobs WHERE id=?", job.id),
        media = store.one("SELECT removed FROM media WHERE id=?", job.media_id);
      if (!row || row.lease !== lease || row.cancel || media?.removed)
        throw Error("Cancelled");
      const owner = store.one(
          "SELECT owner FROM media WHERE id=?",
          job.media_id,
        )?.owner,
        user = owner && store.user(owner),
        policy = store.policy();
      if (
        !user ||
        storageUsage(store, owner) + outputBytes > user.quota ||
        storageUsage(store) + outputBytes > policy.globalQuota
      )
        throw Error("Storage quota exceeded.");
      fs.renameSync(folder, final);
      store.run(
        "UPDATE versions SET metadata=?,mime=?,state='ready',derived=?,processing=? WHERE id=?",
        JSON.stringify(result.metadata),
        result.metadata.mime || "application/octet-stream",
        finalRelative,
        JSON.stringify({
          files: result.files,
          profiles: result.profiles,
          bytes: outputBytes,
        }),
        job.version_id,
      );
      store.run(
        "UPDATE jobs SET state='complete',progress=100,lease=NULL,lease_until=0,updated=? WHERE id=? AND lease=?",
        Date.now(),
        job.id,
        lease,
      );
      store.audit(null, "processing.complete", job.media_id, {
        version: job.version_id,
      });
    });
  } catch {
    store.transaction(() => {
      const row = store.one("SELECT lease,cancel FROM jobs WHERE id=?", job.id);
      if (row?.lease !== lease) return;
      const state = row.cancel || signal.aborted ? "cancelled" : "failed";
      store.run(
        "UPDATE jobs SET state=?,error=?,lease=NULL,lease_until=0,updated=? WHERE id=?",
        state,
        state === "failed"
          ? "Processing failed. Check source compatibility and processing configuration."
          : "Processing cancelled.",
        Date.now(),
        job.id,
      );
      store.run(
        "UPDATE versions SET state=? WHERE id=?",
        state,
        job.version_id,
      );
    });
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(folder, { recursive: true, force: true });
  }
  return true;
}
export function cancelJob(store: Store, key: string) {
  return store.transaction(() => {
    const job = store.one("SELECT * FROM jobs WHERE id=?", key);
    if (!job) throw Error("Job not found.");
    if (job.state === "queued") {
      store.run(
        "UPDATE jobs SET state='cancelled',cancel=1,updated=? WHERE id=?",
        Date.now(),
        key,
      );
      store.run(
        "UPDATE versions SET state='cancelled' WHERE id=? AND state='queued'",
        job.version_id,
      );
    } else if (job.state === "processing")
      store.run(
        "UPDATE jobs SET cancel=1,updated=? WHERE id=?",
        Date.now(),
        key,
      );
    return store.one("SELECT state,cancel FROM jobs WHERE id=?", key);
  });
}
export function retryJob(store: Store, key: string) {
  if (
    Number(
      store.one(
        "SELECT COUNT(*) n FROM jobs WHERE state IN ('queued','processing')",
      ).n,
    ) >= store.policy().maxQueuedJobs
  )
    throw Error("Processing queue is full.");
  const job = store.one("SELECT * FROM jobs WHERE id=?", key);
  if (!job || !["failed", "cancelled"].includes(job.state))
    throw Error("Choose a failed or cancelled job.");
  store.transaction(() => {
    store.run(
      "UPDATE jobs SET state='queued',cancel=0,error='',progress=0,updated=? WHERE id=?",
      Date.now(),
      key,
    );
    store.run("UPDATE versions SET state='queued' WHERE id=?", job.version_id);
  });
}
/** Only abandoned scratch files and unreferenced derivatives are eligible. Originals and retained revisions are never cache. */
export function cleanupCache(store: Store, apply = false) {
  const obsolete: string[] = [],
    cutoff = Date.now() - 86400000;
  for (const directory of ["jobs", "derived", "uploads"])
    for (const entry of fs.readdirSync(
      path.join(store.config.data, directory),
      { withFileTypes: true },
    )) {
      const file = path.join(store.config.data, directory, entry.name);
      if (entry.isSymbolicLink() || fs.statSync(file).mtimeMs > cutoff)
        continue;
      if (
        directory === "jobs" &&
        entry.isDirectory() &&
        !store.one(
          "SELECT id FROM jobs WHERE id=? AND state IN ('queued','processing')",
          entry.name.slice(0, 36),
        )
      )
        obsolete.push(path.join(directory, entry.name));
      if (
        directory === "derived" &&
        entry.isDirectory() &&
        !store.one(
          "SELECT id FROM versions WHERE derived=?",
          path.join(directory, entry.name),
        )
      )
        obsolete.push(path.join(directory, entry.name));
      if (directory === "uploads" && entry.isFile()) {
        const upload = store.one(
          "SELECT state,lease_until FROM uploads WHERE id=?",
          entry.name.slice(0, 36),
        );
        if (
          upload &&
          ["complete", "cancelled"].includes(upload.state) &&
          upload.lease_until < Date.now()
        )
          obsolete.push(path.join(directory, entry.name));
      }
    }
  if (apply)
    for (const relative of obsolete)
      fs.rmSync(path.join(store.config.data, relative), {
        recursive: true,
        force: true,
      });
  return obsolete;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const store = new Store(configuration()),
    processor = new NativeProcessor(store.config),
    stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => stop.abort());
  try {
    while (!stop.signal.aborted) {
      const policy = store.policy();
      const work = await Promise.all(
        Array.from({ length: policy.concurrency }, () =>
          runJob(store, processor, stop.signal),
        ),
      );
      if (work.every((v) => !v))
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } finally {
    store.close();
  }
}
