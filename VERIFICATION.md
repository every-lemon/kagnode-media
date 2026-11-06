# Preview verification

This source preview was built and type-checked on Node.js 24. Automated isolated tests cover current-account creator approval, forged-role rejection, resumable offsets/interrupted chunks, quota reservation, repeated completion, publication/revision permissions, original and derivative access, Range/HEAD delivery, disabled delivery modes, private/unlisted discovery, cancellation/restart recovery, malicious paths/playlists, CSRF, template routes and safe cache cleanup.

Processing tests inject a fake `Processor` that writes explicitly fictional derivative bytes. They **do not** execute FFmpeg/ffprobe, transcode, decode, verify hardware, or establish codec compatibility. Browser checks cover layout and controls, not real-media playback compatibility. Production usage, sustained upload load, hardware acceleration, image-format compatibility and encoding quality remain unverified.

No Media Server was deployed to the user's machines. This is a source preview, not a stable release. A future qualification should use expendable sample media, an isolated unprivileged worker, storage/resource limits and the exact intended FFmpeg/driver build. Record those results before claiming support.
