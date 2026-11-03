# Chrome Web Store submission details

The extension UI and listing assets are prepared for 17 Chrome locales. Add each locale in the Developer Dashboard and copy its name, short description, and full description from `listing/locales/<locale>.json`. The same JSON names the matching screenshot file. The default listing language is English.

- Store icon: `MediaPauseHotkey/listing/store-icon-128.png` (128×128; also used by the extension manifest)
- Localized screenshots: `MediaPauseHotkey/listing/media-shortcuts-<locale>-1280x800.png` (17 locales)
- Bundled artwork and listing data: `MediaPauseHotkey-Store-Assets.zip`
- Default listing language: English
- Category: Productivity
- Distribution: Public, all regions
- English full description: `MediaPauseHotkey/listing/description-en.txt`
- Korean full description: `MediaPauseHotkey/listing/description-ko.txt`

## Privacy and single-purpose declarations

- Single purpose: Pause or resume standard HTML audio/video in the most recently playing Chrome tab, and adjust its volume and speed, using user-assigned shortcuts.
- Data use: The extension processes page titles, standard audio/video source URLs and playback states, plus temporary tab/document/frame/media identifiers. This state is used only for media control and stored locally in `chrome.storage.session` for the current session; no extension data is sent to a server.
- Analytics or advertising: None.
- Permission justification: `MediaPauseHotkey/listing/single-purpose.txt`
- Privacy policy page: https://insipidpie1229.github.io/media-pause-hotkey/privacy.html

## Upload and review

Upload `MediaPauseHotkey-WebStore-1.0.6.zip` through the item's Package section. The ZIP has `manifest.json` at its root. In the Store listing section, add the locales you plan to publish and copy the corresponding listing data and screenshot. Review Package, Store listing, Privacy, and Distribution before submission. Public release remains subject to Google review.

Version 1.0.4 adds local, user-copyable diagnostics (last 200 records, no titles or URLs). Update the hosted privacy policy from `privacy.html` before submitting. The package is prepared; Web Store submission has not been performed for this release. Normal-profile installation/duplicate checks and OS global-key testing remain manual.

1.3.1 (local, not submitted) changes the suggested global pause/resume key to Ctrl+Shift+1 / Command+Shift+1.

1.3.0 (local, not submitted) replaces the boost with an opt-in extension volume (0–500% gain layer; the site's own volume is never changed). Same `storage.local` preference, no new permissions.

1.2.1 (local, not submitted) suggests Ctrl+Shift+9 / Command+Shift+9 as the global pause/resume shortcut; volume and speed commands stay unassigned.

1.2.0 (local, not submitted) adds an opt-in experimental volume boost up to 300% (Web Audio gain on the controlled media only, off by default), a redesigned popup with dark mode and speed presets, and one `storage.local` preference. No permissions were added. The same pre-release updates as 1.1.0 apply.

1.1.0 (local, not submitted) adds optional volume and speed shortcuts, popup controls and a one-second on-page indicator. No permissions were added. Before release: update the hosted privacy policy, the single-purpose text above, and the localized listing descriptions and screenshots (not yet updated for 1.1.0).

1.0.6 is prepared locally, not submitted. Resume may restore the most recently played media even if it was paused outside the extension. Extension-paused groups have priority. Diagnostics retain 100 command/error and 100 observation entries; update the hosted policy before release.
