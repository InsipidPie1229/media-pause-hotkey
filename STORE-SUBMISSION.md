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

- Single purpose: Pause or resume standard HTML audio/video in the most recently playing Chrome tab using a user-assigned shortcut.
- Data use: The extension processes page titles, standard audio/video source URLs and playback states, plus temporary tab/document/frame/media identifiers. This state is used only for media control and stored locally in `chrome.storage.session` for the current session; no extension data is sent to a server.
- Analytics or advertising: None.
- Permission justification: `MediaPauseHotkey/listing/single-purpose.txt`
- Privacy policy page: `privacy.html`; after GitHub Pages publishes the repository, enter its public HTTPS URL in the Developer Dashboard.

## Upload and review

Upload `MediaPauseHotkey-WebStore-1.0.0.zip` as a new item. The ZIP has `manifest.json` at its root. In the Store listing section, add the locales you plan to publish and copy the corresponding listing data and screenshot. Review Package, Store listing, Privacy, and Distribution before submission. Public release remains subject to Google review.
