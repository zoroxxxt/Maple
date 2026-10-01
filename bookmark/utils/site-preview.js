// Hover preview of a site: the small screenshot that background.js saved when the
// user last opened the site (IndexedDB, this device only). Opt-in in the settings.

const DB = "maple-previews";
const STORE = "previews";
const SHOW_DELAY_MS = 450;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "host" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getPreview(host) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(host);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

// Deletes all saved screenshots
export function clearPreviews() {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

export function createSitePreview() {
  const el = document.createElement("div");
  el.className = "site-preview";
  const img = document.createElement("img");
  img.alt = "";
  el.appendChild(img);
  document.body.appendChild(el);

  // host -> object URL, for this page's lifetime
  const urls = new Map();
  let timer = 0;
  let current = null;

  // Below the card, or above it when there is no room, and inside the window
  function position(anchor) {
    const margin = 8;
    const rect = anchor.getBoundingClientRect();
    el.style.left = "0px";
    el.style.top = "0px";
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - margin);
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - margin) top = rect.top - height - 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(Math.max(margin, top))}px`;
  }

  async function urlFor(host) {
    if (urls.has(host)) return urls.get(host);
    const record = await getPreview(host).catch(() => null);
    if (!record?.blob) return null;
    const url = URL.createObjectURL(record.blob);
    urls.set(host, url);
    return url;
  }

  function hide() {
    clearTimeout(timer);
    current = null;
    el.classList.remove("show");
  }

  return {
    show(anchor, host) {
      clearTimeout(timer);
      current = anchor;
      timer = setTimeout(async () => {
        const url = await urlFor(host);
        if (!url || current !== anchor) return;
        img.src = url;
        await img.decode().catch(() => {});
        if (current !== anchor) return;
        position(anchor);
        el.classList.add("show");
      }, SHOW_DELAY_MS);
    },
    hide,
    // After the saved screenshots were deleted
    forget() {
      hide();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
