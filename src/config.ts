import path from "node:path";
export interface Config {
  data: string;
  origin: string;
  host: string;
  port: number;
  secure: boolean;
  ffmpeg: string;
  ffprobe: string;
  libraryRoots: string[];
  testing: boolean;
}
export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = new URL(env.PUBLIC_URL || "http://127.0.0.1:8100");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error("PUBLIC_URL must be an HTTP(S) origin.");
  if (
    origin.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) &&
    env.ALLOW_INSECURE_HTTP !== "true"
  )
    throw Error("Use HTTPS for public installations.");
  const port = Number(env.PORT || 8100);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("Invalid PORT.");
  const roots = JSON.parse(env.LIBRARY_ROOTS || "[]");
  if (
    !Array.isArray(roots) ||
    roots.length > 16 ||
    roots.some((x) => typeof x !== "string" || !path.isAbsolute(x))
  )
    throw Error("LIBRARY_ROOTS must contain absolute paths.");
  return {
    data: path.resolve(env.DATA_DIR || "/var/lib/kagnode/media"),
    origin: origin.origin,
    host: env.HOST || "127.0.0.1",
    port,
    secure: origin.protocol === "https:",
    ffmpeg: env.FFMPEG || "ffmpeg",
    ffprobe: env.FFPROBE || "ffprobe",
    libraryRoots: roots,
    testing: env.NODE_ENV === "test",
  };
}
