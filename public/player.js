(() => {
  const root = document.querySelector("[data-player]");
  if (!root) return;
  const media = root.querySelector("[data-media-element]"),
    controls = root.querySelector("[data-player-controls]"),
    status = root.querySelector("[data-player-status]"),
    quality = root.querySelector("[data-player-quality]");
  const id = root.dataset.id,
    version = root.dataset.version,
    base =
      "/api/v1/media/" +
      id +
      "/versions/" +
      encodeURIComponent(version) +
      "/streams/",
    query = "?version=" + encodeURIComponent(version),
    profiles = JSON.parse(root.dataset.profiles),
    format = (n) => {
      n = Math.max(0, Math.floor(n || 0));
      return (
        (n >= 3600 ? Math.floor(n / 3600) + ":" : "") +
        String(Math.floor(n / 60) % 60).padStart(n >= 3600 ? 2 : 1, "0") +
        ":" +
        String(n % 60).padStart(2, "0")
      );
    };
  let engine = null,
    lastSave = 0;
  const Hls = window.KagNodeHls?.default || window.KagNodeHls;
  if (profiles.length) {
    if (media.canPlayType("application/vnd.apple.mpegurl"))
      media.src = base + "master.m3u8" + query;
    else if (Hls?.isSupported()) {
      engine = new Hls({
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      engine.loadSource(base + "master.m3u8" + query);
      engine.attachMedia(media);
      engine.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal)
          status.textContent =
            "Playback failed. Check the source and processing results.";
      });
    } else
      status.textContent =
        "This browser cannot play this HLS stream. Try a browser with HLS support.";
  } else media.src = "/api/v1/media/" + id + "/raw" + query;
  profiles.forEach((profile, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = profile;
    quality.append(option);
  });
  controls.hidden = false;
  media.controls = false;
  const play = root.querySelector("[data-player-play]");
  play.onclick = () =>
    media.paused
      ? media
          .play()
          .catch(() => (status.textContent = "Press Play to start playback."))
      : media.pause();
  root
    .querySelectorAll("[data-player-skip]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          (media.currentTime = Math.max(
            0,
            Math.min(
              media.duration || 0,
              media.currentTime + Number(button.dataset.playerSkip),
            ),
          ))),
    );
  root.querySelector("[data-player-volume]").oninput = (event) =>
    (media.volume = Number(event.target.value));
  root.querySelector("[data-player-seek]").oninput = (event) => {
    if (Number.isFinite(media.duration))
      media.currentTime = (Number(event.target.value) / 1000) * media.duration;
  };
  root.querySelector("[data-player-fullscreen]").onclick = () =>
    document.fullscreenElement
      ? document.exitFullscreen()
      : root.requestFullscreen?.();
  quality.onchange = () => {
    if (engine)
      engine.currentLevel =
        quality.value === "auto" ? -1 : Number(quality.value);
    else {
      const time = media.currentTime,
        wasPlaying = !media.paused;
      media.src =
        base +
        (quality.value === "auto"
          ? "master"
          : profiles[Number(quality.value)]) +
        ".m3u8" +
        query;
      media.addEventListener(
        "loadedmetadata",
        () => {
          media.currentTime = time;
          if (wasPlaying) media.play().catch(() => {});
        },
        { once: true },
      );
    }
  };
  media.addEventListener("loadedmetadata", () => {
    root.querySelector("[data-player-duration]").textContent = format(
      media.duration,
    );
    const previous = Number(root.dataset.progress);
    if (previous > 0 && previous < media.duration - 5)
      media.currentTime = previous;
    status.textContent = "Ready to play.";
  });
  media.addEventListener("play", () => {
    play.innerHTML = window.KagNodeCore.icon("pause") + "<span>Pause</span>";
    play.setAttribute("aria-label", "Pause");
    status.textContent = "Playing";
  });
  media.addEventListener("pause", () => {
    play.innerHTML = window.KagNodeCore.icon("play") + "<span>Play</span>";
    play.setAttribute("aria-label", "Play");
    status.textContent = "Paused";
    save();
  });
  media.addEventListener(
    "error",
    () =>
      (status.textContent =
        "This stream could not play. Its format or processing output may be incompatible."),
  );
  async function save() {
    if (root.dataset.signedIn !== "true" || !Number.isFinite(media.currentTime))
      return;
    try {
      await window.KagNodeMedia.request("/api/v1/media/" + id + "/progress", {
        method: "POST",
        body: JSON.stringify({ position: media.currentTime }),
        keepalive: true,
      });
    } catch {}
  }
  media.addEventListener("timeupdate", () => {
    root.querySelector("[data-player-time]").textContent = format(
      media.currentTime,
    );
    root.querySelector("[data-player-seek]").value = Number.isFinite(
      media.duration,
    )
      ? (media.currentTime / media.duration) * 1000
      : 0;
    if (Date.now() - lastSave > 10000) {
      lastSave = Date.now();
      save();
    }
  });
  addEventListener(
    "pagehide",
    () => {
      save();
      engine?.destroy();
    },
    { once: true },
  );
})();
