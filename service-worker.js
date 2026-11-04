importScripts("i18n.js");

const STATE_KEY = "sessionState";
const MAX_MEDIA_RECORDS = 500;
const MAX_PAUSED_BATCHES = 50;
const MAX_DOCUMENT_RECORDS = 1000;
const t = globalThis.mediaShortcutI18n.message;
const VERSION = chrome.runtime.getManifest?.().version || "";
const SETTINGS_KEY = "settings";
// A single user preference (no site data): the experimental >100% boost. Off by default.
// generation increases on every change so pages can reject boost requests
// issued before the latest switch-off.
let settings = { boostEnabled: false, generation: 0 };
const settingsReady = (async () => {
  try {
    const stored = (await chrome.storage.local?.get(SETTINGS_KEY))?.[SETTINGS_KEY];
    settings = { boostEnabled: stored?.boostEnabled === true,
      generation: Number.isInteger(stored?.generation) ? stored.generation : 0 };
  } catch { /* Keep the safe default. */ }
})();
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) {
    const value = changes[SETTINGS_KEY].newValue;
    settings = { boostEnabled: value?.boostEnabled === true, generation: Number.isInteger(value?.generation) ? value.generation : 0 };
  }
});

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}
let serialQueue = Promise.resolve();

function enqueue(operation) {
  const result = serialQueue.then(operation, operation);
  serialQueue = result.catch(() => undefined);
  return result;
}

function normalizeState(value) {
  const state = value && [1, 2, 3, 4].includes(value.version) ? value : {};
  const media = state.media && typeof state.media === "object" ? state.media : {};
  const latestTarget = state.latestTarget || null;
  return {
    version: 4,
    media,
    connections: state.connections && typeof state.connections === "object" ? state.connections : {},
    diagnostics: trimDiagnostics(Array.isArray(state.diagnostics) ? state.diagnostics : []),
    observations: state.observations && typeof state.observations === "object" ? state.observations : {},
    pausedBatches: Array.isArray(state.pausedBatches) ? state.pausedBatches : [],
    // Documents whose boost reset could not be confirmed when boost was turned off.
    boostResetPending: state.boostResetPending && typeof state.boostResetPending === "object" ? state.boostResetPending : {},
    latestTarget: latestTarget ? {
      ...latestTarget,
      playedAt: latestTarget.playedAt || Math.max(0, ...Object.values(media)
        .filter((item) => item.tabId === latestTarget.tabId).map((item) => item.playingAt || 0)),
    } : null,
    lastActivityAt: state.lastActivityAt || Math.max(0, ...Object.values(media).map((item) => item.playingAt || 0)),
    error: state.version >= 2 && typeof state.error === "string" ? state.error : "",
    // Key of the single cold-start resume candidate chosen by the last full scan.
    coldCandidate: typeof state.coldCandidate === "string" ? state.coldCandidate : "",
    // 1.4.0: remembered extension volume per tab ({ value, revision, generation }).
    // revision increases on every user volume command, across all tabs.
    tabVolumes: state.tabVolumes && typeof state.tabVolumes === "object" ? state.tabVolumes : {},
    volumeRevision: Number.isInteger(state.volumeRevision) ? state.volumeRevision : 0,
    // Documents an undo could not be confirmed in: { [documentKey]: { tabId, documentId, frameId, revision, generation } }.
    volumeUndoPending: state.volumeUndoPending && typeof state.volumeUndoPending === "object" ? state.volumeUndoPending : {},
  };
}

function importantDiagnostic(entry) {
  return ["command", "command-start", "control", "reconnect", "resume-selection", "adjust-selection", "invalidate", "interrupted"].includes(entry.type);
}

function trimDiagnostics(entries) {
  const important = entries.filter(importantDiagnostic).slice(-100);
  const observations = entries.filter(entry => !importantDiagnostic(entry)).slice(-100);
  return [...important, ...observations].sort((a, b) => a.at - b.at);
}

function diagnose(state, type, context = {}, details = {}) {
  const entry = { at: Date.now(), type };
  for (const key of ["tabId", "frameId", "documentId", "mediaId"]) if (context[key] !== undefined) entry[key] = context[key];
  // Explicit fields only: diagnostics never contain page titles, URLs, or raw errors.
  for (const key of ["playing", "transitioned", "playbackVersion", "sequence", "durationMs", "code", "reason", "mediaCount", "playingCount", "resumeCount", "adjustCount", "unreachedCount", "action", "input", "commandId", "requestId", "sourceVersion", "ended", "hasError", "restricted"])
    if (details[key] !== undefined) entry[key] = details[key];
  if (["play", "playing", "pause", "ended", "error", "emptied", "loadstart", "timeupdate", "snapshot", "event"].includes(details.origin)) entry.origin = details.origin;
  state.diagnostics.push(entry);
  state.diagnostics = trimDiagnostics(state.diagnostics);
}

function setConnection(state, context, status) {
  state.connections[documentKey(context)] = { ...context, status, checkedAt: Date.now() };
}

function targetUnknown(state, tabId) {
  return Object.values(state.connections).some(item => item.tabId === tabId && item.status === "unknown" &&
    Object.values(state.media).some(media => documentKey(media) === documentKey(item)));
}

async function loadState() {
  return normalizeState((await chrome.storage.session.get(STATE_KEY))[STATE_KEY]);
}

function mediaKey(context, mediaId) {
  return context.tabId + ":" + context.documentId + ":" + context.frameId + ":" + mediaId;
}

function documentKey(context) {
  return context.tabId + ":" + context.documentId + ":" + context.frameId;
}

function acceptObservation(state, context, packet, isSnapshot = false) {
  const key = documentKey(context);
  const previous = state.observations[key];
  // Legacy events must not overwrite a document already scanned by the new controller.
  if (typeof packet.controllerId !== "string" || !Number.isSafeInteger(packet.sequence)) return !previous;
  if (previous) {
    if (previous.controllerId === packet.controllerId && packet.sequence <= previous.sequence) return false;
    if (previous.controllerId !== packet.controllerId && !isSnapshot) return false;
  }
  state.observations[key] = { ...context, controllerId: packet.controllerId, sequence: packet.sequence, lastSeen: Date.now() };
  return true;
}

function contextFor(sender) {
  return { tabId: sender.tab.id, documentId: sender.documentId, frameId: sender.frameId || 0 };
}

function sameMedia(context, item, mediaId) {
  return item.documentId === context.documentId && item.frameId === context.frameId && item.mediaId === mediaId;
}

function forgetPause(state, context, mediaId, reason = "playback-change") {
  for (const batch of state.pausedBatches) {
    if (batch.tabId === context.tabId) {
      const previousCount = batch.items.length;
      batch.items = batch.items.filter((item) => !sameMedia(context, item, mediaId));
      if (batch.items.length < previousCount) diagnose(state, "invalidate", { ...context, mediaId }, { reason });
    }
  }
}

function recordMatches(record, item) {
  return record && record.signature === item.signature &&
    (record.sourceVersion || 0) === (item.sourceVersion || 0) &&
    (item.playbackVersion === undefined || item.playbackVersion === record.playbackVersion);
}

function pruneState(state) {
  const ownedKeys = new Set(state.pausedBatches.flatMap(batch => batch.items.map(item => mediaKey({ tabId: batch.tabId, ...item }, item.mediaId))));
  const priority = (key, item) => (ownedKeys.has(key) ? 2 : 0) + (item.tabId === state.latestTarget?.tabId ? 1 : 0);
  const entries = Object.entries(state.media).sort((a, b) => priority(b[0], b[1]) - priority(a[0], a[1]) || (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
  // An idle pause does not expire. Confirmed navigation, source changes and tab
  // closure invalidate records; keep the bounded cache across long pauses.
  state.media = Object.fromEntries(entries.slice(0, MAX_MEDIA_RECORDS));
  const activeDocuments = new Set(Object.values(state.media).map(documentKey));
  const documentEntries = Object.entries(state.observations).sort((a, b) =>
    Number(activeDocuments.has(b[0])) - Number(activeDocuments.has(a[0])) || b[1].lastSeen - a[1].lastSeen);
  state.observations = Object.fromEntries(documentEntries.slice(0, MAX_DOCUMENT_RECORDS));
  for (const key of Object.keys(state.connections)) if (!state.observations[key] && !activeDocuments.has(key)) delete state.connections[key];
  state.pausedBatches = state.pausedBatches.filter((batch) =>
    batch && Number.isInteger(batch.tabId) && Array.isArray(batch.items));
  for (const batch of state.pausedBatches) {
    batch.items = batch.items.filter((item) => {
      const record = state.media[mediaKey({ tabId: batch.tabId, ...item }, item.mediaId)];
      const valid = recordMatches(record, item) && !record.playing && !record.ended && !record.hasError;
      if (!valid) diagnose(state, "invalidate", { tabId: batch.tabId, ...item }, { reason: "record-invalid" });
      return valid;
    });
  }
  state.pausedBatches = state.pausedBatches.filter((batch) => batch.items.length)
    .sort((a, b) => Number(a.tabId === state.latestTarget?.tabId) - Number(b.tabId === state.latestTarget?.tabId)).slice(-MAX_PAUSED_BATCHES);
  if (state.latestTarget && !Number.isInteger(state.latestTarget.tabId)) state.latestTarget = null;
  // A navigated or closed document took its audio graph with it.
  for (const key of Object.keys(state.boostResetPending || {})) if (!state.observations[key]) delete state.boostResetPending[key];
}

async function saveState(state) {
  pruneState(state);
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

function upsertMedia(state, context, value, title) {
  if (typeof value.mediaId !== "string") return;
  const key = mediaKey(context, value.mediaId);
  if (value.removed) {
    delete state.media[key];
    forgetPause(state, context, value.mediaId, "element-removed");
    return;
  }
  const previous = state.media[key];
  const now = Date.now();
  const sourceVersion = Number.isInteger(value.sourceVersion) ? value.sourceVersion : 0;
  const signature = String(value.signature || "");
  const sameSource = previous && previous.signature === signature && (previous.sourceVersion || 0) === sourceVersion;
  const reportedStart = Number.isFinite(value.lastStartedAt) ? Math.min(now, Math.max(0, value.lastStartedAt)) :
    value.playing && value.activity ? now : 0;
  const playingAt = reportedStart || (sameSource ? previous.playingAt : 0) || 0;
  const playbackVersion = Number.isInteger(value.playbackVersion) ? value.playbackVersion : 0;
  const newPlayback = playingAt > 0 && (!sameSource || playbackVersion !== (previous.playbackVersion || 0));
  const playing = Boolean(value.playing);
  if (!sameSource || playing || newPlayback || playingAt > (previous?.playingAt || 0))
    forgetPause(state, context, value.mediaId, !sameSource ? "source-change" : "playback-change");
  state.media[key] = {
    ...context, mediaId: value.mediaId, signature, sourceVersion, playing,
    ended: Boolean(value.ended), hasError: Boolean(value.hasError), progressed: Boolean(value.progressed),
    observedPlaying: playing || Boolean(sameSource && (previous.observedPlaying || previous.playing || previous.playingAt > 0)),
    title: String(title || t("targetEmpty")).slice(0, 160),
    playingAt, playbackVersion, lastSeen: now,
  };
  // Levels are informational only; they never affect target or resume selection.
  const record = state.media[key];
  if (Number.isFinite(value.volume)) record.volume = value.volume;
  else if (sameSource && Number.isFinite(previous.volume)) record.volume = previous.volume;
  if (Number.isFinite(value.siteVolume)) record.siteVolume = value.siteVolume;
  else if (sameSource && Number.isFinite(previous.siteVolume)) record.siteVolume = previous.siteVolume;
  if (Number.isFinite(value.playbackRate)) record.playbackRate = value.playbackRate;
  else if (sameSource && Number.isFinite(previous.playbackRate)) record.playbackRate = previous.playbackRate;
  if (typeof value.muted === "boolean") record.muted = value.muted;
  else if (sameSource && typeof previous.muted === "boolean") record.muted = previous.muted;
  for (const flag of ["boosted", "boostConnected", "boostLimited", "volumePending", "volumeRefused"]) {
    if (typeof value[flag] === "boolean") record[flag] = value[flag];
    else if (sameSource && typeof previous[flag] === "boolean") record[flag] = previous[flag];
  }
  if (playingAt > state.lastActivityAt || newPlayback && playingAt === state.lastActivityAt) {
    state.lastActivityAt = playingAt;
    state.latestTarget = { tabId: context.tabId, title: state.media[key].title, playedAt: playingAt, touchedAt: now };
    state.error = "";
    diagnose(state, "target", context, { reason: "playback-transition" });
  } else if (state.latestTarget?.tabId === context.tabId) {
    state.latestTarget.title = state.media[key].title;
  }
}

function applyDocumentSnapshot(state, context, snapshot, title) {
  if (!Array.isArray(snapshot?.media)) return;
  if (!acceptObservation(state, context, snapshot, true)) return;
  setConnection(state, context, "connected");
  diagnose(state, "snapshot", context, { sequence: snapshot.sequence,
    mediaCount: snapshot.media.length, playingCount: snapshot.media.filter(item => item.playing).length });
  const ids = new Set(snapshot.media.map((item) => item.mediaId));
  for (const [key, record] of Object.entries(state.media)) {
    if (record.tabId === context.tabId && record.documentId === context.documentId &&
        record.frameId === context.frameId && !ids.has(record.mediaId)) {
      delete state.media[key];
      forgetPause(state, context, record.mediaId, "snapshot-element-missing");
    }
  }
  for (const value of snapshot.media) upsertMedia(state, context, value, title || snapshot.title);
}

function coldEligible(item) {
  return item && !item.playing && !item.ended && !item.hasError && item.progressed && !item.observedPlaying;
}

// Global rule shared by discovery and resume: nothing anywhere was seen playing,
// no scannable page failed (see restrictedPage), and exactly one media qualifies.
// HTTP(S) pages Chrome never lets extensions script (Web Store, Google's remote
// New Tab page) are expected to fail and hide no media we could control.
function restrictedPage(url) {
  try {
    const { hostname, pathname } = new URL(url || "");
    return hostname === "chromewebstore.google.com" ||
      hostname === "chrome.google.com" && (pathname === "/webstore" || pathname.startsWith("/webstore/")) ||
      hostname === "www.google.com" && pathname === "/_/chrome/newtab";
  } catch { return false; }
}

function chooseColdCandidate(state, failedTabs) {
  const records = Object.entries(state.media);
  if (records.some(([, item]) => item.observedPlaying || item.playing || failedTabs.has(item.tabId))) return "";
  const eligible = records.filter(([, item]) => coldEligible(item));
  return eligible.length === 1 ? eligible[0][0] : "";
}

function playingInTab(state, tabId) {
  return Object.values(state.media).filter((item) => item.tabId === tabId && item.playing);
}

function resumeSelection(state, tabId) {
  const batch = state.pausedBatches.find(item => item.tabId === tabId && item.items.length);
  const owned = (batch?.items || []).filter(item => {
    const record = state.media[mediaKey({ tabId, ...item }, item.mediaId)];
    return recordMatches(record, item) && !record.playing && !record.ended && !record.hasError;
  });
  if (owned.length) return { items: owned, reason: "extension-paused" };
  // Manual/site pauses may resume only the last observed playing media, never
  // every paused element in a tab or a replacement that has never played.
  const candidates = Object.values(state.media).filter(item => item.tabId === tabId &&
    !item.playing && !item.ended && !item.hasError && item.observedPlaying &&
    item.playingAt >= (state.latestTarget?.playedAt || 0)).sort((a, b) => b.playingAt - a.playingAt);
  if (!candidates.length) {
    // Cold start (paused before install or browser start): only the candidate
    // picked by the last full scan, re-checked against the same global rule.
    const cold = state.media[state.coldCandidate];
    if (cold && cold.tabId === tabId && coldEligible(cold) &&
        !Object.values(state.media).some(item => item.observedPlaying || item.playing) &&
        Object.values(state.media).filter(coldEligible).length === 1)
      return { items: [cold], reason: "single-paused-media" };
    return { items: [], reason: "no-confirmed-resume-target" };
  }
  if (candidates.length > 1 && candidates[0].playingAt === candidates[1].playingAt)
    return { items: [], reason: "ambiguous-resume-target" };
  return { items: [candidates[0]], reason: "recent-media-paused" };
}

// Volume/speed act on what the toggle would act on: playing media in the
// latest tab, otherwise the media a resume would restart.
function adjustSelection(state, tabId) {
  const playing = playingInTab(state, tabId);
  if (playing.length) return { items: playing, reason: "playing" };
  const resume = resumeSelection(state, tabId);
  return { items: resume.items.map(item => state.media[mediaKey({ tabId, ...item }, item.mediaId)]).filter(Boolean),
    reason: resume.items.length ? "resume-target" : resume.reason };
}

// Pins tab, document, frame, media element and source generation, so a popup
// cannot adjust a replacement element or a new source it never displayed.
function selectionKey(tabId, items) {
  return tabId + "|" + items.map(item => [item.documentId, item.frameId, item.mediaId, item.sourceVersion || 0].join(":"))
    .sort().join(",");
}

function levelsFor(items) {
  const unique = (values) => {
    const known = values.filter(value => Number.isFinite(value));
    if (!known.length) return { value: null, mixed: false };
    return known.every(value => value === known[0]) ? { value: known[0], mixed: false } : { value: null, mixed: true };
  };
  const volume = unique(items.map(item => item.volume));
  const site = unique(items.map(item => item.siteVolume));
  const rate = unique(items.map(item => item.playbackRate));
  return {
    count: items.length,
    volume: volume.value, volumeMixed: volume.mixed,
    siteVolume: site.value, siteVolumeMixed: site.mixed,
    playbackRate: rate.value, rateMixed: rate.mixed,
    muted: items.length > 0 && items.every(item => item.muted === true),
    someMuted: items.some(item => item.muted === true),
    boosted: items.some(item => item.boosted === true),
    boostLimited: items.some(item => item.boostLimited === true),
    boostEnabled: settings.boostEnabled,
  };
}

function publicState(state) {
  const target = state.latestTarget;
  const playingCount = target ? playingInTab(state, target.tabId).length : 0;
  const pausedCount = target ? resumeSelection(state, target.tabId).items.length : 0;
  const adjust = target ? adjustSelection(state, target.tabId) : { items: [] };
  return {
    levels: levelsFor(adjust.items),
    adjustKey: target && adjust.items.length ? selectionKey(target.tabId, adjust.items) : "",
    version: VERSION,
    target: target ? { tabId: target.tabId, title: target.title || t("targetEmpty") } : null,
    status: target && targetUnknown(state, target.tabId) ? "unknown" : playingCount ? "playing" : pausedCount ? "paused" : "idle",
    playingCount, pausedCount, error: globalThis.mediaShortcutI18n.userError(state.error),
    tabVolume: target ? tabVolumeView(state, target.tabId) : null,
  };
}

// The tab's remembered extension volume, and whether playing media there still
// waits for a click on the page before the level can be applied.
function tabVolumeView(state, tabId) {
  const entry = state.tabVolumes[tabId];
  if (!entry || !settings.boostEnabled || entry.generation !== settings.generation) return null;
  const items = Object.values(state.media).filter(item => item.tabId === tabId);
  return { value: entry.value, pending: items.some(item => item.volumePending === true),
    refused: items.filter(item => item.volumeRefused === true).length,
    unconfirmed: Object.values(state.volumeUndoPending).filter(item => item.tabId === tabId).length };
}

// An undo that did not reach a document is kept until a reply shows the document at
// that revision or newer. It is dropped when the document goes away (navigation,
// tab close), when the option changes, or when a newer level replaced it.
function settleVolumeUndo(state, context, reply) {
  const key = documentKey(context);
  const pending = state.volumeUndoPending[key];
  if (pending && reply && Number.isInteger(reply.tabLevelRevision) && reply.tabLevelRevision >= pending.revision) {
    delete state.volumeUndoPending[key];
    return true;
  }
  return false;
}

async function retryVolumeUndos(state, onlyKey = "") {
  for (const [key, pending] of Object.entries(state.volumeUndoPending)) {
    if (onlyKey && key !== onlyKey) continue;
    const entry = state.tabVolumes[pending.tabId];
    const known = Object.values(state.observations).some(item => item.documentId === pending.documentId) ||
      Object.values(state.media).some(item => item.documentId === pending.documentId);
    if (!known || !settings.boostEnabled || !entry || entry.generation !== settings.generation ||
        pending.generation !== settings.generation || entry.revision < pending.revision) {
      delete state.volumeUndoPending[key];
      continue;
    }
    const reply = await sendTabVolume(pending, entry, 3000);
    if (!reply) continue;
    applyDocumentSnapshot(state, pending, reply);
    if (settleVolumeUndo(state, pending, reply)) diagnose(state, "control", pending, { code: "tab-volume-undo-retried" });
  }
}

// Every document in a tab this worker knows about (observed or with media).
function tabDocuments(state, tabId) {
  return new Map([...Object.values(state.observations), ...Object.values(state.media)]
    .filter(item => item.tabId === tabId && typeof item.documentId === "string")
    .map(item => [item.documentId, { tabId, documentId: item.documentId, frameId: item.frameId }]));
}

// extra: { pins, user } for a user command (see receiveTabLevel in content.js).
async function sendTabVolume(context, entry, milliseconds = 8000, extra = {}) {
  try {
    const reply = await withTimeout(chrome.tabs.sendMessage(context.tabId,
      { type: "TAB_VOLUME", value: entry.value, revision: entry.revision, generation: entry.generation, ...extra },
      { documentId: context.documentId }), milliseconds);
    return reply && Array.isArray(reply.media) ? reply : null;
  } catch {
    return null;
  }
}

function updateBadge(view) {
  chrome.action.setBadgeText({ text: view.error ? "!" : view.status === "playing" ? "▶" : view.status === "paused" ? "Ⅱ" : "" });
  chrome.action.setBadgeBackgroundColor({ color: view.error ? "#b42318" : view.status === "paused" ? "#2563eb" : "#087e55" });
  chrome.action.setTitle({ title: view.error || view.target?.title || t("extName") });
}

async function withTimeout(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("operation timeout")), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshMediaState(state) {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const presentTabs = new Set(tabs.filter((tab) => !tab.discarded).map((tab) => tab.id));
  const existingTabs = new Set(tabs.map((tab) => String(tab.id)));
  for (const tabId of Object.keys(state.tabVolumes)) if (!existingTabs.has(tabId)) delete state.tabVolumes[tabId];
  for (const [key, record] of Object.entries(state.media)) {
    if (!presentTabs.has(record.tabId)) {
      diagnose(state, "invalidate", record, { reason: "tab-unavailable" });
      delete state.media[key];
    }
  }
  state.pausedBatches = state.pausedBatches.filter((batch) => presentTabs.has(batch.tabId));
  for (const [key, observation] of Object.entries(state.observations)) {
    if (!presentTabs.has(observation.tabId)) delete state.observations[key];
  }
  for (const [key, connection] of Object.entries(state.connections)) {
    if (!presentTabs.has(connection.tabId)) delete state.connections[key];
  }
  if (state.latestTarget && !presentTabs.has(state.latestTarget.tabId)) state.latestTarget = null;

  const scans = await Promise.all(tabs.filter((tab) => Number.isInteger(tab.id) && !tab.discarded).map(async (tab) => {
    let topology = null;
    try { topology = await withTimeout(chrome.webNavigation.getAllFrames({ tabId: tab.id }), 2200); } catch { /* Navigation events remain authoritative. */ }
    try {
      const frames = await withTimeout(chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, files: ["content.js"], injectImmediately: true,
      }), 2200);
      return { tab, topology, frames: frames.filter((frame) => typeof frame.documentId === "string" && Array.isArray(frame.result?.media)) };
    } catch {
      return { tab, topology, frames: [] };
    }
  }));
  const failedTabs = new Set();
  // Failed scans of pages extensions may run on: their media is unknown.
  const unsupportedFailures = new Set();
  for (const { tab, frames, topology } of scans) {
    // Only a confirmed frame tree can prove that a document disappeared.
    if (Array.isArray(topology)) {
      const liveDocuments = new Set(topology.map(frame => frame.documentId));
      for (const collection of [state.media, state.observations, state.connections])
        for (const [key, item] of Object.entries(collection))
          if (item.tabId === tab.id && !liveDocuments.has(item.documentId)) {
            if (collection === state.media) diagnose(state, "invalidate", item, { reason: "document-navigation" });
            delete collection[key];
          }
    }
    const received = new Set(frames.map(frame => frame.documentId));
    const known = new Map(Object.values(state.media).filter(item => item.tabId === tab.id)
      .map(item => [item.documentId, item]));
    const missing = [...known.values()].filter(item => !received.has(item.documentId));
    if (!frames.length && !missing.length) missing.push({ tabId: tab.id, frameId: 0 });
    for (const context of missing) {
      const start = Date.now();
      try {
        const recovered = await withTimeout(chrome.scripting.executeScript({
          target: { tabId: tab.id, ...(context.documentId ? { documentIds: [context.documentId] } : { frameIds: [0] }) },
          files: ["content.js"], injectImmediately: true,
        }), 2200);
        const valid = recovered.filter(frame => typeof frame.documentId === "string" && Array.isArray(frame.result?.media));
        if (!valid.length) throw new Error("no snapshot");
        frames.push(...valid);
        diagnose(state, "reconnect", context, { durationMs: Date.now() - start, code: "recovered" });
      } catch {
        if (context.documentId) setConnection(state, context, "unknown");
        failedTabs.add(tab.id);
        const restricted = restrictedPage(tab.url);
        if (!restricted) unsupportedFailures.add(tab.id);
        diagnose(state, "reconnect", context, { durationMs: Date.now() - start, code: "unreachable", restricted });
      }
    }
    for (const frame of frames) applyDocumentSnapshot(state,
      { tabId: tab.id, documentId: frame.documentId, frameId: frame.frameId },
      frame.result, tab.title || frame.result.title);
  }
  pruneState(state);
  state.coldCandidate = unsupportedFailures.size ? "" : chooseColdCandidate(state, failedTabs);
  if (state.latestTarget && !failedTabs.has(state.latestTarget.tabId) &&
      !Object.values(state.media).some((item) => item.tabId === state.latestTarget.tabId)) {
    state.latestTarget = null;
  }
  if (!state.latestTarget) {
    const playing = Object.values(state.media).filter((item) => item.playing && !failedTabs.has(item.tabId))
      .sort((a, b) => b.playingAt - a.playingAt);
    const confirmed = playing.find(item => item.playingAt > 0);
    const tabCount = new Set(playing.map(item => item.tabId)).size;
    if (confirmed || tabCount === 1) {
      const item = confirmed || playing[0];
      state.latestTarget = { tabId: item.tabId, title: item.title, playedAt: item.playingAt, touchedAt: Date.now() };
      diagnose(state, "target", item, { reason: confirmed ? "confirmed-history" : "single-playing-tab" });
    } else if (tabCount > 1) {
      state.error = "errorAmbiguousTarget";
    } else if (state.coldCandidate) {
      const item = state.media[state.coldCandidate];
      state.latestTarget = { tabId: item.tabId, title: item.title, playedAt: 0, touchedAt: Date.now() };
      diagnose(state, "target", item, { reason: "single-paused-media" });
    }
  }
  if (state.latestTarget && !failedTabs.has(state.latestTarget.tabId) && state.error === "errorPageConnection") state.error = "";
  if (state.latestTarget && failedTabs.has(state.latestTarget.tabId)) state.error = "errorPageConnection";
  await retryPendingBoostResets(state);
  await retryVolumeUndos(state);
  return failedTabs;
}

// Sends BOOST_RESET to one document (never to whatever replaced it), falling
// back to the registry in the same isolated world. Returns the graph count or null.
async function resetBoostInDocument(context, generation = settings.generation) {
  try {
    const reply = await withTimeout(chrome.tabs.sendMessage(context.tabId, { type: "BOOST_RESET", generation },
      { documentId: context.documentId }), 2200);
    if (reply && Number.isInteger(reply.reset)) return reply.reset;
  } catch { /* Fall back to direct registry access below. */ }
  try {
    const [result] = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: context.tabId, documentIds: [context.documentId] },
      args: [generation],
      func: (resetGeneration) => {
        const registry = globalThis.__mediaShortcutBoost;
        if (!registry) return 0;
        registry.minGeneration = Math.max(registry.minGeneration || 0, resetGeneration + 1);
        if (resetGeneration < (registry.appliedGeneration || 0)) return registry.graphs.size;
        for (const graph of registry.graphs.values()) graph.gain.gain.value = 1;
        registry.tabLevel = null;
        registry.pending = false;
        clearInterval(registry.watchdog);
        registry.watchdog = 0;
        return registry.graphs.size;
      },
    }), 2200);
    if (Number.isInteger(result?.result)) return result.result;
  } catch { /* Unconfirmed. */ }
  return null;
}

async function retryPendingBoostResets(state) {
  if (settings.boostEnabled) { state.boostResetPending = {}; return; }
  for (const [key, context] of Object.entries(state.boostResetPending)) {
    if (!state.connections[key] || state.connections[key].status !== "connected") continue;
    const reset = await resetBoostInDocument(context);
    if (reset === null) continue;
    delete state.boostResetPending[key];
    diagnose(state, "control", context, { code: "boost-reset-retried", adjustCount: reset });
  }
}

async function sendToDocument(state, context, action, items, extra = {}) {
  const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  try {
    return await withTimeout(chrome.tabs.sendMessage(context.tabId,
      { type: "CONTROL", action, items, requestId, ...extra }, { documentId: context.documentId }), 8000);
  } catch {
    // A lost reply does not mean the control failed. Read its receipt; never replay a toggle.
    try {
      const frames = await withTimeout(chrome.scripting.executeScript({
        target: { tabId: context.tabId, documentIds: [context.documentId] }, files: ["content.js"], injectImmediately: true,
      }), 2200);
      const snapshot = frames.find(frame => frame.documentId === context.documentId)?.result;
      if (snapshot?.controlReceipt?.requestId === requestId) {
        diagnose(state, "control", context, { code: "reply-recovered" });
        return { ...snapshot.controlReceipt, ...snapshot };
      }
      if (snapshot) applyDocumentSnapshot(state, context, snapshot);
    } catch { /* Preserve last known state until the next command. */ }
    setConnection(state, context, "unknown");
    diagnose(state, "control", context, { code: "reply-unconfirmed" });
    return null;
  }
}

async function performControl(requestedAction, input = "popup") {
  const startedAt = Date.now();
  const state = await loadState();
  const commandId = startedAt.toString(36) + "-" + Math.random().toString(36).slice(2);
  diagnose(state, "command-start", state.latestTarget || {}, { commandId, input, reason: requestedAction });
  await saveState(state);
  state.error = "";
  const failedTabs = await refreshMediaState(state);
  const target = state.latestTarget;
  if (!target) state.error = state.error || "errorNoTarget";
  else if (failedTabs.has(target.tabId)) state.error = "errorPageConnection";
  else {
    const playing = playingInTab(state, target.tabId);
    const shouldPause = requestedAction === "pause" || requestedAction === "toggle" && playing.length > 0;
    if (shouldPause && !playing.length) state.error = "errorPauseNothing";
    else if (shouldPause) {
      const documents = new Map(Object.values(state.media).filter((item) => item.tabId === target.tabId)
        .map((item) => [item.documentId, item]));
      const results = await Promise.all([...documents.values()].map(async (context) =>
        ({ context, result: await sendToDocument(state, context, "pause") })));
      const pausedItems = [];
      for (const { context, result } of results) {
        if (!result) continue;
        applyDocumentSnapshot(state, context, result, target.title);
        for (const item of result.paused || []) {
          const record = state.media[mediaKey(context, item.mediaId)];
          if (recordMatches(record, item) && !record.playing) {
            pausedItems.push({ documentId: context.documentId, frameId: context.frameId, ...item });
          }
        }
      }
      if (pausedItems.length) {
        let batch = state.pausedBatches.find((item) => item.tabId === target.tabId);
        if (!batch) {
          batch = { tabId: target.tabId, title: target.title, items: [] };
          state.pausedBatches.push(batch);
        }
        const combined = new Map([...batch.items, ...pausedItems].map((item) =>
          [item.documentId + ":" + item.frameId + ":" + item.mediaId, item]));
        batch.items = [...combined.values()];
        batch.pausedAt = Date.now();
      }
      if (results.some(({ result }) => !result)) state.error = "errorPageConnection";
      else if (!pausedItems.length || results.some(({ result }) => result.media?.some((item) => item.playing))) {
        state.error = "errorControl";
      }
    } else {
      const selection = resumeSelection(state, target.tabId);
      const batch = { tabId: target.tabId, items: selection.items };
      diagnose(state, "resume-selection", target, { commandId, reason: selection.reason, resumeCount: batch.items.length });
      if (!batch.items.length) state.error = selection.reason === "ambiguous-resume-target" ? "errorResumeAmbiguous" : "errorResumeNothing";
      else {
        const documents = new Map(batch.items.map((item) => [item.documentId, { tabId: batch.tabId, ...item }]));
        const results = await Promise.all([...documents.values()].map(async (context) => ({
          context, result: await sendToDocument(state, context, "resume",
            batch.items.filter((item) => item.documentId === context.documentId)),
        })));
        let started = 0;
        let failed = 0;
        const failureCodes = [];
        for (const { context, result } of results) {
          if (!result) {
            failed++;
            continue;
          }
          started += result.started || 0;
          failed += result.failed || 0;
          for (const failure of result.failures || []) {
            if (!["media-invalid", "play-state-unconfirmed", "play-timeout", "play-blocked", "play-aborted", "play-rejected"].includes(failure.code)) continue;
            failureCodes.push(failure.code);
            diagnose(state, "control", { ...context, mediaId: failure.mediaId }, { code: failure.code, action: "resume", commandId });
          }
          const ownedBefore = batch.items.filter(item => item.documentId === context.documentId &&
            state.pausedBatches.some(owned => owned.tabId === batch.tabId && owned.items.some(candidate => sameMedia(context, candidate, item.mediaId))));
          applyDocumentSnapshot(state, context, result, target.title);
          // A failed extension play attempt may advance playbackVersion. Restore
          // only previously owned, still-paused media in the same live source.
          const failures = new Set(result.failedIds || (result.failed ? ownedBefore.map(item => item.mediaId).filter(id =>
            !(result.resumedIds || []).includes(id) && !(result.invalidIds || []).includes(id)) : []));
          for (const item of ownedBefore) {
            const record = state.media[mediaKey(context, item.mediaId)];
            if (!failures.has(item.mediaId) || !record || record.playing || record.ended || record.hasError ||
                record.signature !== item.signature || record.sourceVersion !== item.sourceVersion) continue;
            let owned = state.pausedBatches.find(entry => entry.tabId === target.tabId);
            if (!owned) { owned = { tabId: target.tabId, title: target.title, items: [] }; state.pausedBatches.push(owned); }
            owned.items = owned.items.filter(candidate => !sameMedia(context, candidate, item.mediaId));
            owned.items.push({ ...item, playbackVersion: record.playbackVersion });
            diagnose(state, "control", { ...context, mediaId: item.mediaId }, { code: "retry-preserved" });
          }
          for (const mediaId of [...(result.resumedIds || []), ...(result.invalidIds || [])]) {
            forgetPause(state, context, mediaId);
          }
        }
        if (results.some(({ result }) => !result)) state.error = "errorPageConnection";
        else if (failed) state.error = failureCodes.length === failed && failureCodes.every(code => code === "play-blocked") ? "errorResumeBlocked" :
          failureCodes.length === failed && failureCodes.every(code => code === "play-timeout") ? "errorResumeTimeout" : "errorResumeSome";
        else if (!started) state.error = "errorResumeNone";
      }
    }
  }
  diagnose(state, "command", target || {}, { commandId, code: state.error || "success", reason: requestedAction, input,
    playingCount: target ? playingInTab(state, target.tabId).length : 0,
    resumeCount: target ? resumeSelection(state, target.tabId).items.length : 0, durationMs: Date.now() - startedAt });
  await saveState(state);
  const view = publicState(state);
  updateBadge(view);
  return view;
}

function runControl(action, input) {
  return enqueue(() => performControl(action, input));
}

const VOLUME_STEP = 0.1;
const RATE_STEP = 0.25;

function formatRate(value) {
  return String(Math.round(value * 100) / 100);
}

function osdText(kind, levels) {
  if (kind === "volume") {
    if (levels.volumeMixed || levels.volume === null) return t("osdVolumeMixed");
    const percent = String(Math.round(levels.volume * 100));
    return t(levels.muted ? "osdVolumeMuted" : levels.volume > 1 ? "osdVolumeBoosted" : "osdVolume", percent);
  }
  if (levels.rateMixed || levels.playbackRate === null) return t("osdSpeedMixed");
  return t("osdSpeed", formatRate(levels.playbackRate));
}

// adjust = { kind: "volume" | "rate", mode: "delta" | "set", value }.
// expectedKey (popup only) pins the tab and documents the popup was showing.
// live (popup slider drag): skips the full page scan and diagnostics; the final
// value on release is sent without it.
async function performAdjust(adjust, input = "popup", expectedKey = "", live = false) {
  await settingsReady;
  const startedAt = Date.now();
  const state = await loadState();
  const commandId = startedAt.toString(36) + "-" + Math.random().toString(36).slice(2);
  const reason = "adjust-" + adjust.kind + "-" + adjust.mode;
  if (!live) {
    diagnose(state, "command-start", state.latestTarget || {}, { commandId, input, reason });
    await saveState(state);
  }
  state.error = "";
  const failedTabs = live ? new Set() : await refreshMediaState(state);
  const target = state.latestTarget;
  let applied = null;
  let partial = null;
  if (!target) state.error = state.error || "errorNoTarget";
  else if (failedTabs.has(target.tabId)) state.error = "errorPageConnection";
  else {
    const selection = adjustSelection(state, target.tabId);
    const key = selection.items.length ? selectionKey(target.tabId, selection.items) : "";
    if (!live) diagnose(state, "adjust-selection", target, { commandId, reason: selection.reason, adjustCount: selection.items.length });
    if (!selection.items.length) state.error = "errorAdjustNothing";
    else if (expectedKey && expectedKey !== key) state.error = "errorTargetChanged";
    else if (adjust.kind === "volume" && !settings.boostEnabled) {
      // The extension volume is opt-in; the site's own volume is never changed.
      state.error = "errorExtVolumeOff";
      if (input === "keyboard") {
        try { await withTimeout(chrome.tabs.sendMessage(target.tabId, { type: "OSD", text: t("osdExtVolumeOff") }, { frameId: 0 }), 1500); }
        catch { /* Optional feedback. */ }
      }
    }
    else if (adjust.kind === "volume") {
      // One level per tab. +/-10% moves from the remembered level (100% when none).
      const previous = state.tabVolumes[target.tabId];
      const base = previous && previous.generation === settings.generation ? previous.value : 1;
      const value = Math.round(Math.min(5, Math.max(0, adjust.mode === "set" ? adjust.value : base + adjust.value)) * 100) / 100;
      const entry = { value, revision: ++state.volumeRevision, generation: settings.generation };
      // TAB_VOLUME is absolute and carries its revision, so a lost reply is safely resent once.
      const deliver = async (context, extra = {}) => {
        let result = await sendTabVolume(context, entry, 8000, extra);
        if (!result) {
          result = await sendTabVolume(context, entry, 3000, extra);
          if (result && !live) diagnose(state, "control", context, { code: "tab-volume-retried", commandId });
        }
        return { context, result };
      };
      const codeOf = ({ result }) => typeof result?.code === "string" ? result.code : "";
      const selected = new Set(selection.items.map(item => item.documentId));
      const documents = [...tabDocuments(state, target.tabId).values()];
      // Phase 1: the documents the user acted on, pinned to the items that were shown.
      const first = await Promise.all(documents.filter(context => selected.has(context.documentId)).map(context =>
        deliver(context, { user: true, pins: selection.items.filter(item => item.documentId === context.documentId)
          .map(({ mediaId, signature, sourceVersion }) => ({ mediaId, signature, sourceVersion })) })));
      let results = first;
      let outcome = "";
      const accepted = first.filter(item => item.result && !codeOf(item));
      const lost = first.filter(item => !item.result);
      const invalid = first.some(item => codeOf(item) === "media-invalid");
      if (invalid || !accepted.length) {
        // A pinned item was replaced, or no document confirmed the level: the command
        // ends here and nothing spreads to other documents.
        outcome = invalid ? "errorTargetChanged" : lost.length ? "errorPageConnection" : "errorBoostRefused";
        if (accepted.length || lost.length) {
          // Undo under a newer revision in every document that may hold the level,
          // including those whose reply was lost. The worker keeps the previous level at
          // that revision, so a document that missed the undo gets it when it next plays.
          const undo = { value: previous ? previous.value : 1, revision: ++state.volumeRevision, generation: settings.generation };
          state.tabVolumes[target.tabId] = previous ? { ...previous, revision: undo.revision } : undo;
          const undone = await Promise.all([...accepted, ...lost].map(async (item) =>
            ({ context: item.context, result: await sendTabVolume(item.context, undo, 3000) })));
          for (const { context, result } of undone) {
            const key = documentKey(context);
            if (result) {
              applyDocumentSnapshot(state, context, result, target.title);
              if (result.tabLevelRevision >= undo.revision) delete state.volumeUndoPending[key];
            } else {
              state.volumeUndoPending[key] = { ...context, revision: undo.revision, generation: undo.generation };
              diagnose(state, "control", context, { code: "tab-volume-undo-unconfirmed", commandId });
            }
          }
        }
      } else {
        state.tabVolumes[target.tabId] = entry;
        results = [...first, ...await Promise.all(documents.filter(context => !selected.has(context.documentId))
          .map(context => deliver(context)))];
      }
      const adjusted = [];
      const failureCodes = [];
      for (const { context, result } of results) {
        if (!result) continue;
        applyDocumentSnapshot(state, context, result, target.title);
        settleVolumeUndo(state, context, result);
        for (const failure of result.failures || []) {
          if (!live) diagnose(state, "control", { ...context, mediaId: failure.mediaId }, { code: failure.code, action: "tab-volume", commandId });
          if (outcome !== "errorTargetChanged") failureCodes.push(failure.code);
        }
        if (outcome !== "errorTargetChanged") adjusted.push(...(result.adjusted || []));
      }
      applied = { ...levelsFor(adjusted), total: adjusted.length + failureCodes.length, tabVolume: outcome ? previous?.value ?? null : value };
      const waiting = failureCodes.filter(code => code === "boost-refused-activation").length;
      const refused = failureCodes.length - waiting;
      if (outcome) state.error = outcome;
      else if (results.some(({ context, result }) => !result && selected.has(context.documentId))) state.error = "errorPageConnection";
      else if (refused && !adjusted.length) state.error = failureCodes.every(code => String(code).startsWith("boost-refused")) ? "errorBoostRefused" : "errorControl";
      else if (refused) {
        state.error = "errorAdjustSome";
        partial = [String(adjusted.length), String(adjusted.length + failureCodes.length)];
      }
      if (input === "keyboard") {
        const osd = state.error === "errorBoostRefused" ? t("osdBoostRefused") :
          waiting ? t("osdVolumePending", String(Math.round(value * 100))) :
          t(value > 1 ? "osdVolumeBoosted" : "osdVolume", String(Math.round(value * 100)));
        try {
          await withTimeout(chrome.tabs.sendMessage(target.tabId, { type: "OSD", text: osd }, { frameId: 0 }), 1500);
        } catch { /* The on-page indicator is optional feedback. */ }
      }
    }
    else {
      const documents = new Map(selection.items.map(item => [item.documentId, item]));
      const results = await Promise.all([...documents.values()].map(async (record) => {
        const context = { tabId: target.tabId, documentId: record.documentId, frameId: record.frameId };
        const items = selection.items.filter(item => item.documentId === record.documentId)
          .map(({ mediaId, signature, sourceVersion }) => ({ mediaId, signature, sourceVersion }));
        return { context, result: await sendToDocument(state, context, "adjust", items,
          { adjust, boostAllowed: settings.boostEnabled, boostGeneration: settings.generation }) };
      }));
      const adjusted = [];
      const failureCodes = [];
      let failed = 0;
      for (const { context, result } of results) {
        // A lost reply is never retried: a repeated delta would apply twice.
        if (!result) continue;
        applyDocumentSnapshot(state, context, result, target.title);
        adjusted.push(...(result.adjusted || []));
        failed += result.failed || 0;
        for (const failure of result.failures || []) {
          failureCodes.push(failure.code);
          diagnose(state, "control", { ...context, mediaId: failure.mediaId }, { code: failure.code, action: "adjust", commandId });
        }
      }
      applied = { ...levelsFor(adjusted), total: selection.items.length };
      const boostRefused = failureCodes.length > 0 && failureCodes.every(code => String(code).startsWith("boost-refused"));
      if (results.some(({ result }) => !result)) state.error = "errorPageConnection";
      else if (!adjusted.length) state.error = boostRefused ? "errorBoostRefused" : "errorControl";
      else if (failed) {
        state.error = "errorAdjustSome";
        partial = [String(adjusted.length), String(selection.items.length)];
      }
      const osd = adjusted.length ? osdText(adjust.kind, applied) : boostRefused ? t("osdBoostRefused") : "";
      if (osd && input === "keyboard") {
        try {
          await withTimeout(chrome.tabs.sendMessage(target.tabId, { type: "OSD", text: osd }, { frameId: 0 }), 1500);
        } catch { /* The on-page indicator is optional feedback. */ }
      }
    }
  }
  if (!live) diagnose(state, "command", target || {}, { commandId, code: state.error || "success", reason, input,
    adjustCount: applied?.count || 0, durationMs: Date.now() - startedAt });
  await saveState(state);
  const view = publicState(state);
  // The stored error stays generic; this reply also says how many items changed.
  if (partial && state.error === "errorAdjustSome") view.error = t("errorAdjustPartial", partial);
  updateBadge(view);
  return { ...view, applied };
}

function validAdjust(value) {
  return Boolean(value) && ["volume", "rate"].includes(value.kind) && ["delta", "set"].includes(value.mode) &&
    Number.isFinite(value.value) && Math.abs(value.value) <= 16;
}

function runAdjust(adjust, input, expectedKey, live = false) {
  return enqueue(() => performAdjust(adjust, input, expectedKey, live));
}

// Turning the experiment off sets every gain back to 1 in all reachable frames
// and forbids new boosts; Web Audio paths already created stay until reload.
async function setBoostEnabled(enabled) {
  await settingsReady;
  settings = { boostEnabled: enabled, generation: (settings.generation || 0) + 1 };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  const state = await loadState();
  state.tabVolumes = {};
  state.volumeUndoPending = {};
  let reset = 0;
  let unreached = 0;
  if (!enabled) {
    // Drop documents that no longer exist before deciding what must be reset.
    await refreshMediaState(state);
    // Every document this extension has observed or controlled may hold a boost.
    // Each one is addressed by its documentId, so a navigation in between is never touched.
    const documents = new Map([...Object.values(state.observations), ...Object.values(state.media)]
      .filter(item => typeof item.documentId === "string")
      .map(item => [documentKey(item), { tabId: item.tabId, documentId: item.documentId, frameId: item.frameId }]));
    const outcomes = await Promise.all([...documents.entries()].map(async ([key, context]) =>
      ({ key, context, reset: await resetBoostInDocument(context) })));
    state.boostResetPending = {};
    for (const outcome of outcomes) {
      if (outcome.reset === null) {
        // Not "no boost": the reset is unconfirmed and is retried when the document reconnects.
        unreached++;
        state.boostResetPending[outcome.key] = outcome.context;
      } else reset += outcome.reset;
    }
  } else {
    state.boostResetPending = {};
  }
  const code = unreached ? "boost-reset-unreached" : "success";
  diagnose(state, "command", state.latestTarget || {}, { reason: enabled ? "boost-enable" : "boost-disable", code,
    adjustCount: reset, unreachedCount: unreached });
  await saveState(state);
  return { boostEnabled: enabled, connectedPaths: reset, unreachedFrames: unreached,
    error: unreached ? t("errorBoostResetUnreached", String(unreached)) : "" };
}

const ADJUST_COMMANDS = {
  "volume-up": { kind: "volume", mode: "delta", value: VOLUME_STEP },
  "volume-down": { kind: "volume", mode: "delta", value: -VOLUME_STEP },
  "speed-up": { kind: "rate", mode: "delta", value: RATE_STEP },
  "speed-down": { kind: "rate", mode: "delta", value: -RATE_STEP },
  "speed-reset": { kind: "rate", mode: "set", value: 1 },
};

async function removeNavigatedDocument(details) {
  const state = await loadState();
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: details.tabId });
    const current = frames?.find(frame => frame.frameId === details.frameId);
    if (current && current.documentId !== details.documentId) return;
  } catch { /* Tab closure cleanup and successful snapshots handle unavailable trees. */ }
  for (const [key, observation] of Object.entries(state.observations)) {
    if (observation.tabId === details.tabId &&
        (details.frameId === 0 || observation.frameId === details.frameId) && observation.documentId !== details.documentId) {
      delete state.observations[key];
      delete state.connections[key];
    }
  }
  for (const [key, item] of Object.entries(state.media)) {
    if (item.tabId !== details.tabId) continue;
    if ((details.frameId === 0 || item.frameId === details.frameId) && item.documentId !== details.documentId) {
      diagnose(state, "invalidate", item, { reason: "document-navigation" });
      delete state.media[key];
    }
  }
  for (const [key, pending] of Object.entries(state.volumeUndoPending)) {
    if (pending.tabId === details.tabId && (details.frameId === 0 || pending.frameId === details.frameId) &&
        pending.documentId !== details.documentId) delete state.volumeUndoPending[key];
  }
  pruneState(state);
  if (state.latestTarget?.tabId === details.tabId &&
      !Object.values(state.media).some((item) => item.tabId === details.tabId)) state.latestTarget = null;
  await saveState(state);
  updateBadge(publicState(state));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_DIAGNOSTICS" && !sender.tab) {
    enqueue(async () => ({ version: VERSION, entries: (await loadState()).diagnostics }))
      .then(sendResponse).catch(() => sendResponse({ entries: [] }));
    return true;
  }
  if (message?.type === "GET_STATE") {
    enqueue(async () => {
      const state = await loadState();
      await refreshMediaState(state);
      await saveState(state);
      const view = publicState(state);
      updateBadge(view);
      return view;
    }).then(sendResponse).catch(() => sendResponse({ status: "idle", error: t("errorStateRead") }));
    return true;
  }
  if (message?.type === "SET_BOOST" && isExtensionPage(sender)) {
    enqueue(() => setBoostEnabled(message.enabled === true)).then(sendResponse)
      .catch(() => sendResponse({ boostEnabled: settings.boostEnabled, error: t("errorControl") }));
    return true;
  }
  // Only extension pages (the popup) may adjust; content scripts report state only.
  if (message?.type === "ADJUST" && isExtensionPage(sender)) {
    if (!validAdjust(message.adjust)) {
      sendResponse({ status: "idle", error: t("errorControl") });
      return false;
    }
    const { kind, mode, value } = message.adjust;
    runAdjust({ kind, mode, value }, "popup", typeof message.expectedKey === "string" ? message.expectedKey : "",
      message.live === true && kind === "volume" && mode === "set")
      .then(sendResponse).catch(() => sendResponse({ status: "idle", error: t("errorControl") }));
    return true;
  }
  const actions = { TOGGLE: "toggle", PAUSE: "pause", RESUME: "resume" };
  if (Object.hasOwn(actions, message?.type)) {
    runControl(actions[message.type]).then(sendResponse)
      .catch(() => sendResponse({ status: "idle", error: t("errorControl") }));
    return true;
  }
  if (message?.type !== "MEDIA_STATE" || !Number.isInteger(sender.tab?.id) ||
      typeof sender.documentId !== "string" || !message.mediaId) return false;
  enqueue(async () => {
    const state = await loadState();
    const context = contextFor(sender);
    if (!acceptObservation(state, context, message)) return;
    setConnection(state, context, "connected");
    upsertMedia(state, context, message, sender.tab.title || message.title);
    if (state.boostResetPending[documentKey(context)]) await retryPendingBoostResets(state);
    if (state.volumeUndoPending[documentKey(context)]) {
      if (!settleVolumeUndo(state, context, message)) await retryVolumeUndos(state, documentKey(context));
    }
    const entry = state.tabVolumes[context.tabId];
    if (message.playing && settings.boostEnabled && entry && entry.generation === settings.generation &&
        Number.isInteger(message.tabLevelRevision) && message.tabLevelRevision < entry.revision) {
      const reply = await sendTabVolume(context, entry, 3000);
      if (reply) applyDocumentSnapshot(state, context, reply, sender.tab.title || message.title);
      diagnose(state, "control", context, { action: "tab-volume", adjustCount: reply?.adjusted?.length || 0,
        code: !reply ? "tab-volume-unconfirmed" : reply.failures?.[0]?.code || "tab-volume-delivered" });
    }
    diagnose(state, "media-event", { ...context, mediaId: message.mediaId }, { playing: Boolean(message.playing), transitioned: Boolean(message.transitioned),
      playbackVersion: message.playbackVersion, sourceVersion: message.sourceVersion, ended: Boolean(message.ended), hasError: Boolean(message.hasError),
      sequence: message.sequence, origin: message.origin });
    if (state.error === "errorPageConnection" && state.latestTarget && !targetUnknown(state, state.latestTarget.tabId)) state.error = "";
    await saveState(state);
    updateBadge(publicState(state));
  }).catch(() => undefined);
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  enqueue(async () => {
    const state = await loadState();
    for (const [key, item] of Object.entries(state.media)) if (item.tabId === tabId) {
      diagnose(state, "invalidate", item, { reason: "tab-closed" });
      delete state.media[key];
    }
    for (const [key, observation] of Object.entries(state.observations)) {
      if (observation.tabId === tabId) delete state.observations[key];
    }
    for (const [key, connection] of Object.entries(state.connections)) if (connection.tabId === tabId) delete state.connections[key];
    state.pausedBatches = state.pausedBatches.filter((batch) => batch.tabId !== tabId);
    delete state.tabVolumes[tabId];
    for (const [key, pending] of Object.entries(state.volumeUndoPending)) if (pending.tabId === tabId) delete state.volumeUndoPending[key];
    if (state.latestTarget?.tabId === tabId) state.latestTarget = null;
    await saveState(state);
    updateBadge(publicState(state));
  }).catch(() => undefined);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  enqueue(() => removeNavigatedDocument(details)).catch(() => undefined);
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-recent-media") runControl("toggle", "keyboard").catch(() =>
    updateBadge({ status: "idle", error: t("errorControl") }));
  else if (Object.hasOwn(ADJUST_COMMANDS, command)) runAdjust(ADJUST_COMMANDS[command], "keyboard").catch(() =>
    updateBadge({ status: "idle", error: t("errorControl") }));
});
function discoverOpenPages() {
  enqueue(async () => {
    const state = await loadState();
    await refreshMediaState(state);
    await saveState(state);
    updateBadge(publicState(state));
  }).catch(() => undefined);
}
chrome.runtime.onInstalled.addListener(discoverOpenPages);
chrome.runtime.onStartup.addListener(discoverOpenPages);
enqueue(async () => {
  const state = await loadState();
  const finished = new Set(state.diagnostics.filter(entry => ["command", "interrupted"].includes(entry.type)).map(entry => entry.commandId));
  for (const entry of state.diagnostics.filter(entry => entry.type === "command-start" && !finished.has(entry.commandId)))
    diagnose(state, "interrupted", entry, { commandId: entry.commandId, code: "worker-restarted", input: entry.input });
  await saveState(state);
  updateBadge(publicState(state));
}).catch(() => undefined);
