// Service worker that keeps popup and sidebar modes mutually exclusive.
// Mode is persisted in chrome.storage.local so it survives browser restarts.

const MODE_KEY = "MAPLE_DISPLAY_MODE";
const MODE_POPUP = "popup";
const MODE_SIDEBAR = "sidebar";
const POPUP_PATH = "popup.html";

async function getStoredMode() {
  try {
    const result = await chrome.storage.local.get(MODE_KEY);
    return result[MODE_KEY] === MODE_SIDEBAR ? MODE_SIDEBAR : MODE_POPUP;
  } catch {
    return MODE_POPUP;
  }
}

async function applyMode(mode) {
  const isSidebar = mode === MODE_SIDEBAR;

  try {
    await chrome.action.setPopup({ popup: isSidebar ? "" : POPUP_PATH });
  } catch (e) {
    console.warn("Failed to set popup:", e);
  }

  if (chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: isSidebar });
    } catch (e) {
      console.warn("Failed to set side panel behavior:", e);
    }
  }
}

// Firefox 不支持 chrome.sidePanel，使用 sidebarAction 兜底：popup 关闭时点击 action 打开侧边栏。
chrome.action.onClicked.addListener(async () => {
  if (chrome.sidePanel) return; // Chromium 已通过 setPanelBehavior 处理
  const sidebarApi = globalThis.browser?.sidebarAction;
  if (sidebarApi?.open) {
    try {
      await sidebarApi.open();
    } catch (e) {
      console.warn("Failed to open Firefox sidebar:", e);
    }
  }
});

// Cmd/Ctrl+B toggles the sidebar in the window of the shortcut.
// There is no API to ask whether the panel is open, so open() always runs
// (no change when it is open already), and a sidebar that was open before
// closes itself on the message below. A sidebar that open() just started is
// still loading, so it does not get the message and stays open.
function toggleSidebar(tab) {
  const windowId = tab?.windowId;
  if (!chrome.sidePanel?.open || windowId === undefined) {
    globalThis.browser?.sidebarAction?.toggle?.();
    return;
  }
  // open() needs the shortcut's user gesture, so it must run inside this listener
  chrome.sidePanel.open({ windowId }).catch((e) => console.warn("Failed to open side panel:", e));
  chrome.runtime.sendMessage({ type: "MAPLE_TOGGLE_SIDEBAR", windowId }).catch(() => {
    // No sidebar was open to receive it
  });
}

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === "toggle-sidebar") toggleSidebar(tab);
});

async function init() {
  const mode = await getStoredMode();
  await applyMode(mode);
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// Opens the action popup. Chrome 127+ needs no user gesture for this, but the
// window must be active and applyMode() must have set the popup first.
async function openActionPopup(windowId) {
  if (!chrome.action?.openPopup) return false;
  try {
    if (Number.isInteger(windowId)) {
      await chrome.action.openPopup({ windowId });
    } else {
      await chrome.action.openPopup();
    }
    return true;
  } catch (e) {
    console.warn("Failed to open popup:", e);
    return false;
  }
}

// The side panel is not opened here: sidePanel.open() needs the click's user
// gesture, and the gesture does not survive the message to this worker.
// The popup page opens it itself (see switchToSidebar in popup.js).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "MAPLE_SET_MODE") {
    return false;
  }

  const nextMode = message.mode === MODE_SIDEBAR ? MODE_SIDEBAR : MODE_POPUP;

  (async () => {
    let opened = false;
    try {
      // Apply first, so the icon already opens the new mode when other open
      // panels see the storage change and close.
      await applyMode(nextMode);
      await chrome.storage.local.set({ [MODE_KEY]: nextMode });

      if (nextMode === MODE_POPUP && message.openPopup) {
        opened = await openActionPopup(message.windowId);
      }
    } catch (e) {
      console.warn("Failed to switch display mode:", e);
    }
    sendResponse({ ok: true, mode: nextMode, opened });
  })();

  return true;
});

// ---- Page previews ----
// Opt-in (setting + the optional "<all_urls>" permission). When the user opens or
// switches to a bookmarked site, take one small screenshot of the visible tab and
// keep it in IndexedDB on this device. Cards show it on hover (utils/site-preview.js).
// No network requests here; at most one screenshot per site every few days.
const PREVIEWS_KEY = "MAPLE_PREVIEWS";
// The last screenshot error, shown in the settings ("" after a success)
const PREVIEW_ERROR_KEY = "MAPLE_PREVIEW_ERROR";
const PREVIEW_DB = "maple-previews";
const PREVIEW_STORE = "previews";
const PREVIEW_WIDTH = 480;
const PREVIEW_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Wait for the page to finish drawing after "complete" or a tab switch
const PREVIEW_DELAY_MS = 1500;
const CAPTURE_GAP_MS = 600;
const ALL_URLS = { origins: ["<all_urls>"] };

let previewsOn = null;
let bookmarkedHosts = null;
const captureTimers = new Map();

// "www.example.com" and "example.com" are the same site for previews
const previewHost = (hostname) => hostname.toLowerCase().replace(/^www\./, "");

async function arePreviewsOn() {
  if (previewsOn === null) {
    try {
      const stored = (await chrome.storage.local.get(PREVIEWS_KEY))[PREVIEWS_KEY] === true;
      previewsOn = stored && (await chrome.permissions.contains(ALL_URLS));
    } catch {
      previewsOn = false;
    }
  }
  return previewsOn;
}

function openPreviewDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PREVIEW_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PREVIEW_STORE, { keyPath: "host" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function previewDb(mode, run) {
  const db = await openPreviewDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PREVIEW_STORE, mode);
      const request = run(tx.objectStore(PREVIEW_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getBookmarkedHosts() {
  if (!bookmarkedHosts) {
    const hosts = new Set();
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.url) {
          try {
            hosts.add(previewHost(new URL(node.url).hostname));
          } catch {
            // not a web address
          }
        }
        if (node.children) walk(node.children);
      }
    };
    walk(await chrome.bookmarks.getTree());
    bookmarkedHosts = hosts;
  }
  return bookmarkedHosts;
}

for (const eventName of ["onCreated", "onRemoved", "onChanged", "onImportEnded"]) {
  chrome.bookmarks?.[eventName]?.addListener(() => {
    bookmarkedHosts = null;
  });
}

// The full screenshot is the size of the window (often 2x); keep a small JPEG
async function shrinkScreenshot(dataUrl) {
  const source = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(source, { resizeWidth: PREVIEW_WIDTH, resizeQuality: "medium" });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
}

// The preview host of a tab that shows a web page, or ""
function tabHost(tab) {
  if (!tab || !/^https?:/i.test(tab.url || "")) return "";
  try {
    return previewHost(new URL(tab.url).hostname);
  } catch {
    return "";
  }
}

async function capturePreview(tabId, force = false) {
  let host;
  let windowId;
  try {
    if (!(await arePreviewsOn())) return false;
    const tab = await chrome.tabs.get(tabId);
    windowId = tab.windowId;
    host = tabHost(tab);
    if (!tab.active || tab.incognito || !host) return false;
    if (!(await getBookmarkedHosts()).has(host)) return false;
    if (!force) {
      // A share image (fetched on hover) is replaced by a real screenshot at once
      const saved = await previewDb("readonly", (store) => store.get(host));
      if (saved?.source === "screenshot" && Date.now() - saved.capturedAt < PREVIEW_MAX_AGE_MS) return false;
    }
  } catch {
    return false;
  }
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
    // The user can switch tabs during the capture: keep only a picture of this site
    const after = await chrome.tabs.get(tabId).catch(() => null);
    if (!after?.active || tabHost(after) !== host) return false;
    const blob = await shrinkScreenshot(dataUrl);
    await previewDb("readwrite", (store) => store.put({ host, blob, capturedAt: Date.now(), source: "screenshot" }));
    chrome.storage.local.set({ [PREVIEW_ERROR_KEY]: "" }).catch(() => {});
    return true;
  } catch (error) {
    // For example a minimized window, a page the browser protects, or a browser
    // without screenshot support. The settings show the last error.
    const message = String(error?.message || error);
    console.warn("Maple: no screenshot for", host, message);
    chrome.storage.local.set({ [PREVIEW_ERROR_KEY]: message }).catch(() => {});
    return false;
  }
}

// One capture at a time, with a pause between them: the browser allows only two
// screenshots per second
let captureQueue = Promise.resolve();
function queueCapture(tabId, force = false) {
  const run = captureQueue.then(() => capturePreview(tabId, force));
  captureQueue = run.then(() => new Promise((resolve) => setTimeout(resolve, CAPTURE_GAP_MS)));
  return run;
}

function scheduleCapture(tabId) {
  clearTimeout(captureTimers.get(tabId));
  captureTimers.set(
    tabId,
    setTimeout(() => {
      captureTimers.delete(tabId);
      queueCapture(tabId);
    }, PREVIEW_DELAY_MS)
  );
}

function onTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === "complete" && tab.active) scheduleCapture(tabId);
}

// Tabs that were open before (or loaded in the background) get a screenshot when shown
function onTabActivated({ tabId }) {
  scheduleCapture(tabId);
}

// Registered at the top level, so a page load or tab switch can wake this worker.
// With previews off, the listeners are removed again, so those events do not wake
// it for nothing.
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onActivated.addListener(onTabActivated);

async function syncPreviewListener() {
  previewsOn = null;
  const on = await arePreviewsOn();
  for (const [event, listener] of [
    [chrome.tabs.onUpdated, onTabUpdated],
    [chrome.tabs.onActivated, onTabActivated],
  ]) {
    const listening = event.hasListener(listener);
    if (on && !listening) event.addListener(listener);
    if (!on && listening) event.removeListener(listener);
  }
  // The tabs on screen now: a preview right away when they show a bookmarked site
  if (on) {
    const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
    for (const tab of tabs) scheduleCapture(tab.id);
  }
}
syncPreviewListener();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PREVIEWS_KEY]) syncPreviewListener();
});
chrome.permissions?.onAdded?.addListener(syncPreviewListener);
chrome.permissions?.onRemoved?.addListener(syncPreviewListener);

// "+" (add current page) asks for a preview of that tab right away
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "MAPLE_CAPTURE_PREVIEW" || !Number.isInteger(message.tabId)) return false;
  bookmarkedHosts = null;
  queueCapture(message.tabId, true).then((captured) => sendResponse({ captured }));
  return true;
});
