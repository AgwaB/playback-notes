/* Fixed browser controller. Source text is never evaluated or inserted as HTML. */
(() => {
  const contents = document.querySelector(".toc details");
  if (contents) {
    const narrow = window.matchMedia("(max-width: 760px)");
    const setContentsDefault = () => { contents.open = !narrow.matches; };
    setContentsDefault();
    narrow.addEventListener("change", setContentsDefault);
    window.addEventListener("pagehide", () => narrow.removeEventListener("change", setContentsDefault), { once: true });
  }
  // Progressive disclosure: without JavaScript every exact citation remains visible.
  document.querySelectorAll(".citation-toggle").forEach((button) => {
    const extra = document.getElementById(button.getAttribute("aria-controls"));
    if (!extra) return;
    const setExpanded = (expanded) => {
      extra.hidden = !expanded;
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", expanded ? button.dataset.hideLabel : button.dataset.showLabel);
    };
    setExpanded(false);
    button.hidden = false;
    button.addEventListener("click", () => setExpanded(button.getAttribute("aria-expanded") !== "true"));
  });
  const panel = document.getElementById("source-panel");
  if (!panel) return;
  const slot = document.getElementById("player-slot");
  const status = document.getElementById("player-status");
  const fallback = document.getElementById("source-fallback");
  const transcript = document.getElementById("transcript");
  const follow = document.getElementById("follow-playback");
  const closeButton = document.getElementById("close-source");
  let media = null,
    youtube = null,
    ready = false,
    attempted = false,
    pending = null,
    lastTrigger = null,
    timeout;
  const unavailable = () => {
    ready = false;
    status.textContent = panel.dataset.unavailable;
    clearTimeout(timeout);
  };
  function applySeek() {
    if (pending === null || !ready) return;
    const seconds = pending / 1000;
    try {
      if (youtube) youtube.seekTo(seconds, true);
      else if (media) {
        if (!Number.isFinite(media.duration) || seconds > media.duration) {
          unavailable();
          return;
        }
        const ranges = media.seekable;
        const seekable = Array.from(
          { length: ranges.length },
          (_, index) =>
            seconds >= ranges.start(index) && seconds <= ranges.end(index),
        ).some(Boolean);
        if (!seekable) {
          // Metadata may arrive before the first seekable range. Keep the last
          // request pending until canplay/progress, but never claim it succeeded.
          if (media.readyState >= 2) unavailable();
          return;
        }
        media.currentTime = seconds;
      } else return;
      pending = null;
    } catch {
      unavailable();
    }
  }
  function startPlayer() {
    if (attempted) return;
    attempted = true;
    status.textContent = panel.dataset.preparing;
    timeout = setTimeout(unavailable, 15000);
    const kind = panel.dataset.kind,
      locator = panel.dataset.locator;
    if (kind === "native" && locator) {
      media = document.createElement(
        panel.dataset.mediaType === "audio" ? "audio" : "video",
      );
      media.controls = true;
      media.preload = "metadata";
      media.setAttribute("playsinline", "");
      media.src = locator;
      const nativeReady = () => {
        ready = true;
        if (
          !Number.isFinite(media.duration) ||
          media.duration <= 0 ||
          (media.readyState >= 2 && media.seekable.length === 0)
        ) {
          unavailable();
          return;
        }
        if (media.seekable.length) {
          status.textContent = "";
          clearTimeout(timeout);
        }
        applySeek();
      };
      media.addEventListener("loadedmetadata", nativeReady);
      media.addEventListener("canplay", nativeReady);
      for (const event of ["progress", "durationchange"])
        media.addEventListener(event, () => {
          if (ready) nativeReady();
        });
      media.addEventListener("error", unavailable);
      slot.append(media);
    } else if (
      kind === "youtube" &&
      /^[A-Za-z0-9_-]{11}$/.test(locator) &&
      location.protocol !== "file:"
    ) {
      const holder = document.createElement("div");
      holder.id = "youtube-player";
      slot.append(holder);
      const create = () => {
        if (!window.YT?.Player) {
          unavailable();
          return;
        }
        youtube = new window.YT.Player(holder, {
          videoId: locator,
          playerVars: {
            origin: location.origin,
            controls: 1,
            playsinline: 1,
            autoplay: 0,
          },
          events: {
            onReady: () => {
              ready = true;
              status.textContent = "";
              clearTimeout(timeout);
              applySeek();
            },
            onError: unavailable,
          },
        });
      };
      if (window.YT?.Player) create();
      else {
        window.onYouTubeIframeAPIReady = create;
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.onerror = unavailable;
        document.head.append(script);
      }
    } else unavailable();
  }
  function openSource(trigger, ms = null, anchor = null) {
    lastTrigger = trigger;
    panel.hidden = false;
    if (ms !== null && Number.isFinite(ms) && ms >= 0) pending = ms;
    startPlayer();
    applySeek();
    if (anchor) {
      const target = document.getElementById(anchor);
      if (target && transcript.contains(target)) {
        transcript
          .querySelectorAll(".current")
          .forEach((node) => node.classList.remove("current"));
        target.classList.add("current");
        target.scrollIntoView({ block: "nearest" });
      }
    }
    closeButton.focus({ preventScroll: true });
  }
  function closeSource() {
    panel.hidden = true;
    document.body.classList.remove("pinned");
    document.getElementById("pin-source").setAttribute("aria-pressed", "false");
    media?.pause();
    if (ready && youtube) youtube.pauseVideo();
    lastTrigger?.focus({ preventScroll: true });
  }
  document
    .getElementById("open-source")
    .addEventListener("click", (event) => openSource(event.currentTarget));
  closeButton.addEventListener("click", closeSource);
  document.getElementById("pin-source").addEventListener("click", (event) => {
    const pinned = document.body.classList.toggle("pinned");
    event.currentTarget.setAttribute("aria-pressed", String(pinned));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) closeSource();
  });
  document.querySelectorAll("a.ts").forEach((anchor) =>
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      if (fallback && anchor.dataset.original)
        fallback.href = anchor.dataset.original;
      openSource(
        anchor,
        anchor.hasAttribute("data-ms") ? Number(anchor.dataset.ms) : null,
        anchor.dataset.anchor,
      );
    }),
  );
  document.querySelectorAll(".transcript-time").forEach((button) =>
    button.addEventListener("click", () => {
      pending = Number(button.dataset.ms);
      if (fallback && Number.isFinite(pending)) {
        try {
          const url = new URL(fallback.href);
          if (panel.dataset.kind === "youtube")
            url.searchParams.set("t", `${Math.floor(pending / 1000)}s`);
          else if (panel.dataset.kind === "native")
            url.hash = `t=${pending / 1000}`;
          fallback.href = url.href;
        } catch {
          // A damaged fallback link must not prevent transcript/native seeking.
        }
      }
      startPlayer();
      applySeek();
    }),
  );
  for (const event of ["wheel", "touchstart", "keydown"])
    transcript.addEventListener(
      event,
      () => {
        follow.checked = false;
      },
      { passive: true },
    );
  const lines = [...transcript.querySelectorAll("[data-start]")].filter(
    (node) => node.dataset.start !== "",
  );
  const timer = setInterval(() => {
    if (!ready || panel.hidden) return;
    let seconds;
    try {
      seconds = youtube ? youtube.getCurrentTime() : media?.currentTime;
    } catch {
      return;
    }
    if (!Number.isFinite(seconds)) return;
    const active = lines.findLast(
      (node) =>
        Number(node.dataset.start) <= seconds * 1000 &&
        (node.dataset.end === "" || seconds * 1000 < Number(node.dataset.end)),
    );
    lines.forEach((node) => node.classList.toggle("current", node === active));
    if (active && follow.checked) active.scrollIntoView({ block: "nearest" });
  }, 300);
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries.find((entry) => entry.isIntersecting);
        if (!current) return;
        document
          .querySelectorAll(".topics li")
          .forEach((li) =>
            li.classList.toggle(
              "active",
              li.querySelector("a")?.getAttribute("href") ===
                `#${current.target.id}`,
            ),
          );
      },
      { rootMargin: "-10% 0px -65% 0px" },
    );
    document
      .querySelectorAll("main section[id]")
      .forEach((node) => observer.observe(node));
    window.addEventListener("pagehide", () => observer.disconnect(), {
      once: true,
    });
  }
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(timer);
      clearTimeout(timeout);
      youtube?.destroy();
    },
    { once: true },
  );
})();
