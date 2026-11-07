import http from "node:http";
import path from "node:path";
import { MediaError } from "./errors.js";

/** Runs through the local manager socket; never accepts a command or URL from a browser. */
export async function manageUpdate(action: string, data: any = {}) {
  if (!["state", "check", "apply"].includes(action))
    throw new MediaError("Unknown update action.");
  if (
    action === "apply" &&
    (!Number.isSafeInteger(data.release_id) || data.release_id <= 0)
  )
    throw new MediaError("Check for updates before installing a release.");
  const root = process.env.KAGNODE_ECOSYSTEM_ROOT || "/srv/kagnode";
  if (!path.isAbsolute(root))
    throw new MediaError("The installation root must be absolute.");
  return new Promise<Record<string, any>>((resolve, reject) => {
    const body = JSON.stringify({
      action,
      ...(action === "apply" ? { release_id: data.release_id } : {}),
    });
    const request = http.request(
      {
        socketPath: path.join(root, "run/media.sock"),
        path: "/",
        method: "POST",
        timeout: 60_000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) request.destroy(new Error("Large response"));
          else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new MediaError("Update status could not be read.", 502)),
        );
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if ((response.statusCode || 500) >= 400)
              reject(
                new MediaError(String(value.error || "Update request failed.")),
              );
            else resolve(value);
          } catch {
            reject(new MediaError("Invalid update status.", 502));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Timed out")));
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (
        action === "state" &&
        ["ENOENT", "ECONNREFUSED"].includes(error.code || "")
      )
        resolve({
          enabled: false,
          message:
            "Enable this application’s update panel with KagNode CLI on the server.",
        });
      else
        reject(
          new MediaError("The local update manager could not be reached.", 503),
        );
    });
    request.end(body);
  });
}
