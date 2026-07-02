const STORAGE_KEY = "linkedinSavedItems";
const SAVED_ITEMS_URL = "https://www.linkedin.com/my-items/saved-posts/";

const searchInput = document.getElementById("search");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const emptyEl = document.getElementById("empty");
const syncBtn = document.getElementById("syncBtn");
const lastSyncEl = document.getElementById("lastSync");
const openSavedLink = document.getElementById("openSaved");

let allItems = [];

openSavedLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: SAVED_ITEMS_URL });
});

function timeAgo(ts) {
  if (!ts) return "never synced";
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if (diffMin < 1) return "synced just now";
  if (diffMin < 60) return `synced ${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `synced ${diffHr}h ago`;
  return `synced ${Math.round(diffHr / 24)}d ago`;
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const q = escapeRegex(escapeHtml(query));
  return escaped.replace(new RegExp(`(${q})`, "ig"), "<mark>$1</mark>");
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function render(query) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? allItems.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.snippet.toLowerCase().includes(q)
      )
    : allItems;

  resultsEl.innerHTML = "";

  if (allItems.length === 0) {
    emptyEl.hidden = false;
    resultsEl.hidden = true;
    statusEl.textContent = "";
    return;
  }

  emptyEl.hidden = true;
  resultsEl.hidden = false;
  statusEl.textContent = q
    ? `${filtered.length} of ${allItems.length} saved items match`
    : `${allItems.length} saved items indexed`;

  filtered.slice(0, 200).forEach((item, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <a class="result" href="${item.href}" target="_blank" rel="noopener">
        <span class="result-title"><span class="result-index">${String(idx + 1).padStart(3, "0")}</span>${highlight(item.title, q)}</span>
        <span class="result-snippet">${highlight(item.snippet, q)}</span>
      </a>
    `;
    resultsEl.appendChild(li);
  });
}

async function loadItems() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, "linkedinSavedLastSync"]);
  const map = stored[STORAGE_KEY] || {};
  allItems = Object.values(map).sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
  lastSyncEl.textContent = timeAgo(stored.linkedinSavedLastSync);
  render(searchInput.value);
}

searchInput.addEventListener("input", () => render(searchInput.value));

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  const originalLabel = syncBtn.textContent;
  syncBtn.textContent = "Syncing…";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.startsWith(SAVED_ITEMS_URL)) {
    await chrome.tabs.create({ url: SAVED_ITEMS_URL });
    syncBtn.textContent = originalLabel;
    syncBtn.disabled = false;
    statusEl.textContent = "Opened your saved items — click Sync again once the page loads.";
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "SYNC_NOW" }, async (resp) => {
    syncBtn.disabled = false;
    syncBtn.textContent = originalLabel;
    if (chrome.runtime.lastError || !resp) {
      statusEl.textContent = "Couldn't reach the page — refresh it and try again.";
      return;
    }
    await loadItems();
  });
});

loadItems();
