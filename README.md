<p align="center"><img src="assets/kagnode-wordmark.svg" width="440" alt="KagNode."></p>

# KagNode Media

## Overview

Source preview of self-hosted video, audio, photo and album publishing.

## Release status

Product source: **0.1.0-preview.2**. Packaging preview: **0.1.0-preview.2.packaging.11**.

Packaging prereleases do not change the latest stable release or establish new hardware or service compatibility. See [verification](docs/VERIFICATION.md) and [changelog](CHANGELOG.md).

## Features

- Shared local sign-in and explicit Login with KagNode; local access and security requirements stay available. See [account sign-in](docs/ACCOUNT-SYNC.md).

- Viewer, creator and administrator accounts with review-based publishing.
- Resumable uploads, catalog browsing, access-controlled delivery and playback progress.
- Separate persistent processing worker with bounded jobs and cancellation.

Optional KagNode Account linking syncs your display name and photo after explicit approval. Your local application administrator can disable it. Local sign-in and permissions stay independent.

## Requirements

Node.js 24, SQLite and filesystem storage. Native media processing requires a compatible FFmpeg build and separate verification.

## Installation and downloads

Download from [GitHub Releases](https://github.com/every-lemon/kagnode-media/releases). Verify `SHA256SUMS` before extracting or installing a package.

| Payload | Formats | Support |
| --- | --- | --- |
| Complete source / artwork | `.tar.xz`, `.tar.gz`, `.zip` | Named top-level directory; manual setup |
| Source preview | `.deb` | Source only; does not provision a service |
| Source preview | `.rpm` | Rocky Linux 10 packaging preview; native services unverified |



Source packages install under `/usr/share/kagnode/`; they do not replace an existing application, migrate data, start services or configure networking.  See [package details](docs/PACKAGING.md).

## Usage

```sh
npm ci
npm run build
# Configure the server using docs/SETUP.md before starting it.
```

See [operations and existing setup instructions](docs/OPERATIONS.md) for the full workflow and its prerequisites.

## Configuration and storage

Shared presentation uses [KagNode Core](docs/CORE.md), with a pinned local fallback and reviewed server adapters. Compatible stable UI patches have a separate local-administrator policy.

Originals, databases and worker output stay outside public assets. No processing worker or transcoding is started by the preview packages.

## Security

Use HTTPS and least-privilege accounts for hosted services. Keep secrets and user data out of Git. Preview packages are for inspection and controlled testing; native service and hardware claims remain limited to recorded verification. See [security guidance](docs/SECURITY.md).

## Development and testing

```sh
npm run check
npm test
npm run build
python3 scripts/repository_check.py
python3 scripts/format_source.py --check
python3 scripts/release.py --output dist/packages
```

Install the formatting dependencies from `requirements-format.txt`. Package building additionally needs `dpkg-deb`, `rpmbuild`, XZ support and, for CLI binaries, Go. Read [the repository map](docs/STRUCTURE.md) before editing generated files.

## Documentation

- [Ecosystem installation and updates](docs/ECOSYSTEM.md)

- [Repository structure](docs/STRUCTURE.md)
- [Operations](docs/OPERATIONS.md)
- [Packages and release process](docs/PACKAGING.md)
- [Verification and limits](docs/VERIFICATION.md)
- [KagNode Account linking](docs/ACCOUNT-SYNC.md)
- [Changelog](CHANGELOG.md)

## Licensing

See [LICENSE](LICENSE) and retained third-party notices. KagNode artwork retains its separate permission and brand policy; the application uses AGPL-3.0-only.
