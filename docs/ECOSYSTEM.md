# KagNode installation and updates

The keyboard-only [KagNode CLI](https://github.com/every-lemon/kagnode-cli) provides
`kagnode setup` and scriptable `kagnode apps` commands. Its
[ecosystem guide](https://github.com/every-lemon/kagnode-cli/blob/main/docs/ECOSYSTEM.md)
covers prerequisites, supported adapters, service setup and recovery.

New managed applications use `/srv/kagnode/<app>/` with separate code releases,
configuration, data, logs and backups. A custom root is supported. Existing native
paths and package identities stay compatible. Consolidation is a separate explicit,
journaled operation with retained originals; an update never moves live data.

Local administrators can check and review updates in the account/settings panel.
The CLI manager must first authorize the local service UID with `apps enable-panel`.
The app uses its own Unix socket; the manager is not exposed on a TCP port.
Local administrator checks and CSRF protections still apply when KagNode Account
profile synchronization is disabled. Setting `KAGNODE_ECOSYSTEM_ROOT` selects the
same manager root as the CLI.

The panel never accepts a shell command or arbitrary repository URL. It checks a
fixed KagNode repository, pins the reviewed release ID and validates published
checksums. Mail and HTTP Boot require compatible native guards; VPN retains signed
native release validation. Native network provisioning and boot-image publication
remain separate operations. A GitHub packaging preview is not proof of native
service/hardware compatibility.

No live installation is migrated or updated simply by installing these source
changes. Tests use isolated fixtures and mocked service operations. Keep backups
and inspect the recorded operation if an update fails; databases are not silently
rolled back after a candidate may have changed them.
