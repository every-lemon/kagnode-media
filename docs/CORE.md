# KagNode Core integration

This application uses [KagNode Core](https://github.com/every-lemon/kagnode-core) for its sidebar, controls, scrolling, loading and account presentation. Its committed `core.lock.json` records the baseline and compatible stable UI patch line. Editable corresponding Core source is retained under `vendor/core-source/`; generated pinned fallbacks let the interface start offline.

Application servers serve Core assets from their own origin. Browsers never fetch Core scripts from GitHub. Local accounts retain local sign-in and permissions. Appearance can connect directly to KagNode Account using a separate browser-only appearance grant; profile linking remains a distinct administrator setting.

Only stable compatible UI patches may install automatically. Backend helpers, prereleases, minor/major versions and application updates require review. A Core patch cannot restart a service or run a backend hook. The local administrator sees status, update policy and rollback in settings. Use `sudo kagnode core bind media --user SERVICE_USER --baseline 5.0.6` to bind the service and run the manager described in [Core operations](https://github.com/every-lemon/kagnode-core/blob/main/docs/OPERATIONS.md). Ordinary users cannot manage updates.

KagNode 5 provides the shared web presentation. Its stable source/data release does not establish new native-service, codec, HTTP Boot image or network-hardware qualification. Keep application databases and deployment configuration in their existing locations. No data reset or native provisioning is part of Core integration.

## Shared loading mark

Core supplies KagNode’s split-orbit spinner. The canonical logo stays still while its separated accent orbits. Reduced-motion settings stop the animation. Existing loading labels, retries and dismissal controls remain available. The server serves the spinner and artwork locally; no browser Core connection to GitHub is required.

## Reviewed adapter upgrade

HTML pages receive shared components; JSON and plain-text responses remain byte-preserved even when media metadata contains literal HTML syntax. The compatible automatic UI range is 5.0.x. Backend helpers still require review, and an automatic UI patch cannot update this server adapter. Media remains a source-only integration; no deployment or native media processing is part of this change.

## Binding and reviewed application upgrades

The explicit baseline above matches this source’s pinned fallback; do not rely on an older manager’s implicit 1.0.x default. With Core manager 1.2.0 or newer, prefer `--lock-file /path/to/app/core.lock.json` instead of `--baseline` to read the adapter version and automatic-update preference from the reviewed application declaration. Existing bindings are retained by `bind`. Follow the [reviewed application upgrade workflow](https://github.com/every-lemon/kagnode-core/blob/main/docs/OPERATIONS.md#reviewed-application-upgrades) to adopt a changed baseline explicitly after verifying current UI rollback assets and retaining the app’s source/data backup. Web UI patch controls cannot perform a minor or major baseline adoption.

## Shared sign-in frame

The reviewed baseline is Core **5.0.6**, including the common sign-in card, browser sign-in continuation and viewport-clamped account menu. The host keeps its existing local form, CSRF policy, role checks and any required mailbox/vault password or second factor. Core receives only app-owned continuation state, never provider access/refresh credentials.

`window.KagNodeLoginHost` supplies the application’s same-origin start/status/cancel operations; Core handles presentation, browser return, focus, cancellation and stale responses. Local fallback remains usable when KagNode is unavailable. Provider identity and appearance synchronization are separate grants. The exact readable source, generated offline SDK and lock are included together. Existing deployed bindings require explicit reviewed baseline adoption after backup and acceptance; no prerelease manager bypass or automatic minor upgrade is permitted.

## KagNode 5 baseline

Core **5.0.6** supplies the canonical login template, field and action styling, original icon geometry, responsive navigation and browser sign-in continuation. The application retains only its local form content and behavior hooks. The readable pinned template and generated offline SDK are included. Existing installations require an explicit reviewed major-baseline adoption; the update manager never applies a major upgrade automatically. Appearance remains in account/settings, and signed-out pages follow system appearance.

## Update summaries

After a supported manager successfully applies an automatic compatible stable UI update, authenticated local users can read its sanitized summary. Dismissal requires the existing CSRF or console bearer/same-origin boundary and is stored per immutable local identity. Administrators may disable update summaries independently of automatic updates. Pending candidates, failed/no-op/manual changes and older unsupported helpers do not produce invented notices. Backend helpers, schemas and SDKs require a separate explicit reviewed application upgrade.

The optional update-summary adapter and manager capability in Core 5.0.6 require an explicitly reviewed application/helper upgrade. Automatic UI updates cannot install this backend capability or change an application database.
