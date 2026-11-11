# Packages and releases

Run `python3 scripts/release.py --identity` to inspect the single product-version resolver and packaging revision. The reviewed `stable` channel uses final `v<product-version>` tags and plain package versions. The optional preview channel retains `packages/v<packaging-version>` prereleases. Historical releases and assets remain immutable.

`python3 scripts/release.py --output dist/packages` requires an empty destination. It builds allowlisted source/artwork archives, a Debian source/data package and a Rocky Linux 10 source/data RPM. CLI also builds amd64/arm64 static binaries and their archives and packages. Source packages are not native installers: no post-install service setup, firewall changes or data migration is performed. Source RPMs intentionally have no runtime dependencies because they are inspection/manual-build payloads, not runnable services.

Native package identities and specialized existing workflows remain unchanged.

Each archive has a named top-level directory. TAR timestamps/ownership and ZIP metadata are normalized using SOURCE_DATE_EPOCH (default: commit timestamp). `release-manifest.json` records product/release versions, source commit, sizes and hashes; SHA256SUMS covers all distributable files and that manifest. VPN's existing signed native manifest is separate and must not be overwritten by this packaging manifest.

For Debian source/data packages use `sudo apt install ./<package>.deb`; for RPM source/data packages use `sudo dnf install ./<package>.rpm` in an isolated Rocky Linux 10 environment. Inspect files under /usr/share/kagnode. Removal deletes only package-owned source/data files; user data lives elsewhere. CLI executable packages install /usr/bin/kagnode and preserve XDG credentials on removal.

Release automation builds and checks payloads before publishing the configured channel. The stable channel rejects prerelease product versions. Existing release assets and installers are retained. These packages do not claim native Rocky Linux service operation, Media codecs/GPU validation, HTTP Boot image qualification or broader native-service qualification.

The package lifecycle check installs the recorded historical source-package version, upgrades to the new version, removes it, and checks that unrelated fixture user data remains. Package names and installed source directories are unchanged. Source/data package installation never adopts a new Core binding or upgrades a running application automatically.
