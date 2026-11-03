const elements = {
  targetTitle: document.getElementById("targetTitle"),
  targetState: document.getElementById("targetState"),
  statusDot: document.getElementById("statusDot"),
  errorMessage: document.getElementById("errorMessage"),
  shortcutValue: document.getElementById("shortcutValue"),
  toggleButton: document.getElementById("toggleButton"),
  pauseButton: document.getElementById("pauseButton"),
  resumeButton: document.getElementById("resumeButton"),
};

const t = globalThis.mediaShortcutI18n.message;

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

function showState(state) {
  document.getElementById("extensionVersion").textContent = "v" + (state.version || chrome.runtime.getManifest?.().version || "1.0.6");
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
  for (const button of [elements.toggleButton, elements.pauseButton, elements.resumeButton]) button.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: action });
    showState(state);
  } catch {
    showState({ status: "idle", error: t("errorControl") });
  } finally {
    for (const button of [elements.toggleButton, elements.pauseButton, elements.resumeButton]) button.disabled = false;
    await loadState();
  }
}

elements.toggleButton.addEventListener("click", () => run("TOGGLE"));
elements.pauseButton.addEventListener("click", () => run("PAUSE"));
elements.resumeButton.addEventListener("click", () => run("RESUME"));
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
