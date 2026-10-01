// Hover preview of a site, kept in IndexedDB on this device. Opt-in in the settings.
// - "screenshot": background.js saves one when the user opens the site.
// - "share-image": until then, the site's own share image (og:image), fetched once
//   on hover from the site itself, without cookies.

const DB = "maple-previews";
const STORE = "previews";
const SHOW_DELAY_MS = 450;
const WIDTH = 480;
// A site without a share image is asked again after a day
const MISSING_RETRY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
// The share image is in <head>; never read more than this of a page
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// "www.example.com" and "example.com" are the same site (same rule as background.js)
export const previewHost = (hostname) => hostname.toLowerCase().replace(/^www\./, "");

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "host" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Deletes all saved previews
export function clearPreviews() {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

// How many sites have a preview, by kind
export async function countPreviews() {
  const all = await withStore("readonly", (store) => store.getAll()).catch(() => []);
  return {
    screenshots: all.filter((item) => item.source === "screenshot").length,
    shareImages: all.filter((item) => item.source === "share-image").length,
  };
}

async function shrink(blob) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: WIDTH, resizeQuality: "medium" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
}

async function readHead(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  reader.cancel().catch(() => {});
  return html;
}

// The site's share image, small, or null. The page is parsed with DOMParser,
// which runs no scripts and loads nothing.
async function fetchShareImage(pageUrl) {
  const options = { credentials: "omit", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  const page = await fetch(pageUrl, options);
  if (!page.ok || !(page.headers.get("content-type") || "").includes("text/html")) return null;
  const doc = new DOMParser().parseFromString(await readHead(page), "text/html");
  const meta = doc.querySelector(
    'meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[name="twitter:image:src"]'
  );
  const content = meta?.getAttribute("content");
  if (!content) return null;
  const imageUrl = new URL(content, page.url);
  if (imageUrl.protocol !== "https:" && imageUrl.protocol !== "http:") return null;
  const image = await fetch(imageUrl, options);
  if (!image.ok) return null;
  const blob = await image.blob();
  if (!blob.type.startsWith("image/") || blob.size > MAX_IMAGE_BYTES) return null;
  return shrink(blob);
}

export function createSitePreview() {
  const el = document.createElement("div");
  el.className = "site-preview";
  const img = document.createElement("img");
  img.alt = "";
  el.appendChild(img);
  document.body.appendChild(el);

  // host -> { url, capturedAt }: object URLs for this page's lifetime
  const urls = new Map();
  // Share image requests that are running, per host
  const loading = new Map();
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

  async function loadShareImage(host, pageUrl) {
    if (!loading.has(host)) {
      const task = fetchShareImage(pageUrl)
        .catch(() => null)
        .then(async (blob) => {
          const record = blob
            ? { host, blob, capturedAt: Date.now(), source: "share-image" }
            : { host, capturedAt: Date.now(), source: "none" };
          // A screenshot that background.js saved in the meantime wins
          const saved = await withStore("readwrite", (store) => {
            const request = store.get(host);
            request.onsuccess = () => {
              if (request.result?.source !== "screenshot") store.put(record);
            };
            return request;
          }).catch(() => null);
          return saved?.source === "screenshot" ? saved : record;
        })
        .finally(() => loading.delete(host));
      loading.set(host, task);
    }
    return loading.get(host);
  }

  async function urlFor(pageUrl) {
    let host;
    try {
      host = previewHost(new URL(pageUrl).hostname);
    } catch {
      return null;
    }
    if (!host || !/^https?:/i.test(pageUrl)) return null;
    // Read again each time: background.js can save a newer screenshot while this page is open
    let record = await withStore("readonly", (store) => store.get(host)).catch(() => null);
    const missingRecently = record?.source === "none" && Date.now() - record.capturedAt < MISSING_RETRY_MS;
    if (!record?.blob && !missingRecently) record = await loadShareImage(host, pageUrl);
    if (!record?.blob) return null;
    const cached = urls.get(host);
    if (cached?.capturedAt === record.capturedAt) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(record.blob);
    urls.set(host, { url, capturedAt: record.capturedAt });
    return url;
  }

  function hide() {
    clearTimeout(timer);
    current = null;
    el.classList.remove("show");
  }

  return {
    show(anchor, pageUrl) {
      clearTimeout(timer);
      current = anchor;
      timer = setTimeout(async () => {
        const url = await urlFor(pageUrl);
        if (!url || current !== anchor) return;
        img.src = url;
        await img.decode().catch(() => {});
        if (current !== anchor) return;
        position(anchor);
        el.classList.add("show");
      }, SHOW_DELAY_MS);
    },
    hide,
    // After the saved previews were deleted
    forget() {
      hide();
      for (const { url } of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
