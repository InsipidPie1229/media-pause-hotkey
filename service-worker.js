const STATE_KEY = "sessionState";
const MAX_MEDIA_RECORDS = 500;
const MAX_PAUSED_BATCHES = 50;
const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;

let serialQueue = Promise.resolve();

function enqueue(operation) {
  const result = serialQueue.then(operation, operation);
  serialQueue = result.catch(() => undefined);
  return result;
}

async function loadState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return normalizeState(stored[STATE_KEY]);
}

function normalizeState(state) {
  if (!state || state.version !== 1) {
    return { version: 1, media: {}, pausedBatches: [], latestTarget: null, error: null };
  }
  return {
    version: 1,
    media: state.media && typeof state.media === "object" ? state.media : {},
    pausedBatches: Array.isArray(state.pausedBatches) ? state.pausedBatches : [],
    latestTarget: state.latestTarget || null,
    error: state.error || null,
  };
}

async function saveState(state) {
  pruneState(state);
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

function pruneState(state) {
  const now = Date.now();
  for (const [key, item] of Object.entries(state.media)) {
    if (now - (item.lastSeen || 0) > 6 * 60 * 60 * 1000) delete state.media[key];
  }
  const entries = Object.entries(state.media);
  if (entries.length > MAX_MEDIA_RECORDS) {
    entries.sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
    state.media = Object.fromEntries(entries.slice(0, MAX_MEDIA_RECORDS));
  }
  state.pausedBatches = state.pausedBatches
    .filter((batch) => batch && Number.isInteger(batch.tabId) && Array.isArray(batch.items))
    .slice(-MAX_PAUSED_BATCHES);
  if (state.latestTarget && !Number.isInteger(state.latestTarget.tabId)) state.latestTarget = null;
}

function mediaKey(sender, mediaId) {
  return `${sender.tab.id}:${sender.documentId || `frame-${sender.frameId || 0}`}:${sender.frameId || 0}:${mediaId}`;
}

async function removeDocumentRecords(tabId, documentId) {
  const state = await loadState();
  for (const [key, item] of Object.entries(state.media)) if (item.tabId === tabId) delete state.media[key];
  state.pausedBatches = state.pausedBatches.filter((batch) => batch.tabId !== tabId);
  if (state.latestTarget?.tabId === tabId) state.latestTarget = null;
  await saveState(state);
}

function currentPlayingMedia(state, tabId) {
  return Object.values(state.media)
    .filter((item) => item.playing && (tabId === undefined || item.tabId === tabId))
    .sort((a, b) => (b.playingAt || 0) - (a.playingAt || 0));
}

function publicState(state) {
  const playing = currentPlayingMedia(state);
  const target = state.latestTarget;
  let pausedCount = 0;
  if (target) {
    pausedCount = state.pausedBatches
      .filter((batch) => batch.tabId === target.tabId)
      .reduce((count, batch) => count + batch.items.length, 0);
  }
  return {
    target: target ? { tabId: target.tabId, title: target.title || t("targetEmpty") } : null,
    status: playing.length ? "playing" : pausedCount ? "paused" : "idle",
    playingCount: playing.filter((item) => item.tabId === target?.tabId).length,
    pausedCount,
    error: state.error,
  };
}

function updateBadge(view) {
  const text = view.status === "playing" ? "▶" : view.status === "paused" ? "Ⅱ" : view.error ? "!" : "";
  const color = view.error ? "#b42318" : view.status === "paused" ? "#2563eb" : "#087e55";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setTitle({ title: view.error || view.target?.title || t("extName") });
}

async function sendToDocument(item, message) {
  try {
    const options = item.documentId ? { documentId: item.documentId } : { frameId: item.frameId };
    return await chrome.tabs.sendMessage(item.tabId, message, options);
  } catch {
    return null;
  }
}

async function performToggle(state, requestedAction = "toggle") {
    state.error = null;
    const playing = currentPlayingMedia(state);
    const shouldPause = requestedAction === "pause" || (requestedAction === "toggle" && playing.length > 0);
    if (shouldPause && playing.length) {
      const tabId = playing[0].tabId;
      const tabItems = currentPlayingMedia(state, tabId);
      const documents = new Map();
      for (const item of tabItems) {
        const key = `${item.documentId || item.frameId}`;
        if (!documents.has(key)) documents.set(key, item);
      }

      const results = await Promise.all([...documents.values()].map(async (item) => ({
        item,
        result: await sendToDocument(item, { type: "CONTROL", action: "pause" }),
      })));
      const pausedItems = [];
      let failedFrames = 0;
      for (const { item, result } of results) {
        if (!result || !Array.isArray(result.paused)) {
          failedFrames++;
          continue;
        }
        for (const paused of result.paused) {
          const key = mediaKey({ tab: { id: item.tabId }, documentId: item.documentId, frameId: item.frameId }, paused.mediaId);
          const record = state.media[key];
          if (!record) continue;
          record.playing = false;
          record.pausedByExtension = true;
          record.lastSeen = Date.now();
          pausedItems.push({
            documentId: record.documentId,
            frameId: record.frameId,
            mediaId: record.mediaId,
            signature: record.signature,
          });
        }
      }

      if (pausedItems.length) {
        state.pausedBatches = state.pausedBatches.filter((batch) => batch.tabId !== tabId);
        state.pausedBatches.push({ tabId, title: tabItems[0].title, pausedAt: Date.now(), items: pausedItems });
        state.latestTarget = { tabId, title: tabItems[0].title, touchedAt: Date.now() };
      }
      if (!pausedItems.length && failedFrames) state.error = t("errorPageConnection");
      await saveState(state);
      return publicState(state);
    }
    if (shouldPause) {
      state.error = t("errorPauseNothing");
      await saveState(state);
      return publicState(state);
    }

    const batch = [...state.pausedBatches].reverse().find((item) =>
      item.items.length > 0 && item.tabId === state.latestTarget?.tabId,
    );
    if (!batch) {
      state.error = state.latestTarget ? t("errorResumeNothing") : t("errorNoTarget");
      await saveState(state);
      return publicState(state);
    }

    const documents = new Map();
    for (const paused of batch.items) {
      const record = Object.values(state.media).find((item) =>
        item.tabId === batch.tabId && item.documentId === paused.documentId && item.frameId === paused.frameId,
      );
      if (record) documents.set(`${paused.documentId || paused.frameId}`, record);
    }
    const results = await Promise.all([...documents.values()].map(async (item) => ({
      item,
      result: await sendToDocument(item, {
        type: "CONTROL",
        action: "resume",
        items: batch.items.filter((paused) => paused.documentId === item.documentId && paused.frameId === item.frameId),
      }),
    })));
    const failed = results.reduce((total, { result }) => total + (result?.failed || 0), 0);
    const started = results.reduce((total, { result }) => total + (result?.started || 0), 0);
    if (!started || failed) state.error = failed ? t("errorResumeSome") : t("errorResumeNone");
    if (started) {
      batch.items = batch.items.filter((paused) => !results.some(({ item, result }) =>
        item.documentId === paused.documentId && item.frameId === paused.frameId && result?.resumedIds?.includes(paused.mediaId),
      ));
      if (!batch.items.length) state.pausedBatches = state.pausedBatches.filter((item) => item !== batch);
      state.latestTarget = { tabId: batch.tabId, title: batch.title, touchedAt: Date.now() };
    }
    await saveState(state);
    return publicState(state);
}

function toggleRecentMedia() {
  return enqueue(async () => performToggle(await loadState(), "toggle"));
}

function manualControl(action) {
  return enqueue(async () => performToggle(await loadState(), action));
}

function sameSenderContext(sender) {
  return Number.isInteger(sender.tab?.id) && typeof sender.documentId === "string";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_STATE") {
    enqueue(async () => {
      const state = await loadState();
      const view = publicState(state);
      updateBadge(view);
      sendResponse(view);
    }).catch(() => sendResponse({ status: "idle", error: t("errorStateRead") }));
    return true;
  }

  if (message?.type === "TOGGLE") {
    toggleRecentMedia().then((view) => {
      updateBadge(view);
      sendResponse(view);
    }).catch(() => sendResponse({ status: "idle", error: t("errorControl") }));
    return true;
  }

  if (message?.type === "PAUSE" || message?.type === "RESUME") {
    manualControl(message.type === "PAUSE" ? "pause" : "resume").then((view) => {
      updateBadge(view);
      sendResponse(view);
    }).catch(() => sendResponse({ status: "idle", error: t("errorControl") }));
    return true;
  }

  if (!sameSenderContext(sender) || !message?.mediaId) return false;
  enqueue(async () => {
    const state = await loadState();
    const key = mediaKey(sender, message.mediaId);
    const previous = state.media[key] || {};
    const now = Date.now();
    const isPlaying = Boolean(message.playing);
    state.media[key] = {
      ...previous,
      tabId: sender.tab.id,
      documentId: sender.documentId,
      frameId: sender.frameId || 0,
      mediaId: message.mediaId,
      title: String(sender.tab.title || message.title || t("targetEmpty")).slice(0, 160),
      signature: String(message.signature || "").slice(0, 512),
      playing: isPlaying,
      playingAt: isPlaying ? (message.activity ? now : previous.playingAt || now) : previous.playingAt || 0,
      pausedByExtension: isPlaying ? false : previous.pausedByExtension || false,
      lastSeen: now,
    };
    if (isPlaying && message.activity) {
      state.latestTarget = { tabId: sender.tab.id, title: state.media[key].title, touchedAt: now };
      state.error = null;
    }
    if (message.removed) {
      delete state.media[key];
      for (const batch of state.pausedBatches) batch.items = batch.items.filter((item) => item.mediaId !== message.mediaId);
      state.pausedBatches = state.pausedBatches.filter((batch) => batch.items.length);
    }
    await saveState(state);
    updateBadge(publicState(state));
  }).catch(() => undefined);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    const state = await loadState();
    for (const [key, item] of Object.entries(state.media)) if (item.tabId === tabId) delete state.media[key];
    state.pausedBatches = state.pausedBatches.filter((batch) => batch.tabId !== tabId);
    if (state.latestTarget?.tabId === tabId) state.latestTarget = null;
    await saveState(state);
    updateBadge(publicState(state));
  }).catch(() => undefined);
});

chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId !== 0) return;
  enqueue(() => removeDocumentRecords(details.tabId, details.documentId)).catch(() => undefined);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-recent-media") return;
  toggleRecentMedia().then(updateBadge).catch(() => updateBadge({ status: "idle", error: t("errorControl") }));
});

chrome.runtime.onStartup.addListener(() => {
  enqueue(async () => {
    const state = await loadState();
    updateBadge(publicState(state));
  }).catch(() => undefined);
});

enqueue(async () => {
  const state = await loadState();
  updateBadge(publicState(state));
}).catch(() => undefined);
