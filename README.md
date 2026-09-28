# Media Shortcut

Pause and resume standard HTML video and audio in the most recently playing Chrome tab, including while another app is focused. The Manifest V3 extension supports 17 Chrome UI locales: English, Korean, Simplified and Traditional Chinese, Spanish, Hindi, Arabic, Brazilian Portuguese, French, Japanese, German, Russian, Indonesian, Turkish, Vietnamese, Italian, and Bengali. It follows Chrome's display language and falls back to English.

## Install

1. Extract the ZIP to a folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `MediaPauseHotkey` folder.
5. Reload pages that were already open. Chrome internal pages are not supported.

## Set a global shortcut

1. Open `chrome://extensions/shortcuts`.
2. Set a key for **Media Shortcut** → **Pause or resume web media in the most recently playing tab**.
3. The default scope is **Global**. Choose **In Chrome** in the scope menu if you want the shortcut to work only in Chrome. Available global combinations depend on Chrome and other apps.
4. When the scope is Global, switch to another app and check the shortcut there.

No key combination is assigned by default. The popup shows the current shortcut, and its pause/resume buttons work even before a key is assigned.

## Behavior and limitations

- A tab becomes the control target when its video or audio actually starts playing. Starting media in another tab changes the target.
- The shortcut pauses all standard `<audio>` and `<video>` elements playing in that tab, including accessible frames. Resume affects only media this extension paused.
- Web Audio-only players, Chrome internal pages, and inaccessible frames are outside the supported scope.
- A website may reject resuming under its autoplay policy; the popup reports failures.
- The page title and media state are stored only in Chrome's session storage. No data is sent to an external server.
- Read the [privacy policy](privacy.html) for details about temporary local processing.

## Remove

Remove **Media Shortcut** from `chrome://extensions`.
