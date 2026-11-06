/** Local processing. Tests inject Processor fakes and never execute these tools. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import type { Config } from "./config.js";
import type {
  Processor,
  ProcessingInput,
  ProcessingResult,
  Profile,
  Policy,
} from "./types.js";
import { MediaError } from "./errors.js";
const formats =
  "mov,matroska,webm,avi,mpegts,mpegvideo,mp3,flac,wav,ogg,aac,ac3";
export function inputArgs(source: string) {
  return [
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    formats,
    "-max_alloc",
    "268435456",
    "-i",
    source,
  ];
}
export function encodingArgs(policy: Policy, profile: Profile) {
  const scale = `scale=w=min(${profile.width}\\,iw):h=min(${profile.height}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`;
  if (policy.acceleration === "vaapi")
    return [
      "-vaapi_device",
      policy.device,
      "-vf",
      scale + ",format=nv12,hwupload",
      "-c:v",
      "h264_vaapi",
    ];
  if (policy.acceleration === "qsv")
    return [
      "-init_hw_device",
      `vaapi=va:${policy.device}`,
      "-init_hw_device",
      "qsv=hw@va",
      "-filter_hw_device",
      "hw",
      "-vf",
      scale + ",format=nv12,hwupload=extra_hw_frames=64",
      "-c:v",
      "h264_qsv",
    ];
  if (policy.acceleration === "nvenc")
    return [
      "-vf",
      scale + ",format=yuv420p",
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p4",
    ];
  return [
    "-vf",
    scale,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
  ];
}
export function execute(
  binary: string,
  args: string[],
  signal: AbortSignal,
  progress?: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new MediaError("Processing cancelled."));
    let output = "",
      errorBytes = 0,
      settled = false,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(binary, args, {
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: "C", HOME: "/nonexistent" },
    });
    const abort = () => {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {}
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 2000);
        killTimer.unref();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (progress) {
        progress(chunk.toString());
        return;
      }
      if (output.length + chunk.length > 2 * 1024 ** 2) {
        abort();
        if (!settled) {
          settled = true;
          reject(new MediaError("Processing output exceeded its limit."));
        }
      } else {
        output += chunk.toString();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 4 * 1024 ** 2) abort();
    });
    child.once("error", () => {
      signal.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        reject(
          new MediaError("The configured processing tool could not start."),
        );
      }
    });
    child.once("close", (code) => {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (signal.aborted) reject(new MediaError("Processing cancelled."));
      else if (code !== 0)
        reject(
          new MediaError(
            "The processing tool failed. Check its installation and source compatibility.",
          ),
        );
      else resolve(output);
    });
  });
}
export function inspectOutputs(folder: string, expected: string[]) {
  if (expected.length > 50000)
    throw new MediaError("Too many processing outputs.");
  if (!expected.length) return expected;
  const allowed = /^[a-z0-9][a-z0-9_.-]{0,100}$/;
  for (const name of expected) {
    if (!allowed.test(name) || name.includes(".."))
      throw new MediaError("Invalid processing output.");
    const file = path.join(folder, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
      throw new MediaError("Missing processing output.");
    if (name.endsWith(".m3u8")) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.startsWith("#EXTM3U"))
        throw new MediaError("Invalid playback playlist.");
      for (const line of text.split(/\r?\n/)) {
        if (line && !line.startsWith("#") && !expected.includes(line))
          throw new MediaError("Playlist references an unknown file.");
        if (
          /URI=/.test(line) &&
          ![...line.matchAll(/URI="([^"]+)"/g)].every((m) =>
            expected.includes(m[1]),
          )
        )
          throw new MediaError("Invalid playlist URI.");
      }
    }
  }
  return expected;
}
export class NativeProcessor implements Processor {
  constructor(private config: Config) {}
  async process(
    input: ProcessingInput,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ): Promise<ProcessingResult> {
    fs.mkdirSync(input.destination, { recursive: true, mode: 0o700 });
    const metadata = { ...input.metadata };
    let profiles: string[] = [];
    if (metadata.kind === "image") {
      const image = sharp(input.source, {
          limitInputPixels: 80000000,
          animated: false,
        }),
        info = await image.metadata();
      if (!info.width || !info.height)
        throw new MediaError("Image dimensions unavailable.");
      metadata.width = info.width;
      metadata.height = info.height;
      metadata.mime =
        (
          {
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
            gif: "image/gif",
            avif: "image/avif",
          } as Record<string, string>
        )[info.format || ""] || "application/octet-stream";
      await image
        .clone()
        .rotate()
        .resize({
          width: 600,
          height: 600,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(path.join(input.destination, "thumbnail.webp"));
      await image
        .clone()
        .rotate()
        .resize({
          width: 2400,
          height: 2400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 90 })
        .toFile(path.join(input.destination, "photo.webp"));
      progress(95);
    } else if (metadata.kind === "file") {
      metadata.mime = "application/octet-stream";
      progress(95);
    } else {
      const probe = JSON.parse(
        await execute(
          this.config.ffprobe,
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            formats,
            "-max_alloc",
            "268435456",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            input.source,
          ],
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        ),
      );
      const video = probe.streams?.find(
          (s: any) => s.codec_type === "video" && !s.disposition?.attached_pic,
        ),
        audio = probe.streams?.find((s: any) => s.codec_type === "audio");
      if (
        (metadata.kind === "video" && !video) ||
        (metadata.kind === "audio" && !audio)
      )
        throw new MediaError("The source does not match its media type.");
      const duration = Number(
        probe.format?.duration || video?.duration || audio?.duration,
      );
      if (!Number.isFinite(duration) || duration <= 0 || duration > 43200)
        throw new MediaError(
          "Use media with a duration between zero and twelve hours.",
        );
      metadata.duration = duration;
      const format = String(probe.format?.format_name || "");
      metadata.mime =
        metadata.kind === "video"
          ? format.includes("mov")
            ? "video/mp4"
            : format.includes("webm")
              ? "video/webm"
              : "application/octet-stream"
          : format.includes("mp3")
            ? "audio/mpeg"
            : format.includes("flac")
              ? "audio/flac"
              : format.includes("ogg")
                ? "audio/ogg"
                : format.includes("wav")
                  ? "audio/wav"
                  : format.includes("mov")
                    ? "audio/mp4"
                    : "application/octet-stream";
      let master = "#EXTM3U\n#EXT-X-VERSION:3\n";
      if (video && metadata.kind === "video") {
        metadata.width = Number(video.width);
        metadata.height = Number(video.height);
        if (
          metadata.width! > 8192 ||
          metadata.height! > 8192 ||
          metadata.width! < 1 ||
          metadata.height! < 1
        )
          throw new MediaError("Video dimensions exceed the supported limit.");
        const configured = input.policy.profiles.filter(
          (p) => p.height <= metadata.height!,
        );
        const selected = configured.length
          ? configured
          : [input.policy.profiles[0]];
        for (let index = 0; index < selected.length; index++) {
          const profile = selected[index],
            variant = profile.id + ".m3u8",
            hardware =
              input.policy.acceleration === "vaapi"
                ? ["-vaapi_device", input.policy.device]
                : input.policy.acceleration === "qsv"
                  ? [
                      "-init_hw_device",
                      `vaapi=va:${input.policy.device}`,
                      "-init_hw_device",
                      "qsv=hw@va",
                      "-filter_hw_device",
                      "hw",
                    ]
                  : [];
          const codec = encodingArgs(input.policy, profile);
          if (hardware.length) codec.splice(0, hardware.length);
          const args = [
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            ...hardware,
            ...inputArgs(input.source),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            ...codec,
            "-b:v",
            String(profile.bitrate),
            "-maxrate",
            String(profile.bitrate),
            "-bufsize",
            String(profile.bitrate * 2),
            "-g",
            "48",
            "-keyint_min",
            "48",
            "-sc_threshold",
            "0",
            "-force_key_frames",
            "expr:gte(t,n_forced*4)",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ac",
            "2",
            "-threads",
            String(input.policy.threads),
            "-progress",
            "pipe:1",
            "-nostats",
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_playlist_type",
            "vod",
            "-hls_segment_filename",
            path.join(input.destination, profile.id + "-%05d.ts"),
            path.join(input.destination, variant),
          ];
          await execute(this.config.ffmpeg, args, signal, (text) => {
            const match = /out_time_us=(\d+)/.exec(text);
            if (match)
              progress(
                5 +
                  ((index + Number(match[1]) / 1000000 / duration) /
                    selected.length) *
                    80,
              );
          });
          profiles.push(profile.id);
          master += `#EXT-X-STREAM-INF:BANDWIDTH=${profile.bitrate + 160000}\n${variant}\n`;
        }
        await execute(
          this.config.ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            ...inputArgs(input.source),
            "-ss",
            String(Math.min(1, duration / 2)),
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            path.join(input.destination, "thumbnail.jpg"),
          ],
          signal,
        );
      } else {
        await execute(
          this.config.ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            ...inputArgs(input.source),
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-threads",
            String(input.policy.threads),
            "-f",
            "hls",
            "-hls_time",
            "4",
            "-hls_playlist_type",
            "vod",
            "-hls_segment_filename",
            path.join(input.destination, "audio-%05d.ts"),
            path.join(input.destination, "audio.m3u8"),
          ],
          signal,
        );
        profiles = ["audio"];
        master += "#EXT-X-STREAM-INF:BANDWIDTH=224000\naudio.m3u8\n";
      }
      fs.writeFileSync(path.join(input.destination, "master.m3u8"), master, {
        mode: 0o600,
      });
      progress(95);
    }
    const files = fs.readdirSync(input.destination);
    inspectOutputs(input.destination, files);
    return { metadata, files, profiles };
  }
}
