# 5.0.1

- Return Login with KagNode to the initiating application through a browser-bound S256 PKCE callback.
- Use Core 5.0.5 progressive login controls while preserving local passwords, vault encryption, MFA and administrator policy.
- Reject callback state/issuer mismatches and replay; keep tokens and verifiers server-side and clear authorization query parameters before loading app resources.
- Preserve package identities, existing account links and data with additive sign-in attempt storage. Native services and images are unchanged.

# 5.0.0

- Use the canonical Core 5 login frame, fields, provider flow and action icons.
- Keep theme selection in account/settings; signed-out pages follow the system theme.
- Preserve local credentials, explicit account linking, permissions and data compatibility.
- Publish checked source/data assets with existing package identities and paths.

# 0.1.0-preview.2

- Use the locally served shared Core login frame with explicit KagNode confirmation and bounded, browser-bound sign-in attempts.
- Refresh newly consented verified contact email alongside name and photo; preserve local policy, roles and offline sign-in.
- Media creates a viewer for a first-time verified subject only while local registration is enabled. New viewers have no approved creator status, no trust elevation, and the installation’s normal storage quota. Registration disabled means only existing linked accounts can sign in. An email collision requires explicit local linking. Provider-created viewers can set a local password from Account for offline sign-in; this never weakens the current-password requirement for accounts that already have one.
- Web/source preview only; no native service or hardware qualification is implied.

## Ecosystem update panel — packaging preview 2

## Update recovery status preview

Show recovery details and metadata filenames in local administration. Suppress unsafe update actions, distinguish live operations from stale progress, preserve native-adapter guidance and clear repaired-cache warnings after a new release check.

## Account link recovery preview

Resume pending profile links after reload, provide attempt-scoped cancellation and visible retry controls, and ignore late browser responses. Retain failed cleanup of issued profile tokens for administrator retry. Preserve local sign-in, permissions and existing data.

## Declared Core binding preview

Document the pinned Core baseline explicitly for new server bindings and the reviewed application-upgrade workflow. Existing application data and stable release selections remain unchanged.

## API response integrity preview

Upgrade the reviewed Core integration to 1.1.5 so literal HTML in media titles/descriptions cannot corrupt JSON API responses. Keep raw file delivery intact and escape the same metadata in HTML pages. Processing and hardware verification remain outside this preview.

## Shared loading spinner preview

Use KagNode Core 1.0.5 for the shared split-orbit loading mark, with reduced-motion support and existing status/recovery controls retained. This changes web presentation without resetting data or provisioning native services.

## Shared UI preview 4

- Use the Core mobile drawer and loading overlay exclusively; retain application form confirmation and logout timing. Show the account email inside its popover.

## Core integration preview

Shared local UI components, manual animated navigation, natural scrolling rails and icon account menus. Added separate appearance-only account connections and signed UI patch controls. Existing storage, native services and prior release records are retained.

- Add local-administrator update checks, review and progress through KagNode CLI.
- Keep local permissions, CSRF checks, data paths and native provisioning unchanged.
- Source preview only; no new hardware qualification or native deployment claim.

# Changes

## 0.1.0-preview.1

Added independent accounts and creator review, versioned media publishing, resumable uploads, protected originals and HLS delivery, creator/admin workspaces, local processing worker, shared KagNode UI and mocked verification. Native processing and production deployment remain unverified.

## Account profile integration preview

Added optional KagNode Account display-name/photo linking, local administrator disable controls and private credential storage. Existing local account authentication and data remain independent.
