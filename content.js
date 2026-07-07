// content.js
// Runs only on https://www.linkedin.com/my-items/saved-posts/*
//
// v1.1 reliability fixes:
// - MutationObserver no longer triggers a full page rescan on every DOM change
//   (LinkedIn mutates constantly in the background — reaction counts, ads, etc.).
//   It now only reacts when a mutation actually adds a qualifying link.
// - A hard cooldown (not just a debounce) caps how often a rescan can run at all.
// - Observer disconnects after a period of inactivity so an open tab left for
//   days doesn't keep doing background work; it reconnects on demand.
// - Storage reads/writes are wrapped in try/catch so a quota or serialization
//   error can't throw unhandled and take the content script down with it.
// - Stored items are capped, oldest-first, so storage can't grow unbounded.
// - Oversized "container" matches (a sign the DOM-walk grabbed way more than
//   one card) are skipped instead of being fully text-extracted.

const STORAGE_KEY = "linkedinSavedItems";
const MAX_STORED_ITEMS = 3000;
const MIN_RESCAN_INTERVAL_MS = 4000; // hard floor between any two scrapes
const IDLE_DISCONNECT_MS = 20000; // stop observing after this long with no activity
const MAX_CONTAINER_DESCENDANTS = 250; // guard against grabbing a huge wrapper

const linkPatternMatch = /\/(feed\/update|posts|pulse|jobs\/view|company|in)\//;

let lastScrapeAt = 0;
let scrapeInFlight = null;

function extractItemsFromDom(root = document) {
  const seenOnPage = new Set();
  const items = [];

  root.querySelectorAll("a[href]").forEach((a) => {
    let href;
    try {
      href = new URL(a.getAttribute("href"), location.href).toString();
    } catch {
      return;
    }
    if (!href.includes("linkedin.com")) return;
    if (!linkPatternMatch.test(href)) return;

    const container =
        a.closest("li") ||
        a.closest("article") ||
        a.closest("div[data-view-name]") ||
        a.parentElement;
    if (!container) return;

    // Skip anything that looks like it grabbed a huge wrapper instead of a
    // single card — extracting text from a giant subtree is the expensive
    // operation that was causing the crashes.
    if (container.querySelectorAll("*").length > MAX_CONTAINER_DESCENDANTS) return;

    const text = (container.innerText || "").trim().replace(/\s+/g, " ");
    if (text.length < 8) return;

    const key = href.split("?")[0];
    if (seenOnPage.has(key)) return;
    seenOnPage.add(key);

    const linkText = (a.innerText || "").trim().replace(/\s+/g, " ");
    items.push({
      href: key,
      title: (linkText || text).slice(0, 150),
      snippet: text.slice(0, 300),
      firstSeen: Date.now(),
    });
  });

  return items;
}

async function mergeAndSave(newItems) {
  if (newItems.length === 0) return null;

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const existing = stored[STORAGE_KEY] || {};
    let changed = false;

    for (const item of newItems) {
      if (!existing[item.href]) {
        existing[item.href] = item;
        changed = true;
      } else if (item.snippet.length > existing[item.href].snippet.length) {
        existing[item.href].snippet = item.snippet;
        existing[item.href].title = item.title;
        changed = true;
      }
    }

    if (!changed) return Object.keys(existing).length;

    // Cap total stored items — drop the oldest first-seen entries once over
    // the limit, so this can never grow without bound.
    let entries = Object.entries(existing);
    if (entries.length > MAX_STORED_ITEMS) {
      entries.sort((a, b) => (b[1].firstSeen || 0) - (a[1].firstSeen || 0));
      entries = entries.slice(0, MAX_STORED_ITEMS);
    }
    const trimmed = Object.fromEntries(entries);

    await chrome.storage.local.set({
      [STORAGE_KEY]: trimmed,
      linkedinSavedLastSync: Date.now(),
    });

    return entries.length;
  } catch (err) {
    console.warn("[Saved Index] storage write failed, skipping this scrape:", err);
    return null;
  }
}

async function scrapeOnce(root) {
  // Hard floor: never let two scrapes run closer together than this, no
  // matter how many mutation events fire in between.
  const now = Date.now();
  if (now - lastScrapeAt < MIN_RESCAN_INTERVAL_MS && !root) {
    return scrapeInFlight;
  }
  lastScrapeAt = now;

  try {
    const items = extractItemsFromDom(root);
    scrapeInFlight = await mergeAndSave(items);
    return scrapeInFlight;
  } catch (err) {
    console.warn("[Saved Index] scrape failed:", err);
    return null;
  }
}

// Scroll the saved-items page to force LinkedIn to lazy-load the full list,
// scraping as we go, then report back how many unique items were found.
async function autoScrollAndScrape(sendResponse) {
  let lastHeight = -1;
  let stableRounds = 0;
  const maxRounds = 60;

  try {
    for (let round = 0; round < maxRounds; round++) {
      await scrapeOnce(document); // force=true via explicit root, bypass cooldown
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 900));

      const height = document.body.scrollHeight;
      if (height === lastHeight) {
        stableRounds++;
        if (stableRounds >= 3) break;
      } else {
        stableRounds = 0;
      }
      lastHeight = height;
    }

    const total = await scrapeOnce(document);
    sendResponse({ ok: true, total });
  } catch (err) {
    console.warn("[Saved Index] sync failed:", err);
    sendResponse({ ok: false, error: String(err) });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SYNC_NOW") {
    ensureObserving();
    autoScrollAndScrape(sendResponse);
    return true;
  }
  if (msg?.type === "SCRAPE_VISIBLE") {
    scrapeOnce(document).then((total) => sendResponse({ ok: true, total }));
    return true;
  }
});

// --- Lightweight background watching, with a leash on it ---
// Only rescans when a mutation actually introduces a qualifying link, not on
// every incidental DOM change, and disconnects after a period of inactivity
// so a saved-posts tab left open for days doesn't keep doing work forever.

let debounceTimer = null;
let idleTimer = null;
let observer = null;

function looksRelevant(mutation) {
  for (const node of mutation.addedNodes) {
    if (node.nodeType !== 1) continue; // elements only
    if (node.matches?.(`a[href*="linkedin.com"]`) && linkPatternMatch.test(node.getAttribute?.("href") || "")) {
      return true;
    }
    if (node.querySelector?.("a[href]")) return true;
  }
  return false;
}

function scheduleIdleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    observer?.disconnect();
  }, IDLE_DISCONNECT_MS);
}

function ensureObserving() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    scheduleIdleDisconnect();
    if (!mutations.some(looksRelevant)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scrapeOnce(), 1000);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scheduleIdleDisconnect();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") ensureObserving();
});

ensureObserving();
setTimeout(() => scrapeOnce(document), 1200);
