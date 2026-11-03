(() => {
  const CONTROLLER_VERSION = "1.0.6";
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

  function onMessage(message, _sender, sendResponse) {
    if (message?.type !== "CONTROL") return false;
    if (!["pause", "resume"].includes(message.action)) return false;
    const run = async () => {
      if (message.requestId && controlReceipt?.requestId === message.requestId)
        return { ...controlReceipt, ...snapshot() };
      const result = message.action === "pause" ? await pausePlayingMedia() :
        await resumeMedia(Array.isArray(message.items) ? message.items : []);
      controlReceipt = { requestId: message.requestId, action: message.action,
        paused: result.paused || [], started: result.started || 0, failed: result.failed || 0,
        resumedIds: result.resumedIds || [], invalidIds: result.invalidIds || [], failedIds: result.failedIds || [],
        failures: result.failures || [] };
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
    },
  };
  for (const media of mediaById.values()) report(media);
  return snapshot();
})();
