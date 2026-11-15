# KagNode Core Rust manager

This staged **5.0.12** server helper replaces the Python UI-patch manager protocol without backend hooks or application restarts. It is source for review; existing hosts retain their installed manager until native compatibility checks and a reviewed upgrade pass.

The manager downloads only `every-lemon/kagnode-core` releases, verifies the pinned Ed25519 signature and signed archive inventory, rejects symlinks and unsafe archive members, and activates verified UI assets through atomic application metadata. Old bundles remain available. Only stable `5.0.x` UI patches are automatic; beta requires an explicit policy. New bindings start in manual mode. Backend/baseline changes require an application lock declaration and explicit adoption.

## Commands

Build with Rust 1.88 or newer:

```sh
cargo build --locked --release --manifest-path packages/manager-rust/Cargo.toml
sudo kagnode-core-manager bind example --uid 123 --gid 123 --baseline 5.0.11
sudo kagnode-core-manager status example
sudo kagnode-core-manager check example
sudo kagnode-core-manager policy example --expected-revision 0 --automatic true
sudo kagnode-core-manager serve
```

Use existing service account IDs. Binding alone does not adopt application code, replace databases, or make any network service public. `--core-root` defaults to `/srv/kagnode/core`. Application adapters use protected per-application Unix HTTP sockets; the server checks the peer UID. Automatic checks run every six hours plus persisted per-application jitter. Restart recovery distinguishes committed UI activation from an interrupted download. Rollback pauses automatic patching.

Core Server Offloading is **not enabled by this helper**. Enabling it is refused until its signed delivery adapter and browser fallback are implemented and qualified. All UI assets remain same-origin by default.

## Validation

`cargo test` checks versions, release signatures, manifest contracts and HTTP framing. Run filesystem tests explicitly as root in an isolated environment to exercise ownership, hardlink/symlink rejection, policy conflicts and asset tampering. CI does this with a disposable runner. Fixtures are the public signed Core 5.0.11 UI archive and manifest; no signing key is included. Artwork remains subject to the repository's artwork guidance; implementation is AGPL-3.0-only.

Live helper replacement, cross-origin offloading, remote agents and HA activation are separate qualification gates. No application service-control API exists in this manager.
