// content.js
// Runs only on https://www.linkedin.com/my-items/saved-posts/*
// LinkedIn's own class names are auto-generated and change often, so instead of
// relying on specific CSS classes, this looks for links that match known
// LinkedIn permalink patterns (posts, articles, jobs, profiles, companies) and
// pulls the readable text out of the card that link sits inside.

const STORAGE_KEY = "linkedinSavedItems";

function extractItemsFromDom() {
  const linkPatternMatch = /\/(feed\/update|posts|pulse|jobs\/view|company|in)\//;
  const seenOnPage = new Set();
  const items = [];

  document.querySelectorAll("a[href]").forEach((a) => {
    let href;
    try {
      href = new URL(a.getAttribute("href"), location.href).toString();
    } catch {
      return;
    }
    if (!href.includes("linkedin.com")) return;
    if (!linkPatternMatch.test(href)) return;

    // Walk up to find a reasonably sized "card" container for this link.
    let container =
      a.closest("li") ||
      a.closest("article") ||
      a.closest("div[data-view-name]") ||
      a.parentElement;
    if (!container) return;

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
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const existing = stored[STORAGE_KEY] || {};

  for (const item of newItems) {
    if (!existing[item.href]) {
      existing[item.href] = item;
    } else {
      // Keep the longer/more complete snippet if we've seen this item before.
      if (item.snippet.length > existing[item.href].snippet.length) {
        existing[item.href].snippet = item.snippet;
        existing[item.href].title = item.title;
      }
    }
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: existing,
    linkedinSavedLastSync: Date.now(),
  });

  return Object.keys(existing).length;
}

function scrapeOnce() {
  const items = extractItemsFromDom();
  return mergeAndSave(items);
}

// Scroll the saved-items page to force LinkedIn to lazy-load the full list,
// scraping as we go, then report back how many unique items were found.
async function autoScrollAndScrape(sendResponse) {
  let lastHeight = -1;
  let stableRounds = 0;
  const maxRounds = 60; // safety cap so this can't run forever

  for (let round = 0; round < maxRounds; round++) {
    await scrapeOnce();
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 900));

    const height = document.body.scrollHeight;
    if (height === lastHeight) {
      stableRounds++;
      if (stableRounds >= 3) break; // no new content after 3 tries in a row
    } else {
      stableRounds = 0;
    }
    lastHeight = height;
  }

  const total = await scrapeOnce();
  sendResponse({ ok: true, total });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "SYNC_NOW") {
    autoScrollAndScrape(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === "SCRAPE_VISIBLE") {
    scrapeOnce().then((total) => sendResponse({ ok: true, total }));
    return true;
  }
});

// Do a lightweight scrape as soon as the page settles, and again whenever
// new content is added (e.g. the user manually scrolls).
let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scrapeOnce, 800);
});
observer.observe(document.body, { childList: true, subtree: true });

setTimeout(scrapeOnce, 1200);
