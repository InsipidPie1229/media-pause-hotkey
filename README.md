# Media Shortcut

Pause and resume standard HTML video and audio in the most recently playing Chrome tab, and adjust its playback speed and an optional extension volume, including while another app is focused. The Manifest V3 extension supports 17 Chrome UI locales: English, Korean, Simplified and Traditional Chinese, Spanish, Hindi, Arabic, Brazilian Portuguese, French, Japanese, German, Russian, Indonesian, Turkish, Vietnamese, Italian, and Bengali. It follows Chrome's display language and falls back to English.

## Install

1. Extract the ZIP to a folder.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `MediaPauseHotkey` folder.
5. On install or browser startup, the extension injects its observer into already-open HTTP/HTTPS tabs. Reload a tab only if it still does not appear in the popup. Chrome internal pages are not supported.

## Set a global shortcut

Since 1.3.1, pause/resume has a suggested global shortcut: **Ctrl+Shift+1** (Windows/Linux) or **Command+Shift+1** (macOS). Chrome only accepts Ctrl+Shift+0–9 as a default global key, so easier combinations cannot be preset. Note that a global key is taken from every app while Chrome runs (for example, Ctrl+Shift+1 is a number-format shortcut in Excel). Chrome assigns it on install, and on update only when you had no key for that command before. A key you chose yourself, or a key you removed on purpose, is kept as it is. If another extension already uses the same key, Chrome leaves this command without a key. ChromeOS does not support global scope. A registered key does not guarantee that the operating system or another app delivers it to Chrome.

To change it (you can also pick other combinations such as Ctrl+Shift+Space and keep the scope Global):

1. Open `chrome://extensions/shortcuts`.
2. Set a key for **Media Shortcut** → **Pause or resume web media in the most recently playing tab**.
3. The default scope is **Global**. Choose **In Chrome** in the scope menu if you want the shortcut to work only in Chrome. Available global combinations depend on Chrome and other apps.
4. When the scope is Global, switch to another app and check the shortcut there.

The popup shows the key actually assigned (or **Not set**), and its pause/resume buttons work without any key.

The same page also lists five optional shortcuts (extension volume up/down 10%, speed up/down 0.25×, reset speed to 1×). These have no default key.

## Behavior and limitations

- A tab becomes the control target when its video or audio actually starts playing. Starting media in another tab changes the target.
- The shortcut pauses all standard `<audio>` and `<video>` elements playing in that tab, including accessible frames. Resume restores the media paused by this extension. If no such media remains, it resumes the most recently played eligible element in that tab, even if paused using the site or a media key. Unplayed elements and older manually paused siblings remain stopped.
- Since 1.3.2, media that was already paused before the extension was installed or Chrome started can also be resumed, but only when nothing in any tab has been seen playing and exactly one paused element is currently unmuted, has volume above 0 and has played ranges (seeking alone does not count). If an ordinary page could not be scanned, nothing is resumed this way. This rule cannot tell whether that element is the one you meant (for example, a single unmuted preview).
- Web Audio-only players, Chrome internal pages, and inaccessible frames are outside the supported scope.
- A website may reject resuming under its autoplay policy; the popup reports failures.
- The page title and media state are stored only in Chrome's session storage. No data is sent to an external server.
- Read the [privacy policy](privacy.html) for details about temporary local processing.

## Speed

- Speed acts on the same media the pause/resume shortcut would control: media playing in the most recently playing tab, or, if none is playing, the media a resume would restart.
- Shortcuts change speed by 0.25× (0.25×–4×) relative to each item; the popup presets (0.75–2×) set the same value on every item. Different values show as **Mixed**.
- Adjusting never plays, pauses, or changes which tab or media is the control target. Shortcuts show the applied value at the top of the page for one second without blocking clicks; native video fullscreen can hide it.
- If a reply from the page is lost, the change is not sent again, so a step is never applied twice. A site may reset speed when the next video starts.

## Extension volume (experimental, 1.3.0)

- The extension has its own volume, separate from the site's volume control. It never changes the site's volume or mute state, so the site's slider (for example YouTube's) stays as you set it. What you hear is roughly *site volume × extension volume*: site 60% with extension 200% plays louder than the site alone, and 100% keeps the site's own sound.
- Range 0–500%, in 10% steps with the shortcuts. Every media item starts at 100%. If the site is at 0% or muted, the extension does not bring the sound back.
- Off by default. Turn on **Use extension volume (experimental)** in the popup. While it is off, volume requests change nothing; speed controls always work.
- Turning it on connects nothing by itself, and a 100% request on untouched media succeeds without Web Audio. Any other value connects that media item to a Web Audio gain node (gain only, no compressor). Other tabs and new media are never adjusted automatically. Once connected, that media item uses the browser's audio processing until the page is reloaded.
- A request is refused, and the current level is kept, when the media comes from another site without CORS permission, when the page has not been interacted with yet, when the page or an earlier extension instance already uses Web Audio for it, or when audio processing cannot start. The popup reports how many items were adjusted.
- If an adjusted item later switches to a source from another site, its output may be limited (often silent). The popup shows this as an estimate; reload the page if you hear nothing. The extension never changes the source or starts playback to recover.
- Turning the option off returns every item to 100% (the site's own sound) and blocks further changes, including requests still in progress. Web Audio paths already created stay until reload; "no Web Audio" only holds before the first adjustment. If a page frame does not respond, the popup says the reset could not be confirmed there; it is retried when the page responds again, and reloading the page also removes it.
- After an extension update or reload, an older instance returns its items to 100% on a best-effort basis (a timer plus media events; timers can be delayed in hidden tabs).
- Levels above 100% can distort.

## Updating to 1.0.6

Replace files in the folder Chrome already loads, reload the extension at `chrome://extensions`, and confirm version **1.0.6**. Avoid installing a second copy. Existing page controllers and their history may be replaced during the update; play the intended media once after updating if needed.

Version 1.0.6 allows the most recently played media to resume after a site, mouse, keyboard or media-key pause. It uses confirmed playback history in the same live document and source. It never starts every paused element, guesses a replacement, or restarts ended media. When an extension pause batch remains valid, that batch takes priority. Unknown/tied playback history is not guessed. Pause history and message ordering metadata do not expire just because six hours pass; the bounded cache still removes records for confirmed navigation, source replacement and closed tabs.

Existing event-loss recovery, document reconnection, and control receipts remain in place. Diagnostics now distinguish keyboard and popup commands, record media counts, and explain resume selection. Diagnostics retain up to 100 command/error entries and 100 observation entries, with command IDs, input origin, start/completion, selection and invalidation reasons. Entries stay in session storage without titles or URLs and can be copied from the popup. The installed version is visible in the popup. No data is sent to a server. Resume waits up to six seconds and the worker waits up to eight seconds for its control response. Failed extension resume attempts preserve valid pause ownership for retry. The popup supports 17 locales; no permissions were added. Automatic loop restarts still count as new playback and may switch the target tab.

See the accompanying `MediaPauseHotkey-1.0.6-검증결과.md` report for measured results. Tests in isolated profiles do not establish OS global-key delivery or resolve every intermittent issue in a normal user profile.

## Remove

Remove **Media Shortcut** from `chrome://extensions`.
