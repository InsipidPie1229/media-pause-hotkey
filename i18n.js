(() => {
  const defaults = {
    extName: "Media Shortcut",
    popupEyebrow: "CHROME MEDIA",
    recentTab: "Most recently playing tab",
    targetEmpty: "No media tab yet",
    stateChecking: "Checking media status…",
    statePlaying: "$1 media playing",
    statePaused: "$1 media available to resume",
    stateIdle: "Play media to control it here.",
    stateUnknown: "Unable to confirm media status.",
    errorAmbiguousTarget: "Media is playing in multiple tabs. Start playback in the tab you want to control.",
    buttonDiagnostics: "Copy diagnostics",
    diagnosticsCopied: "Diagnostics copied.",
    diagnosticsCopyFailed: "Could not copy diagnostics. Copy the text below.",
    buttonToggle: "Pause / Resume",
    buttonPause: "Pause",
    buttonResume: "Resume",
    errorPauseNothing: "No media is playing in the latest tab.",
    errorResumeNothing: "No previously played media is available to resume in the latest tab.",
    errorNoTarget: "No media to control. Start playback once, then try again.",
    errorPageConnection: "Could not reach the page. Try the shortcut again when the page responds.",
    errorResumeSome: "Some media could not resume. Check the popup.",
    errorResumeBlocked: "The browser blocked playback. Start media on the site, then try again.",
    errorResumeTimeout: "Playback did not start within six seconds. Try the shortcut again.",
    errorResumeAmbiguous: "Several media items have the same playback order. Play the item you want on the site once, then try again.",
    errorResumeNone: "Could not find media to resume. Refresh the tab and try again.",
    errorStateRead: "Could not read extension status.",
    errorControl: "Could not control media.",
    shortcutHeading: "Global shortcut",
    shortcutNotSet: "Not set",
    shortcutSettings: "Open shortcut settings",
    shortcutHint: "Global by default. Change the scope to Chrome if you prefer.",
    footer: "Controls video and audio on HTTP and HTTPS pages.",
    statusLabel: "Media status",
    volumeHeading: "Volume",
    speedHeading: "Speed",
    levelMixed: "Mixed",
    levelMutedNote: "Muted on the page. Volume changes do not unmute.",
    buttonSpeedDown: "Slower",
    buttonSpeedUp: "Faster",
    buttonSpeedReset: "1×",
    osdVolume: "Volume $1%",
    osdVolumeMuted: "Volume $1% (muted)",
    osdVolumeMixed: "Volume: mixed",
    osdSpeed: "Speed $1×",
    osdSpeedMixed: "Speed: mixed",
    errorAdjustNothing: "No media to adjust in the latest tab.",
    errorAdjustSome: "Some media could not be adjusted.",
    errorTargetChanged: "The latest media tab changed. Check the popup and try again.",
    shortcutsMoreHint: "Volume and speed shortcuts can also be set on the same page.",
    boostToggle: "Use extension volume (experimental)",
    boostHint: "Adds its own 0–500% volume on top of the site's volume. Media you adjust uses the browser's audio processing until the page is reloaded.",
    boostActiveNote: "Boosted. Loud sound may distort.",
    boostLimitedNote: "A source change may limit output for boosted media. Reload the page if you hear nothing.",
    boostOffNote: "Extension volume is off and back to 100%. Media adjusted before keeps the audio path until the page is reloaded.",
    osdVolumeBoosted: "Volume $1% (boosted)",
    osdBoostRefused: "Extension volume unavailable here",
    errorBoostRefused: "Extension volume isn't available for this media. The volume was kept.",
    errorAdjustPartial: "$1 of $2 media items were adjusted.",
    siteVolumeNote: "Site volume $1%",
    extVolumeHint: "100% keeps the site's own sound. If the site is at 0% or muted, the extension does not bring the sound back.",
    errorExtVolumeOff: "Extension volume is off. Turn it on in the popup to change volume.",
    osdExtVolumeOff: "Extension volume is off",
    errorBoostResetUnreached: "Extension volume is off, but resetting it could not be confirmed in $1 page frames. It will be retried when they respond; reloading those pages also removes it.",
  };

  function message(key, substitutions) {
    try {
      const value = chrome.i18n.getMessage(key, substitutions);
      if (value && value !== key && !value.includes("__MSG_")) return value;
    } catch {
      // A readable default also covers incomplete locale files.
    }
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return (defaults[key] || defaults.errorControl).replace(/\$(\d+)/g,
      (_match, index) => String(values[Number(index) - 1] ?? ""));
  }

  function userError(value) {
    if (typeof value !== "string" || !value) return "";
    const key = value.match(/^__MSG_(\w+)__$/)?.[1] || value;
    if (Object.hasOwn(defaults, key)) return message(key);
    if (value.includes("__MSG_") || /^error[A-Z]\w*$/.test(value)) return message("errorControl");
    return value;
  }

  globalThis.mediaShortcutI18n = { message, userError };
})();
