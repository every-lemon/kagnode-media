# Verification boundaries

CI validates the existing application checks separately from source formatting, source publication allowlists and archive/package inspection. The packaging workflow produces checksums and source-commit provenance. Debian and RPM source/data packages have no service-start scripts; installation/removal validation does not establish native service compatibility.

The 5.0 RPM source/data packages target Rocky Linux 10; their install, upgrade and removal checks do not qualify native services. Native Mail, VPN and HTTP Boot setup remains unverified there. Media worker, FFmpeg, codecs and hardware acceleration are not exercised by packaging tests. No Client image or qualification VM is built for this work. Existing verification documents remain authoritative for previously recorded checks.

The shared login frame is rendered or generated from the exact reviewed Core template. Browser coverage uses disposable app state and fictional accounts on Chromium/WebKit at phone, tablet and desktop widths. Provider tests cover local fallback, cancellation, unavailable issuer, explicit completion, profile policy and local roles. Mail requires real mailbox credentials, Passwords requires the master password, VPN retains local second factor, and HTTP Boot retains console-owner authorization. There are no production sign-ins or real provider approvals in these checks.
