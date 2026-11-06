# Installing the preview

These are instructions for a future installation. This repository's validation did not install a service or run native processing. Review the verification limits before using real media.

## Prerequisites

Use a supported Linux host, Node.js 24, local storage with free space for originals **and** derivatives, and an HTTPS reverse proxy. Install FFmpeg/ffprobe separately if processing video/audio. The worker also uses Sharp for photo derivatives. Check the licenses of your installed codecs and FFmpeg distribution.

Create a dedicated unprivileged `kagnode-media` system account. Keep source at `/opt/kagnode/media`, configuration at `/etc/kagnode/media.env` (root-owned, mode 0640, readable by the service group), and data at `/var/lib/kagnode/media` (service-owned, mode 0700). Do not place originals inside `public/` or expose the data directory from Nginx.

```sh
npm ci
npm run build
```

Copy `packaging/media.env.example` to your private configuration. Set `PUBLIC_URL` to the exact HTTPS origin, `HOST=127.0.0.1` and an unused `PORT`. No KagNode production origin is assumed. Start both processes with that environment; systemd loads the environment file directly.

Create the first administrator with the command below **as the service account with the same environment as the service**. Read the password privately; do not put it in command arguments, source or shell history.

```sh
read -r -s -p 'Administrator password: ' MEDIA_ADMIN_PASSWORD; echo
printf '%s\n' "$MEDIA_ADMIN_PASSWORD" | node dist/cli.js admin-create admin@example.com 'Administrator' --password-stdin
unset MEDIA_ADMIN_PASSWORD
```

No default administrator or password is shipped. The local `password-reset EMAIL --password-stdin` recovery command revokes existing sessions and records an audit event. There is no email/password recovery delivery in this preview.

## Native Linux services

Review `packaging/kagnode-media.service` and `packaging/kagnode-media-worker.service`. Adjust the Node executable path to your installation; retain the dedicated user and write restrictions. Enable them only when you are ready to run the preview. Stopping the web process does not stop the worker: administer them separately.

The web unit binds loopback; the worker is denied IP networking and needs no public port. Defaults allow one job and two processing threads. Tune memory/CPU limits for your host and leave room for upload originals plus all selected renditions. Service memory limits are not evidence that any particular source will encode successfully.

VAAPI/QSV may need `SupplementaryGroups=render video` in a local systemd override. NVENC needs compatible NVIDIA drivers/device access. The application provides controlled argument profiles, **not hardware autodetection or verified support**. Software mode needs libx264 and AAC support. See the [official FFmpeg manual](https://ffmpeg.org/ffmpeg.html). Failed profiles remain failed until an administrator corrects configuration and retries them.

## Reverse proxy

Example fragment, to adapt inside your HTTPS server:

```nginx
location / {
    proxy_pass http://127.0.0.1:8100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    client_max_body_size 17m;
    proxy_read_timeout 65s;
}
```

Forward the original Host. The server rejects hosts other than the configured public origin. Authentication/CSRF are same-origin, with secure cookies for HTTPS. It deliberately does not trust arbitrary forwarded headers. If you later enable trusted proxy IP handling, configure an exact proxy address and retest rate limiting first; the default rate limit may count a whole proxy as one source.

Uploads use chunks of up to 16 MiB, independently of the item size limit. Do not raise proxy limits to the full original size unnecessarily. No mail server, Discord integration or KagNode account credentials are needed.

## Local library imports

Set `LIBRARY_ROOTS` to a JSON array of absolute local directories the administrator intentionally allows. Keep them read-only to the service where practical. Files are copied through the upload quota path; they are never served directly from their library path. Symlinks and traversal outside these roots are rejected. The preview scanner limits recursion to eight levels and 10,000 files. Imports are administrator-only and execute in the web process; large libraries should be added in small batches.

## First publish

1. A viewer requests creator access from Account.
2. An administrator approves the creator and assigns quota. Trusted publishing is a separate permission.
3. The creator uploads, edits metadata and waits for processing.
4. An ordinary creator submits the exact ready revision. An administrator approves it, or returns it with a reason. Trusted creators can publish directly.
5. Share `/m/ITEM_ID`. Its default behavior follows the creator's choice and the current administrator policy.

Cancel a job from Processing. Failed or cancelled jobs can be retried. A removal withdraws discovery and every delivery endpoint while retaining originals/revisions. Restoring does not silently republish. Previously downloaded copies cannot be recalled.
