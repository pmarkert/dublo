# Dublo Observation Chrome Extension

This locally loadable Chrome extension captures a Dublo-style observation of the active HTTP(S) page and opens it in the same static HTML report style used by Dublo's generated reports. It does not send page content anywhere; the capture is kept in Chrome's extension session storage until the browser session ends.

## Install for local or trusted use

1. Clone or copy this repository to a trusted local directory.
2. From the repository root, run `npm install` and `npm run build`. This bundles the shared Dublo observation collector for Chrome.
3. In Chrome, open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Select **Load unpacked**.
6. Choose this `browser-extension` directory.
7. Pin **Dublo Observation** from Chrome's Extensions menu to make its toolbar button visible.

To update a locally installed copy after pulling changes, rerun `npm run build`, then return to `chrome://extensions` and select the extension's reload button.

## Use

Open a normal HTTP(S) page, then select the Dublo Observation toolbar button. A new tab opens with the captured observation and offers the same **UI** and **Raw** views as a Dublo HTML report. The extension keeps watching that page while it remains loaded and refreshes the viewer after page content or accessibility state changes.

Chrome does not allow extensions to inspect restricted pages such as `chrome://` URLs, the Chrome Web Store, or some browser-managed documents. The viewer reports that capture error when it occurs.

## Permissions

- `activeTab`: grants temporary access only to the tab whose toolbar button the user selects.
- `scripting`: runs the page-local observation collector after that explicit action.
- `storage`: transfers the in-memory snapshot to the extension viewer tab.