# Optional KagNode Account profiles

Sign in to the application locally, then open Account/Settings preferences and choose Link KagNode Account. Open the displayed KagNode address, compare the code and approve the specific installation. New explicit consent shares your display name, stable profile identifier, photo and optionally a verified contact email. Existing profile-only grants remain unchanged. Passwords, mailbox access, vault encryption and local administrator roles stay separate. Accounts are never matched automatically by email.

A local administrator can turn sync off for the whole installation. This clears local profile links and stops profile requests. Users retain local sign-in. Remote revocations are attempted with a bounded request; failed disconnections remain in a private retry queue visible to local administration. Turning sync back on requires each user to link again. You can also revoke a connection in KagNode Account → Connections → Self-hosted applications.

Set KAGNODE_ACCOUNT_SYNC=off in the server's process environment to enforce disabled mode. Set KAGNODE_ACCOUNT_ISSUER to the exact HTTPS KagNode Account origin when migrating domains. Changing issuer clears old links and disables sync until a local administrator re-enables it; old tokens are never sent to the new origin. No callback hostname, incoming port or application secret needs to be registered: the user approves a short-lived code in KagNode Account.

Local applications store refresh credentials only in private server-side storage. The browser receives profile data and a user code, never a KagNode access/refresh token. Polling is bounded, refreshes are serialized, profile refresh occurs at most once per fifteen minutes per link, and offline errors keep local accounts available. Only still WebP profile photos are accepted by the connection UI.

Mail administrators use the existing local administrator confirmation. Authenticator assigns profile-sync administration to the retained legacy vault owner, or the first local account when there is no migrated owner; KAGNODE_ACCOUNT_ADMIN can specify a local account ID. This permission does not grant access to other encrypted vaults. VPN's local owner controls installation policy; HTTP Boot's private console credential controls its administrator profile. CLI is controlled by its local operating-system owner using `kagnode account sync on|off|status`; its existing account sign-in supplies the profile, and its browser examples provide the same preference.

The new issuer endpoints are POST /api/v1/account-sync/device, POST /api/v1/account-sync/token, GET /api/v1/account-sync/profile?client_id=PROJECT and POST /api/v1/account-sync/revoke. They must exist on the configured KagNode Account server before linking succeeds. Local web controls use the app's existing session/CSRF mechanisms; Media versions them under /api/v1/kagnode-account.

This source preview uses isolated local-account and issuer fixtures for its profile and sign-in checks; no production account approval is part of the tests. Packaging does not deploy the updated KagNode Account server, application servers or any native service. Logos and the downloaded artwork viewer remain account-free.

## Connection recovery

A pending connection keeps its confirmation code and remaining lifetime after reloading the page or reopening the server-side store. Only that local account can read its pending confirmation details; device and profile credentials are never returned to the browser. Cancel linking stops the current attempt without disconnecting an established profile. If another tab has started a newer attempt, a stale cancellation is rejected.

The panel shows retry controls for failed loads and ignores late responses after a newer action. If issued credentials must be discarded while KagNode is unreachable, their revocation stays in the private retry queue. Local administrators can retry those disconnections from installation settings. Local sign-in, permissions and stored application data remain independent.

## Application update recovery

The local-administration update panel shows recovery details and metadata filenames returned by KagNode CLI. Recovery, an active local operation or `can_apply: false` prevents an install action. A release check may replace a damaged candidate cache; installation state and operation records require administrator review rather than automatic deletion. New managers supply lock-backed `in_progress`; older managers retain phase-based display compatibility. Ordinary users receive no update controls.

## Login with KagNode preview

The shared Core sign-in frame keeps the application’s local form. Login with KagNode starts a fresh, browser-bound device confirmation with a random nonce. Compare the installation and requested permissions on KagNode before approving. A profile refresh is not a sign-in proof. The server checks the approved issuer, immutable subject, client, installation, purpose, nonce, timestamps and local policy before continuing.

New consent can include `profile.read email.read`: display name, photo and a currently verified contact email. Existing profile-only grants do not gain email access. The contact email is a profile display field; existing local login names, mailbox addresses, permissions and encrypted data are not silently changed. Accounts are never merged by matching email.

Media creates a viewer for a first-time verified subject only while local registration is enabled. New viewers have no approved creator status, no trust elevation, and the installation’s normal storage quota. Registration disabled means only existing linked accounts can sign in. An email collision requires explicit local linking. Provider-created viewers can set a local password from Account for offline sign-in; this never weakens the current-password requirement for accounts that already have one.

A local administrator can disable profile synchronization and provider sign-in. Local sign-in remains available without KagNode, including when the issuer is offline. Cancel, expiry, policy changes and concurrent attempts cannot authorize a stale browser result. Anonymous attempts are bounded by expiry, one active attempt per browser, a global pool limit and start-rate limits. Polling is serialized; an ambiguous token exchange must be restarted instead of replayed.

Provider access/refresh credentials stay in private server storage. The browser receives a confirmation code, a short-lived opaque attempt identifier and the application’s own continuation/session, never the provider credentials. Anonymous CSRF state is bound to the browser; Python applications persist the CSRF signing secret privately so multiple workers and restarts agree. Do not delete the profile database during an update. Back up it alongside existing application data, preserve ownership and permissions, and retain the previous source for rollback.

The issuer must support the additive `/api/v1/account-sync/device` sign-in purpose, first-exchange authorization proof, optional verified-email scope and `/device/cancel`. An older issuer fails closed: local sign-in stays available. No incoming callback port or browser access to GitHub is required. Core assets and the fallback are served locally; changing a Core minor baseline is an explicit reviewed application upgrade, not an automatic UI patch.
