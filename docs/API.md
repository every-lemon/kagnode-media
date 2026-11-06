# API v1

APIs use the same server session as the web UI. There are no application tokens in this preview. Fetch `/api/v1/session` for the signed-in account summary and CSRF token. Supply `X-CSRF-Token` for writes; send cookies to the configured same origin. Account creation/sign-in are ordinary protected HTML forms. Failures return `{error:{message,status}}` for API routes.

| Method and path | Purpose / permission |
| --- | --- |
| GET `/api/v1/media` | Public catalog; `q`, `kind`, `category` filters |
| GET `/api/v1/media/:id` | Visible published media, or an owner/admin draft selected by `version` |
| GET/HEAD `/api/v1/media/:id/raw` | Protected original, optional `download=1`, single HTTP Range |
| GET `/api/v1/media/:id/thumbnail` | Protected artwork/thumbnail |
| GET `/api/v1/media/:id/versions/:version/streams/:name` | Version-specific HLS playlists/segments or photo derivative |
| POST `/api/v1/media/:id/metadata` | Creator/admin, `{version,metadata}`, optimistic draft check |
| POST `/api/v1/media/:id/publication` | Creator submit or admin approve, `{version,action,note?}` |
| DELETE `/api/v1/media/:id` | Owner/admin recoverable removal |
| POST `/api/v1/media/:id/restore` | Owner/admin restoration without republishing |
| POST `/api/v1/media/:id/favorite` | Signed-in user, `{favorite:boolean}` |
| POST `/api/v1/media/:id/progress` | Signed-in user, `{position:number}` in seconds |
| POST `/api/v1/media/:id/reports` | Signed-in user, `{reason:string}` |
| POST `/api/v1/uploads` | Creator, `{filename,size,metadata,mediaId?}`; reserve quota |
| GET `/api/v1/uploads/:id` | Owner/admin offset and state |
| PUT `/api/v1/uploads/:id` | Owner creator; binary body, Content-Length, Content-Range `bytes START-END/TOTAL` |
| POST `/api/v1/uploads/:id/complete` | Owner creator; finish and queue processing |
| DELETE `/api/v1/uploads/:id` | Owner/admin; cancel incomplete upload |
| GET `/api/v1/jobs` | Creator-owned jobs or administrator's list |
| POST `/api/v1/jobs/:id/cancel` | Owner/admin cancellation |
| POST `/api/v1/jobs/:id/retry` | Owner/admin failed/cancelled job |

Metadata requires `title`, `kind` (`video/audio/image/file`), `category` (`movie/series/video/music/photo/file`), `visibility` (`public/unlisted/private`) and `delivery` (`viewer/inline/download`). Optional fields include description, comma-separated/array tags, collection ID, image artwork version, season and episode. Kind and category must match.

Publication and version editing use the same version-checked domain functions as the creator/administrator forms. See the publication endpoints in `src/app.ts`; administrative approval is separate from creator submission. Store raw originals outside static roots. A default link behavior is not a grant to bypass publication or global delivery policy.
