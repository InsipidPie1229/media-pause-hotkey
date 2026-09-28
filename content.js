(() => {
  if (globalThis.__mediaPauseHotkeyInstalled) return;
  globalThis.__mediaPauseHotkeyInstalled = true;

  const elementIds = new WeakMap();
  const mediaById = new Map();
  const probed = new WeakSet();
  let nextId = 1;
  const observedRoots = new WeakSet();

  function signature(media) {
    return media.currentSrc || media.src || media.getAttribute("src") || "";
  }

  function idFor(media) {
    let id = elementIds.get(media);
    if (!id) {
      id = `m${nextId++}`;
      elementIds.set(media, id);
      mediaById.set(id, media);
      media.addEventListener("playing", () => report(media, true, true));
      media.addEventListener("pause", () => report(media, false, false));
      media.addEventListener("ended", () => report(media, false, false));
      media.addEventListener("emptied", () => report(media, false, false));
      media.addEventListener("loadstart", () => report(media, false, false));
      media.addEventListener("error", () => report(media, false, false));
      probeForAlreadyPlaying(media);
    }
    return id;
  }

  function probeForAlreadyPlaying(media) {
    if (probed.has(media)) return;
    probed.add(media);
    if (media.paused || media.ended) return;
    const startTime = media.currentTime;
    setTimeout(() => {
      if (!media.paused && !media.ended && media.currentTime > startTime + 0.01) report(media, true, true);
    }, 350);
  }

  function report(media, playing = !media.paused && !media.ended, activity = false) {
    const mediaId = idFor(media);
    chrome.runtime.sendMessage({
      type: "MEDIA_STATE",
      mediaId,
      playing: Boolean(playing && !media.paused && !media.ended),
      activity,
      signature: signature(media),
      title: document.title,
    }).catch(() => undefined);
  }

  function removeDetachedMedia() {
    for (const [mediaId, media] of mediaById) {
      if (media.isConnected) continue;
      chrome.runtime.sendMessage({
        type: "MEDIA_STATE",
        mediaId,
        playing: false,
        removed: true,
        signature: signature(media),
        title: document.title,
      }).catch(() => undefined);
      mediaById.delete(mediaId);
    }
  }

  function collect(root, seenRoots = new Set()) {
    if (!root || seenRoots.has(root)) return;
    seenRoots.add(root);
    if (root instanceof HTMLMediaElement) {
      const wasNew = !elementIds.has(root);
      idFor(root);
      if (wasNew) report(root, false, false);
      if (!root.paused && !root.ended) probeForAlreadyPlaying(root);
      return;
    }
    if (typeof root.querySelectorAll !== "function") return;
    for (const media of root.querySelectorAll("audio, video")) collect(media, seenRoots);
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) {
        collect(element.shadowRoot, seenRoots);
        observeRoot(element.shadowRoot);
      }
    }
  }

  function findMedia(item) {
    const media = mediaById.get(item.mediaId);
    if (!media || signature(media) !== item.signature) return null;
    return media;
  }

  async function pausePlayingMedia() {
    collect(document);
    const paused = [];
    for (const [mediaId, media] of mediaById) {
      if (media.paused || media.ended) continue;
      const sourceSignature = signature(media);
      try {
        media.pause();
        paused.push({ mediaId, signature: sourceSignature });
      } catch {
        // Continue controlling other media in the same frame.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { paused };
  }

  async function resumeMedia(items) {
    let started = 0;
    let failed = 0;
    const resumedIds = [];
    for (const item of items) {
      const media = findMedia(item);
      if (!media || !media.paused || media.ended) {
        failed++;
        continue;
      }
      try {
        await media.play();
        if (!media.paused && !media.ended) {
          started++;
          resumedIds.push(item.mediaId);
          report(media, true, true);
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    return { started, failed, resumedIds };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CONTROL") return false;
    if (message.action === "pause") {
      pausePlayingMedia().then(sendResponse).catch(() => sendResponse({ paused: [] }));
      return true;
    }
    if (message.action === "resume") {
      const documentItems = Array.isArray(message.items) ? message.items : [];
      resumeMedia(documentItems).then(sendResponse).catch(() => sendResponse({ started: 0, failed: 0, resumedIds: [] }));
      return true;
    }
    return false;
  });

  const observer = new MutationObserver((mutations) => {
    removeDetachedMedia();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) collect(node);
      }
    }
  });

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { childList: true, subtree: true });
  }

  function start() {
    collect(document);
    removeDetachedMedia();
    observeRoot(document);
  }

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
