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

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function showState(state) {
  elements.targetTitle.textContent = state.target?.title || t("targetEmpty");
  elements.statusDot.className = `status-dot ${state.error ? "error" : state.status || ""}`;
  if (state.status === "playing") {
    elements.targetState.textContent = t("statePlaying", String(state.playingCount || 1));
  } else if (state.status === "paused") {
    elements.targetState.textContent = t("statePaused", String(state.pausedCount));
  } else {
    elements.targetState.textContent = t("stateIdle");
  }
  elements.errorMessage.textContent = state.error || "";
  elements.errorMessage.hidden = !state.error;
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
loadState();
