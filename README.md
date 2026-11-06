<picture><source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-white.svg"><img src="assets/wordmark.svg" width="260" alt="KagNode."></picture>

# KagNode Media

A self-hosted library for videos, movies, series, music and photos. Browse a catalog, keep favorites and playback progress, and publish from an approved creator account.

**Source preview · 0.1.0-preview.1.** This is the first implementation, not a stable release. Automated checks use isolated stores and mocked processing outputs. FFmpeg, codecs, GPU acceleration, playback interoperability and production deployment have **not** been verified. No Media service was deployed to KagNode's machines for this release.

## What is included

- Separate viewer, approved creator and administrator accounts, with optional trusted publishing.
- Resumable streamed uploads, quota reservations, creator collections, metadata and artwork, review submissions and version history.
- Stable item links that open the Media UI, inline original or original download, within administrator delivery policy.
- Publication checks on every original, thumbnail and stream request. Originals are stored outside public assets.
- Persistent processing jobs with bounded concurrency, cancellation, progress and stale-lease recovery. A separate worker implements local ffprobe/FFmpeg and image derivatives.
- Direct playback and seeking, adaptive HLS player, photo viewing, search, filters, favorites, reports and saved playback position.
- Shared KagNode controls, custom scrolling with a native option, light/dark themes, responsive navigation and readable source.

Movies/series are video categories; music is audio; albums and series use creator-owned collections. Public catalog results are currently capped at 200 items per search. Unlisted links are omitted from discovery; private items are visible only to their creator and administrators. This preview does not implement sharing groups or anonymous private-link tokens.

Live broadcasting, billing, DRM and native TV/mobile applications are outside this release.

## Development

Node.js **24** is required. SQLite is provided by Node's `node:sqlite`; no database daemon is needed.

```sh
npm ci
npm run check
npm test
npm run build
```

Tests never invoke the native processing executables. `npm start` starts the web process; `npm run worker` starts **real local processing** and is an installation action, not a test. Use only trusted local configuration and review [setup](docs/SETUP.md) first.

- [Setup and Linux services](docs/SETUP.md)
- [Architecture and editing guide](docs/ARCHITECTURE.md)
- [Versioned API](docs/API.md)
- [Verification limits](VERIFICATION.md)
- [Security and backups](SECURITY.md)

AGPL-3.0-only. See [LICENSE](LICENSE). KagNode artwork identifies this project; code minification and asset fingerprints do not restrict the source rights granted by its license.
