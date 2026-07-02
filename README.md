# LinkedIn Saved Item Search

A small Chrome extension that lets you search across everything you've saved on LinkedIn — something LinkedIn's own "My Items" page doesn't support.

## How it works
- When you visit `https://www.linkedin.com/my-items/saved-posts/`, a content script reads the saved items on the page and stores their title, link, and a text snippet locally in your browser (`chrome.storage.local` — nothing leaves your machine).
- The popup gives you an instant search box over everything indexed so far.
- Hitting **Sync from LinkedIn** auto-scrolls that page to load your full saved list (LinkedIn loads it a page at a time) and indexes everything it finds.

## Install (Chrome / Edge / Brave)
1. Unzip this folder somewhere permanent (don't delete it after installing — Chrome loads the extension from these files).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Pin the extension (puzzle-piece icon → pin) for easy access.

## First use
1. Click the extension icon, then click the "LinkedIn saved items" link in the empty state (or go to `linkedin.com/my-items/saved-posts/` yourself).
2. Once that page has loaded, click the extension icon again and hit **Sync from LinkedIn**.
3. Wait for it to finish scrolling (it stops automatically once no new items load) — with 100 items this normally takes under a minute.
4. Search away. Click any result to open it in a new tab.

You can re-run Sync any time you save new items — it merges into what's already indexed rather than starting over.

## A note on reliability
LinkedIn doesn't publish an API for saved items, and its page markup (CSS class names) changes periodically and isn't stable across accounts or over time. This extension deliberately avoids relying on those brittle class names — instead it looks for links matching LinkedIn's own URL patterns (`/posts/`, `/feed/update/`, `/pulse/`, `/jobs/view/`, etc.) and pulls the surrounding text as the title/snippet. If LinkedIn changes its page structure enough that scraping stops working, open `content.js`, use your browser's "Inspect Element" on a saved item to see the current markup, and adjust the `linkPatternMatch` regex or the container-detection logic (`a.closest(...)`) accordingly.

## Permissions
- `storage` — to save the indexed items locally.
- `activeTab` / `scripting` — to run the sync scroll-and-scrape when you click the button.
- Host access limited to `linkedin.com` only.

No data is sent anywhere; everything stays in your browser's local storage.
