const elements = {
  targetTitle: document.getElementById("targetTitle"),
  targetState: document.getElementById("targetState"),
  statusDot: document.getElementById("statusDot"),
  errorMessage: document.getElementById("errorMessage"),
  shortcutValue: document.getElementById("shortcutValue"),
  toggleButton: document.getElementById("toggleButton"),
  pauseButton: document.getElementById("pauseButton"),
  resumeButton: document.getElementById("resumeButton"),
  volumeSlider: document.getElementById("volumeSlider"),
  volumeValue: document.getElementById("volumeValue"),
  speedValue: document.getElementById("speedValue"),
  speedDownButton: document.getElementById("speedDownButton"),
  speedUpButton: document.getElementById("speedUpButton"),
  speedResetButton: document.getElementById("speedResetButton"),
  mutedNote: document.getElementById("mutedNote"),
};

const t = globalThis.mediaShortcutI18n.message;
const actionButtons = [elements.toggleButton, elements.pauseButton, elements.resumeButton];
const adjustControls = [elements.volumeSlider, elements.speedDownButton, elements.speedUpButton, elements.speedResetButton];

let adjustKey = "";
let adjusting = false;
let sliderActive = false;

function localizePopup() {
  document.documentElement.lang = chrome.i18n.getUILanguage() || "en";
  document.documentElement.dir = chrome.i18n.getMessage("@@bidi_dir") === "rtl" ? "rtl" : "ltr";
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
}

localizePopup();

function formatRate(rate) {
  return String(Math.round(rate * 100) / 100) + "×";
}

function showLevels(state) {
  const levels = state.levels;
  const hasLevels = Boolean(levels && levels.count > 0);
  for (const control of adjustControls) control.disabled = !hasLevels || adjusting;
  if (!hasLevels) {
    elements.volumeValue.textContent = "–";
    elements.speedValue.textContent = "–";
  } else {
    if (levels.volumeMixed || levels.volume === null) {
      elements.volumeValue.textContent = t("levelMixed");
    } else {
      elements.volumeValue.textContent = Math.round(levels.volume * 100) + "%";
      if (!sliderActive) elements.volumeSlider.value = String(Math.round(levels.volume * 100));
    }
    if (levels.rateMixed || levels.playbackRate === null) {
      elements.speedValue.textContent = t("levelMixed");
    } else {
      elements.speedValue.textContent = formatRate(levels.playbackRate);
    }
  }
  elements.mutedNote.hidden = !levels?.someMuted;
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
    await loadState();
  }
}

elements.toggleButton.addEventListener("click", () => run("TOGGLE"));
elements.pauseButton.addEventListener("click", () => run("PAUSE"));
elements.resumeButton.addEventListener("click", () => run("RESUME"));

elements.volumeSlider.addEventListener("pointerdown", () => { sliderActive = true; });
elements.volumeSlider.addEventListener("input", () => {
  sliderActive = true;
  elements.volumeValue.textContent = Math.round(elements.volumeSlider.valueAsNumber) + "%";
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
elements.speedResetButton.addEventListener("click", () => runAdjust({ kind: "rate", mode: "set", value: 1 }));

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
loadState();
