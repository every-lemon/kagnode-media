# Security and data

Keep `DATA_DIR` private and outside the document root. Source files are public; database files, account/session secrets, uploaded originals, scratch output and live environment files are not. Use HTTPS and the exact PUBLIC_URL; no permissive cross-origin API is shipped.

Passwords use salted scrypt. Sessions store only a digest of the browser token and resolve active account permissions on each request. Writes require a server-issued CSRF value and same-origin checks. Creator approval is independent of account registration; trusted publishing is explicit. Public delivery always checks moderation and visibility.

Run the web process and worker as an unprivileged dedicated user. Native media parsers process untrusted input: keep Node, Sharp, FFmpeg and drivers patched. The supplied worker service denies IP networking and constrains memory/CPU. Root access, a hostile filesystem owner, or compromised dependencies are outside the application's isolation boundary. No malware scanning or DRM is claimed.

Back up SQLite with the SQLite backup API (or stop **both** processes before copying database and WAL files). Back up originals, derivatives and `form-secret` consistently with the database. Verify restore in an isolated directory. Never reset a database to apply a source update; this preview creates missing tables without erasing existing rows.

Removal is recoverable. Withdrawn originals and revision history remain on disk and consume quota. Cleanup never prunes retained originals. Sent/shared/downloaded external copies cannot be withdrawn. There is no automatic destructive media-retention policy.

Report a suspected vulnerability privately through the repository owner's GitHub security reporting if enabled; otherwise request a private contact without posting secrets or exploitable credentials in a public issue. No fabricated security email address is provided.
