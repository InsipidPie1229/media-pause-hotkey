# Media Shortcut

Pause and resume standard HTML video and audio in the most recently playing Chrome tab, and adjust its volume and playback speed, including while another app is focused. The Manifest V3 extension supports 17 Chrome UI locales: English, Korean, Simplified and Traditional Chinese, Spanish, Hindi, Arabic, Brazilian Portuguese, French, Japanese, German, Russian, Indonesian, Turkish, Vietnamese, Italian, and Bengali. It follows Chrome's display language and falls back to English.

## Install

1. Extract the ZIP to a folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `MediaPauseHotkey` folder.
5. On install or browser startup, the extension injects its observer into already-open HTTP/HTTPS tabs. Reload a tab only if it still does not appear in the popup. Chrome internal pages are not supported.

## Set a global shortcut

1. Open `chrome://extensions/shortcuts`.
2. Set a key for **Media Shortcut** → **Pause or resume web media in the most recently playing tab**.
3. The default scope is **Global**. Choose **In Chrome** in the scope menu if you want the shortcut to work only in Chrome. Available global combinations depend on Chrome and other apps.
4. When the scope is Global, switch to another app and check the shortcut there.

No key combination is assigned by default. The popup shows the current shortcut, and its pause/resume buttons work even before a key is assigned.

The same page also lists five optional volume and speed shortcuts (volume up/down 10%, speed up/down 0.25×, reset speed to 1×). None has a default key.

## Behavior and limitations

- A tab becomes the control target when its video or audio actually starts playing. Starting media in another tab changes the target.
- The shortcut pauses all standard `<audio>` and `<video>` elements playing in that tab, including accessible frames. Resume restores the media paused by this extension. If no such media remains, it resumes the most recently played eligible element in that tab, even if paused using the site or a media key. Unplayed elements and older manually paused siblings remain stopped.
- Web Audio-only players, Chrome internal pages, and inaccessible frames are outside the supported scope.
- A website may reject resuming under its autoplay policy; the popup reports failures.
- The page title and media state are stored only in Chrome's session storage. No data is sent to an external server.
- Read the [privacy policy](privacy.html) for details about temporary local processing.

## Volume and speed (1.1.0)

- Volume and speed act on the same media the pause/resume shortcut would control: media playing in the most recently playing tab, or, if none is playing, the media a resume would restart.
- Shortcuts change volume by 10% (0–100%) and speed by 0.25× (0.25×–4×), relative to each media item's current value. The popup slider and the 1× button set the same absolute value on every item.
- If the targeted items have different values, the popup shows **Mixed**.
- Adjusting never plays, pauses, or changes which tab or media is the control target. Volume changes do not unmute media that the page muted; the popup shows a note instead.
- Using a shortcut shows a small indicator with the applied value at the top of the page for one second. It does not block clicks. Native video fullscreen can hide it.
- If a reply from the page is lost, the change is not sent again, so a step is never applied twice.
- Limitations: sites with their own volume control (for example YouTube) do not update their slider, and a site may reset speed when the next video starts. Boost above 100% is not supported.

## Updating to 1.0.6

Replace files in the folder Chrome already loads, reload the extension at `chrome://extensions`, and confirm version **1.0.6**. Avoid installing a second copy. Existing page controllers and their history may be replaced during the update; play the intended media once after updating if needed.

Version 1.0.6 allows the most recently played media to resume after a site, mouse, keyboard or media-key pause. It uses confirmed playback history in the same live document and source. It never starts every paused element, guesses a replacement, or restarts ended media. When an extension pause batch remains valid, that batch takes priority. Unknown/tied playback history is not guessed. Pause history and message ordering metadata do not expire just because six hours pass; the bounded cache still removes records for confirmed navigation, source replacement and closed tabs.

Existing event-loss recovery, document reconnection, and control receipts remain in place. Diagnostics now distinguish keyboard and popup commands, record media counts, and explain resume selection. Diagnostics retain up to 100 command/error entries and 100 observation entries, with command IDs, input origin, start/completion, selection and invalidation reasons. Entries stay in session storage without titles or URLs and can be copied from the popup. The installed version is visible in the popup. No data is sent to a server. Resume waits up to six seconds and the worker waits up to eight seconds for its control response. Failed extension resume attempts preserve valid pause ownership for retry. The popup supports 17 locales; no permissions were added. Automatic loop restarts still count as new playback and may switch the target tab.

See the accompanying `MediaPauseHotkey-1.0.6-검증결과.md` report for measured results. Tests in isolated profiles do not establish OS global-key delivery or resolve every intermittent issue in a normal user profile.

## Remove

Remove **Media Shortcut** from `chrome://extensions`.
