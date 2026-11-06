# Architecture and editing

The browser talks to one Express application. SQLite stores accounts, hashed sessions, CSRF values, media/version pointers, uploads, reviews, jobs, favorites, progress, reports and audit events. Originals and derived files live under private filesystem directories. A separate worker claims jobs with expiring leases; processing results are validated and published to the database only after the complete output is ready.

## Source map

| Change | Files |
| --- | --- |
| Routes and permissions | `src/app.ts`, `src/auth.ts`, `src/media.ts`, `src/policy.ts` |
| Typed states and contracts | `src/types.ts` |
| SQLite schema and transactions | `src/database.ts` |
| Uploads and local imports | `src/uploads.ts` |
| Byte ranges and protected delivery | `src/streaming.ts` |
| Queue/recovery/cache cleanup | `src/worker.ts` |
| Native processing arguments | `src/processing.ts` |
| Page layout, sidebar and account menu | `views/layout.ejs` |
| Reusable fields and media cards | `views/components/` |
| Browse, account, creator and admin pages | Named files under `views/` |
| Theme, components and page layouts | `public/kagnode-ui.css`, `public/media.css` |
| Shared scrolling | `public/kagnode-scroll.js`, `public/kagnode-scroll.css` |
| Client controls and playback | `public/media.js`, `public/player.js` |
| Fingerprinted production build | `scripts/build-web.mjs` |

Run `npm run format`, `npm run format:check`, `npm run check`, `npm test`, then `npm run build`. Edit readable sources, not `dist/`. No source maps are served. HLS.js is bundled locally, with its upstream license retained by the build; no CDN is required.

The runtime has no shell-based processing command. Every tool invocation uses an executable plus controlled argument array, bounded output, deadlines and process-group cancellation. Supported protocol/demuxer allowlists are intentionally narrow; add new formats only with review and native verification on an isolated installation.

## Version and access rules

A media ID stays stable. `draft` points to work in progress; `published` points to the reviewed revision. Updating public metadata creates a new revision and leaves the published one unchanged. Ready processing is necessary but never sufficient for publication. Trusted publishing is checked from the current account record rather than trusting an old session role.

Every raw/thumbnail/HLS endpoint checks the parent media permission. A stream filename must occur in the version's validated output manifest; paths and symlinks cannot select arbitrary files. Private media never becomes public because an original URL was guessed. An unlisted public link is intentionally shareable but not listed in the catalog.

Job retries do not approve a publication. Upload completion is idempotent and chunk writes check offsets and leases. Crash recovery requeues expired processing leases; stale workers cannot publish results. Cleanup removes only stale scratch files, completed/cancelled upload remnants and unreferenced derivatives after a retention interval. Original files and retained versions are not a cache.
