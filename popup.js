const elements = {
  targetTitle: document.getElementById("targetTitle"),
  targetState: document.getElementById("targetState"),
  statusDot: document.getElementById("statusDot"),
  errorMessage: document.getElementById("errorMessage"),
  shortcutValue: document.getElementById("shortcutValue"),
  toggleButton: document.getElementById("toggleButton"),
  pauseButton: document.getElementById("pauseButton"),
  resumeButton: document.getElementById("resumeButton"),
  mixer: document.getElementById("mixer"),
  fader: document.getElementById("fader"),
  volumeSlider: document.getElementById("volumeSlider"),
  volumeValue: document.getElementById("volumeValue"),
  volumeScale: document.getElementById("volumeScale"),
  speedValue: document.getElementById("speedValue"),
  speedDownButton: document.getElementById("speedDownButton"),
  speedUpButton: document.getElementById("speedUpButton"),
  speedResetButton: document.getElementById("speedResetButton"),
  mutedNote: document.getElementById("mutedNote"),
  boostNote: document.getElementById("boostNote"),
  boostToggle: document.getElementById("boostToggle"),
};

const t = globalThis.mediaShortcutI18n.message;
const actionButtons = [elements.toggleButton, elements.pauseButton, elements.resumeButton];
const speedChips = [...document.querySelectorAll(".speed .chip")];
const adjustControls = [elements.volumeSlider, elements.speedDownButton, elements.speedUpButton, ...speedChips];

let adjustKey = "";
let adjusting = false;
let sliderActive = false;
let boostEnabled = false;
let boostOffPaths = 0;

function localizePopup() {
  document.documentElement.lang = chrome.i18n.getUILanguage() || "en";
  document.documentElement.dir = chrome.i18n.getMessage("@@bidi_dir") === "rtl" ? "rtl" : "ltr";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-title]")) {
    element.title = t(element.dataset.i18nTitle);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
  for (const chip of speedChips) chip.setAttribute("aria-label", t("osdSpeed", chip.dataset.rate));
}

localizePopup();

function formatRate(rate) {
  return String(Math.round(rate * 100) / 100) + "×";
}

// Paint the fader: filled part, the 100% detent and the boost zone.
function paintFader() {
  const max = Number(elements.volumeSlider.max);
  const value = elements.volumeSlider.valueAsNumber;
  elements.fader.style.setProperty("--fill", (value / max) * 100 + "%");
  elements.fader.style.setProperty("--detent", (100 / max) * 100 + "%");
  elements.fader.style.setProperty("--detent-ratio", String(100 / max));
  elements.fader.classList.toggle("has-boost", max > 100);
  elements.volumeScale.hidden = max <= 100;
}

function setBoostRange(enabled) {
  boostEnabled = enabled;
  elements.boostToggle.checked = enabled;
  document.getElementById("boostSection").classList.toggle("is-on", enabled);
  elements.volumeSlider.max = enabled ? "300" : "100";
  elements.volumeSlider.setAttribute("aria-valuetext", Math.round(elements.volumeSlider.valueAsNumber) + "%");
  paintFader();
}

function showBoostNote(levels) {
  let key = "";
  if (levels?.boostLimited) key = "boostLimitedNote";
  else if (levels?.boosted) key = "boostActiveNote";
  else if (!boostEnabled && boostOffPaths > 0) key = "boostOffNote";
  elements.boostNote.textContent = key ? t(key) : "";
  elements.boostNote.hidden = !key;
}

function showLevels(state) {
  const levels = state.levels;
  if (typeof levels?.boostEnabled === "boolean") setBoostRange(levels.boostEnabled);
  const hasLevels = Boolean(levels && levels.count > 0);
  for (const control of adjustControls) control.disabled = !hasLevels || adjusting;
  if (!hasLevels) {
    elements.volumeValue.textContent = "–";
    elements.speedValue.textContent = "–";
    for (const chip of speedChips) chip.setAttribute("aria-pressed", "false");
  } else {
    if (levels.volumeMixed || levels.volume === null) {
      elements.volumeValue.textContent = t("levelMixed");
    } else {
      elements.volumeValue.textContent = Math.round(levels.volume * 100) + "%";
      if (!sliderActive) {
        elements.volumeSlider.value = String(Math.round(levels.volume * 100));
        elements.volumeSlider.setAttribute("aria-valuetext", elements.volumeValue.textContent);
      }
    }
    const rate = levels.rateMixed ? null : levels.playbackRate;
    elements.speedValue.textContent = rate === null ? t("levelMixed") : formatRate(rate);
    for (const chip of speedChips) chip.setAttribute("aria-pressed", String(rate !== null && Number(chip.dataset.rate) === rate));
  }
  elements.mixer.classList.toggle("is-boosted", Boolean(levels?.boosted));
  elements.mutedNote.hidden = !levels?.someMuted;
  showBoostNote(levels);
  paintFader();
  adjustKey = typeof state.adjustKey === "string" ? state.adjustKey : "";
}

function showState(state) {
  document.getElementById("extensionVersion").textContent = "v" + chrome.runtime.getManifest().version;
  showLevels(state);
  elements.targetTitle.textContent = state.target?.title || t("targetEmpty");
  const error = globalThis.mediaShortcutI18n.userError(state.error);
  const status = ["playing", "paused", "idle", "unknown"].includes(state.status) ? state.status : "idle";
  elements.statusDot.className = `status-dot ${error ? "error" : status}`;
  if (state.status === "unknown") {
    elements.targetState.textContent = t("stateUnknown");
  } else if (state.status === "playing") {
    elements.targetState.textContent = t("statePlaying", String(state.playingCount || 0));
  } else if (state.status === "paused") {
    elements.targetState.textContent = t("statePaused", String(state.pausedCount));
  } else {
    elements.targetState.textContent = t("stateIdle");
  }
  elements.errorMessage.textContent = error;
  elements.errorMessage.hidden = !error;
}

async function loadState() {
  try {
    showState(await chrome.runtime.sendMessage({ type: "GET_STATE" }));
    // Two frames: the loaded state is painted before transitions are enabled.
    requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add("ready")));
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === "toggle-recent-media");
    elements.shortcutValue.textContent = command?.shortcut || t("shortcutNotSet");
  } catch {
    showState({ status: "idle", error: t("errorStateRead") });
  }
}

async function run(action) {
  for (const button of actionButtons) button.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: action });
    showState(state);
  } catch {
    showState({ status: "idle", error: t("errorControl") });
  } finally {
    for (const button of actionButtons) button.disabled = false;
    await loadState();
  }
}

async function runAdjust(adjust) {
  adjusting = true;
  for (const control of [...adjustControls, ...actionButtons]) control.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "ADJUST", adjust, expectedKey: adjustKey });
    showState(state);
  } catch {
    showState({ status: "idle", error: t("errorControl") });
  } finally {
    adjusting = false;
    for (const button of actionButtons) button.disabled = false;
    // Keep the reply's message (for example a partial result) visible after refreshing.
    const message = elements.errorMessage.hidden ? "" : elements.errorMessage.textContent;
    await loadState();
    if (message && elements.errorMessage.hidden) {
      elements.errorMessage.textContent = message;
      elements.errorMessage.hidden = false;
    }
  }
}

elements.toggleButton.addEventListener("click", () => run("TOGGLE"));
elements.pauseButton.addEventListener("click", () => run("PAUSE"));
elements.resumeButton.addEventListener("click", () => run("RESUME"));

elements.volumeSlider.addEventListener("pointerdown", () => { sliderActive = true; });
elements.volumeSlider.addEventListener("input", () => {
  sliderActive = true;
  const value = Math.round(elements.volumeSlider.valueAsNumber);
  elements.volumeValue.textContent = value + "%";
  elements.volumeSlider.setAttribute("aria-valuetext", value + "%");
  elements.mixer.classList.toggle("is-boosted", value > 100);
  paintFader();
});
elements.volumeSlider.addEventListener("change", () => {
  sliderActive = false;
  runAdjust({ kind: "volume", mode: "set", value: elements.volumeSlider.valueAsNumber / 100 });
});
elements.volumeSlider.addEventListener("pointerup", () => { sliderActive = false; });
elements.volumeSlider.addEventListener("pointercancel", () => { sliderActive = false; });
elements.volumeSlider.addEventListener("blur", () => { sliderActive = false; });

elements.speedDownButton.addEventListener("click", () => runAdjust({ kind: "rate", mode: "delta", value: -0.25 }));
elements.speedUpButton.addEventListener("click", () => runAdjust({ kind: "rate", mode: "delta", value: 0.25 }));
for (const chip of speedChips) {
  chip.addEventListener("click", () => runAdjust({ kind: "rate", mode: "set", value: Number(chip.dataset.rate) }));
}

elements.boostToggle.addEventListener("change", async () => {
  const enabled = elements.boostToggle.checked;
  elements.boostToggle.disabled = true;
  let message = "";
  try {
    const reply = await chrome.runtime.sendMessage({ type: "SET_BOOST", enabled });
    boostOffPaths = enabled ? 0 : reply?.connectedPaths || 0;
    setBoostRange(reply?.boostEnabled === true);
    message = typeof reply?.error === "string" ? reply.error : "";
  } catch {
    message = t("errorControl");
  } finally {
    elements.boostToggle.disabled = false;
    await loadState();
    // Turning boost off reports frames it could not reach instead of claiming success.
    if (message) {
      elements.errorMessage.textContent = message;
      elements.errorMessage.hidden = false;
    }
  }
});

document.getElementById("shortcutLink").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
document.getElementById("diagnosticsButton").addEventListener("click", async () => {
  const text = document.getElementById("diagnosticsText");
  const status = document.getElementById("diagnosticsStatus");
  try {
    const data = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS" });
    text.value = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text.value);
      text.hidden = true;
      status.textContent = t("diagnosticsCopied");
    } catch {
      text.hidden = false; text.focus(); text.select();
      status.textContent = t("diagnosticsCopyFailed");
    }
  } catch { status.textContent = t("errorStateRead"); }
});
paintFader();
loadState();
