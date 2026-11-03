(() => {
  const CONTROLLER_VERSION = "1.2.0";
  const oldController = globalThis.__mediaShortcutController;
  if (oldController?.version === CONTROLLER_VERSION) return oldController.snapshot();
  oldController?.dispose();

  const metadata = new WeakMap();
  const mediaById = new Map();
  const listeners = new Map();
  const observedRoots = new WeakSet();
  const rootListeners = new Map();
  const handledEvents = new WeakSet();
  const prefix = globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let nextId = 1;
  let sequence = 0;
  const boost = globalThis.__mediaShortcutBoost || (globalThis.__mediaShortcutBoost = {
    context: null, graphs: new Map(), watchdog: 0, minGeneration: 0, appliedGeneration: 0,
  });
  let controlReceipt = null;
  let controlQueue = Promise.resolve();

  function observation() {
    return { controllerId: prefix, sequence: ++sequence };
  }

  function signature(media) {
    return media.currentSrc || media.src || media.getAttribute("src") || "";
  }

  function sourceFor(media) {
    const meta = metadata.get(media);
    const current = signature(media);
    if (meta.signature !== current) {
      meta.signature = current;
      meta.sourceVersion++;
      meta.lastStartedAt = 0;
      meta.observedPaused = null;
    }
    return meta;
  }

  function notify(value) {
    try {
      chrome.runtime.sendMessage(value).catch(() => undefined);
    } catch {
      // The previous extension context can disappear during an update.
    }
  }

  function stateFor(media, origin = "snapshot", newPlay = false) {
    const meta = sourceFor(media);
    const paused = media.paused || media.ended || Boolean(media.error);
    const transitioned = !paused && (meta.observedPaused === true || newPlay && !meta.lastStartedAt);
    if (transitioned) {
      meta.lastStartedAt = Date.now();
      meta.playbackVersion++;
    }
    meta.observedPaused = paused;
    return {
      mediaId: meta.id,
      signature: meta.signature,
      sourceVersion: meta.sourceVersion,
      playing: media.isConnected && !media.paused && !media.ended && !media.error,
      ended: media.ended,
      hasError: Boolean(media.error),
      lastStartedAt: meta.lastStartedAt,
      playbackVersion: meta.playbackVersion,
      volume: effectiveVolume(media),
      playbackRate: media.playbackRate,
      muted: media.muted,
      boosted: gainOf(media) > 1,
      boostConnected: boost.graphs.has(media),
      boostLimited: boost.graphs.has(media) && !sourceAllowsBoost(media).ok,
      transitioned,
      origin,
    };
  }

  function report(media, origin = "event", newPlay = false) {
    const value = stateFor(media, origin, newPlay);
    notify({ type: "MEDIA_STATE", ...value, ...observation(), title: document.title });
  }

  function register(media) {
    let meta = metadata.get(media);
    if (!meta) {
      meta = {
        id: prefix + "-m" + nextId++,
        signature: signature(media),
        sourceVersion: 1,
        lastStartedAt: 0,
        observedPaused: null,
        playbackVersion: 0,
        lastTimeupdate: -Infinity,
        lastReported: "",
      };
      metadata.set(media, meta);
    }
    mediaById.set(meta.id, media);
    if (listeners.has(meta.id)) return false;
    const events = [];
    function on(event, listener) {
      media.addEventListener(event, listener);
      events.push([event, listener]);
    }
    for (const event of ["play", "playing", "pause", "ended", "error", "emptied", "loadstart", "timeupdate"])
      on(event, handleEvent);
    listeners.set(meta.id, events);
    return true;
  }

  function handleEvent(event) {
    if (boost.watchdog && checkInvalidated()) return;
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || handledEvents.has(event)) return;
    handledEvents.add(event);
    register(media);
    const meta = sourceFor(media);
    if (event.type === "emptied") {
      meta.sourceVersion++;
      meta.lastStartedAt = 0;
      meta.observedPaused = null;
    }
    if (event.type === "timeupdate") {
      const now = performance.now();
      if (now - meta.lastTimeupdate < 1000) return;
      meta.lastTimeupdate = now;
      const value = stateFor(media, "timeupdate");
      const key = JSON.stringify([value.playing, value.sourceVersion, value.playbackVersion]);
      if (key === meta.lastReported) return;
      meta.lastReported = key;
      notify({ type: "MEDIA_STATE", ...value, ...observation(), title: document.title });
      return;
    }
    report(media, event.type, event.type === "play");
    meta.lastReported = JSON.stringify([!media.paused && !media.ended && !media.error, meta.sourceVersion, meta.playbackVersion]);
  }

  function removeDetachedMedia(emit = true) {
    for (const [mediaId, media] of mediaById) {
      if (media.isConnected) continue;
      if (emit) notify({ type: "MEDIA_STATE", ...stateFor(media), ...observation(), removed: true, title: document.title });
      for (const [event, listener] of listeners.get(mediaId) || []) media.removeEventListener(event, listener);
      listeners.delete(mediaId);
      mediaById.delete(mediaId);
    }
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    const events = ["play", "playing", "pause", "ended", "error", "emptied", "loadstart", "timeupdate"];
    for (const name of events) root.addEventListener(name, handleEvent, true);
    rootListeners.set(root, events);
  }

  function collect(root, seen = new Set(), emit = false) {
    if (!root || seen.has(root)) return;
    seen.add(root);
    if (root instanceof HTMLMediaElement) {
      if (register(root) && emit) report(root);
      return;
    }
    if (root.shadowRoot) {
      collect(root.shadowRoot, seen, emit);
      observeRoot(root.shadowRoot);
    }
    if (typeof root.querySelectorAll !== "function") return;
    for (const media of root.querySelectorAll("audio, video")) {
      if (register(media) && emit) report(media);
    }
    for (const element of root.querySelectorAll("*")) {
      if (!element.shadowRoot) continue;
      collect(element.shadowRoot, seen, emit);
      observeRoot(element.shadowRoot);
    }
  }

  function snapshot() {
    collect(document);
    removeDetachedMedia(false);
    return {
      version: CONTROLLER_VERSION,
      title: document.title,
      media: [...mediaById.values()].map((media) => stateFor(media)),
      controlReceipt,
      ...observation(),
    };
  }

  function matches(media, item) {
    if (!media?.isConnected) return false;
    const current = stateFor(media);
    return current.signature === item.signature && current.sourceVersion === item.sourceVersion;
  }

  async function pausePlayingMedia() {
    const candidates = new Map();
    // A player can replace its video in a pause handler (for example during an ad
    // transition). Reconcile once against the new DOM, without retrying forever.
    for (let attempt = 0; attempt < 2; attempt++) {
      snapshot();
      for (const media of mediaById.values()) {
        if (media.paused || media.ended || media.error) continue;
        const item = stateFor(media);
        try {
          media.pause();
          candidates.set(item.mediaId, item);
        } catch {
          // One inaccessible player must not prevent other media from pausing.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!snapshot().media.some((item) => item.playing)) break;
    }
    const paused = [...candidates.values()].filter((item) => {
      const media = mediaById.get(item.mediaId);
      return matches(media, item) && media.paused;
    }).map(({ mediaId, signature, sourceVersion, playbackVersion }) => ({ mediaId, signature, sourceVersion, playbackVersion }));
    return { paused, ...snapshot() };
  }

  async function resumeMedia(items) {
    snapshot();
    const results = await Promise.all(items.map(async (item) => {
      const media = mediaById.get(item.mediaId);
      if (!matches(media, item) || media.ended || !media.paused) return { invalid: item.mediaId, code: "media-invalid" };
      let timer;
      let failureCode = "play-state-unconfirmed";
      try {
        await Promise.race([
          media.play(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
              failureCode = "play-timeout";
              reject(new Error("play timeout"));
            }, 6000);
          }),
        ]);
        if (matches(media, item) && !media.paused && !media.ended && media.readyState >= 2) {
          report(media);
          return { resumed: item.mediaId };
        }
      } catch (error) {
        // Browser autoplay restrictions are reported as a failure, never as success.
        if (failureCode !== "play-timeout") failureCode = error?.name === "NotAllowedError" ? "play-blocked" :
          error?.name === "AbortError" ? "play-aborted" : "play-rejected";
      } finally {
        clearTimeout(timer);
      }
      // Cancel a pending play so it cannot unexpectedly start after a timeout.
      if (matches(media, item) && !media.paused) media.pause();
      return { failed: item.mediaId, code: failureCode };
    }));
    return {
      started: results.filter((item) => item.resumed).length,
      failed: results.filter((item) => item.failed || item.invalid).length,
      resumedIds: results.flatMap((item) => item.resumed ? [item.resumed] : []),
      invalidIds: results.flatMap((item) => item.invalid ? [item.invalid] : []),
      failedIds: results.flatMap((item) => item.failed ? [item.failed] : []),
      failures: results.flatMap((item) => item.code ? [{ mediaId: item.failed || item.invalid, code: item.code }] : []),
      ...snapshot(),
    };
  }

  const RATE_MIN = 0.25;
  const RATE_MAX = 4;
  const VOLUME_MAX_BOOST = 3;

  function gainOf(media) {
    return boost.graphs.get(media)?.gain.gain.value ?? 1;
  }

  function effectiveVolume(media) {
    return Math.round(media.volume * gainOf(media) * 100) / 100;
  }

  // Estimate only: a CORS-cross-origin source is output as silence once it is
  // routed through Web Audio. Redirects cannot be seen from here.
  function sourceAllowsBoost(media) {
    if (media.srcObject) return { ok: false, code: "boost-refused-source" };
    const raw = media.currentSrc || media.src;
    if (!raw) return { ok: false, code: "boost-refused-source" };
    let url;
    try { url = new URL(raw, location.href); } catch { return { ok: false, code: "boost-refused-source" }; }
    if (url.protocol === "blob:") {
      try { return new URL(url.pathname).origin === location.origin ? { ok: true } : { ok: false, code: "boost-refused-cors" }; }
      catch { return { ok: false, code: "boost-refused-source" }; }
    }
    if (!["http:", "https:"].includes(url.protocol)) return { ok: false, code: "boost-refused-source" };
    if (url.origin === location.origin || media.crossOrigin) return { ok: true };
    return { ok: false, code: "boost-refused-cors" };
  }

  // A reset revokes every boost request issued under an older settings
  // generation, including requests still waiting on AudioContext.resume().
  function resetAllGains(generation) {
    if (Number.isInteger(generation)) {
      boost.minGeneration = Math.max(boost.minGeneration || 0, generation + 1);
      // A reset that arrives after boost was re-enabled and used must not
      // clear gains applied under that newer generation.
      if (generation < (boost.appliedGeneration || 0)) return false;
    }
    for (const graph of boost.graphs.values()) graph.gain.gain.value = 1;
    clearInterval(boost.watchdog);
    boost.watchdog = 0;
    return true;
  }

  // Best effort: after an extension reload this world keeps running but can no
  // longer be controlled, so it drops its own boost. Timers may be delayed in
  // hidden or paused tabs; media events below provide a second chance.
  function checkInvalidated() {
    if (chrome.runtime?.id) return false;
    resetAllGains();
    return true;
  }

  function armWatchdog() {
    if (boost.watchdog) return;
    boost.watchdog = setInterval(() => {
      if (checkInvalidated()) return;
      if (![...boost.graphs.values()].some((graph) => graph.gain.gain.value > 1)) {
        clearInterval(boost.watchdog);
        boost.watchdog = 0;
      }
    }, 500);
  }

  // item pins the element and its source generation; every await is followed
  // by a re-check so a request never lands on a source that replaced it.
  async function ensureRunning() {
    if (boost.context.state !== "running") {
      await Promise.race([boost.context.resume(), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    return boost.context.state === "running";
  }

  function boostAuthorized(generation) {
    return Number.isInteger(generation) && generation >= (boost.minGeneration || 0);
  }

  async function connectGraph(media, item, generation) {
    // Checked for new and already connected elements alike: the current source
    // may have changed since the graph was created.
    const allowed = sourceAllowsBoost(media);
    if (!allowed.ok) return allowed;
    if (boost.graphs.has(media)) {
      if (!boost.context || !await ensureRunning()) return { ok: false, code: "boost-refused-context" };
      if (!boostAuthorized(generation)) return { ok: false, code: "boost-reset-superseded" };
      if (!matches(media, item)) return { ok: false, code: "media-invalid" };
      if (!sourceAllowsBoost(media).ok) return { ok: false, code: "boost-refused-cors" };
      return { ok: true };
    }
    if (!navigator.userActivation?.hasBeenActive) return { ok: false, code: "boost-refused-activation" };
    try {
      if (!boost.context || boost.context.state === "closed") boost.context = new AudioContext();
      if (!await ensureRunning()) return { ok: false, code: "boost-refused-context" };
      // Re-check after the await: boost may have been turned off or the page
      // may have swapped the source meanwhile.
      if (!boostAuthorized(generation)) return { ok: false, code: "boost-reset-superseded" };
      if (!matches(media, item)) return { ok: false, code: "media-invalid" };
      if (!sourceAllowsBoost(media).ok) return { ok: false, code: "boost-refused-cors" };
      const source = boost.context.createMediaElementSource(media);
      const gain = boost.context.createGain();
      source.connect(gain);
      gain.connect(boost.context.destination);
      boost.graphs.set(media, { source, gain });
      return { ok: true };
    } catch {
      // InvalidStateError: the page or an older extension world already owns it.
      return { ok: false, code: "boost-refused-unavailable" };
    }
  }

  async function setEffectiveVolume(media, item, next, boostAllowed, generation) {
    const target = Math.round(clamp(next, 0, boostAllowed ? VOLUME_MAX_BOOST : 1) * 100) / 100;
    if (target > 1) {
      if (!boostAuthorized(generation)) return "boost-reset-superseded";
      const connected = await connectGraph(media, item, generation);
      // Refused boost keeps the current volume untouched.
      if (!connected.ok) return connected.code;
      if (!boostAuthorized(generation)) return "boost-reset-superseded";
      if (!matches(media, item)) return "media-invalid";
      media.volume = 1;
      boost.graphs.get(media).gain.gain.value = target;
      boost.appliedGeneration = Math.max(boost.appliedGeneration || 0, generation);
      armWatchdog();
      return "";
    }
    const graph = boost.graphs.get(media);
    if (graph) graph.gain.gain.value = 1;
    media.volume = target;
    return "";
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  // Volume and speed changes never call play()/pause() and never touch playback
  // history; they only set the requested property and report the actual value.
  async function adjustMedia(items, adjust, boostAllowed = false, generation = null) {
    snapshot();
    const kind = adjust?.kind;
    const mode = adjust?.mode;
    const value = Number(adjust?.value);
    const results = [];
    for (const item of items) {
      const media = mediaById.get(item.mediaId);
      if (!["volume", "rate"].includes(kind) || !["delta", "set"].includes(mode) || !Number.isFinite(value)) {
        results.push({ mediaId: item.mediaId, code: "adjust-invalid" });
        continue;
      }
      if (!matches(media, item)) {
        results.push({ mediaId: item.mediaId, code: "media-invalid" });
        continue;
      }
      try {
        if (kind === "volume") {
          const current = effectiveVolume(media);
          const next = mode === "set" ? value : current + value;
          // Effective level = media.volume x gain. Without the experimental
          // boost the result is clamped to 100% (gain 1).
          const code = await setEffectiveVolume(media, item, next, boostAllowed === true, generation);
          if (code) {
            results.push({ mediaId: item.mediaId, code, volume: effectiveVolume(media) });
            continue;
          }
        } else {
          const next = mode === "set" ? value : media.playbackRate + value;
          media.playbackRate = clamp(Math.round(next * 100) / 100, RATE_MIN, RATE_MAX);
        }
        results.push({ mediaId: item.mediaId, volume: effectiveVolume(media), playbackRate: media.playbackRate,
          muted: media.muted, boosted: gainOf(media) > 1 });
      } catch {
        results.push({ mediaId: item.mediaId, code: "adjust-rejected" });
      }
    }
    return {
      adjusted: results.filter((item) => !item.code),
      failures: results.filter((item) => item.code),
      failed: results.filter((item) => item.code).length,
      ...snapshot(),
    };
  }

  let osdHost = null;
  let osdLabel = null;
  let osdTimer = 0;

  function showOsd(text) {
    if (window !== window.top || typeof text !== "string" || !text) return false;
    if (!osdHost) {
      osdHost = document.createElement("div");
      const shadow = osdHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ":host{all:initial}div{position:fixed;top:24px;left:50%;transform:translateX(-50%);" +
        "z-index:2147483647;pointer-events:none;padding:8px 16px;border-radius:8px;background:rgba(17,24,39,.86);" +
        "color:#fff;font:600 16px/1.3 system-ui,sans-serif;letter-spacing:.01em;transition:opacity .15s;opacity:0}" +
        "div.show{opacity:1}";
      osdLabel = document.createElement("div");
      osdLabel.setAttribute("role", "status");
      shadow.append(style, osdLabel);
    }
    // Fullscreen players hide everything outside the fullscreen element.
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && !(fullscreen instanceof HTMLMediaElement) ? fullscreen : document.documentElement;
    if (osdHost.parentNode !== parent) parent.append(osdHost);
    osdLabel.textContent = text;
    osdLabel.className = "show";
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => { osdLabel.className = ""; }, 1000);
    return true;
  }

  function onMessage(message, _sender, sendResponse) {
    if (message?.type === "OSD") {
      sendResponse({ shown: showOsd(message.text) });
      return false;
    }
    if (message?.type === "BOOST_RESET") {
      // Turning the experiment off drops every boost made in this world,
      // including graphs created by an earlier controller. Paths stay until reload.
      const applied = resetAllGains(message.generation);
      sendResponse({ reset: boost.graphs.size, stale: !applied });
      return false;
    }
    if (message?.type !== "CONTROL") return false;
    if (!["pause", "resume", "adjust"].includes(message.action)) return false;
    const run = async () => {
      if (message.requestId && controlReceipt?.requestId === message.requestId)
        return { ...controlReceipt, ...snapshot() };
      const items = Array.isArray(message.items) ? message.items : [];
      const result = message.action === "pause" ? await pausePlayingMedia() :
        message.action === "adjust" ? await adjustMedia(items, message.adjust, message.boostAllowed, message.boostGeneration) : await resumeMedia(items);
      controlReceipt = { requestId: message.requestId, action: message.action,
        paused: result.paused || [], started: result.started || 0, failed: result.failed || 0,
        resumedIds: result.resumedIds || [], invalidIds: result.invalidIds || [], failedIds: result.failedIds || [],
        failures: result.failures || [], adjusted: result.adjusted || [] };
      return { ...result, ...snapshot() };
    };
    controlQueue = controlQueue.then(run, run);
    controlQueue.then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  const observer = new MutationObserver((mutations) => {
    removeDetachedMedia();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) collect(node, new Set(), true);
      }
    }
  });

  chrome.runtime.onMessage.addListener(onMessage);
  observeRoot(document);
  collect(document);
  globalThis.__mediaShortcutController = {
    version: CONTROLLER_VERSION,
    snapshot,
    dispose() {
      observer.disconnect();
      for (const [root, events] of rootListeners) for (const name of events) root.removeEventListener(name, handleEvent, true);
      rootListeners.clear();
      chrome.runtime.onMessage.removeListener(onMessage);
      for (const [mediaId, media] of mediaById) {
        for (const [event, listener] of listeners.get(mediaId) || []) media.removeEventListener(event, listener);
      }
      mediaById.clear();
      listeners.clear();
      clearTimeout(osdTimer);
      osdHost?.remove();
    },
  };
  for (const media of mediaById.values()) report(media);
  return snapshot();
})();
