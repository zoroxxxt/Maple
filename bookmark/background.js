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
