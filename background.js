let nextDownloadFilename = null;

function sanitizeFilename(name) {
  return String(name || "flow-image")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  if (!nextDownloadFilename) {
    return;
  }

  const originalFilename = downloadItem.filename || "";
  const extensionMatch = originalFilename.match(/\.[a-zA-Z0-9]+$/);
  const extension = extensionMatch ? extensionMatch[0] : ".png";

  suggest({
    filename: `${nextDownloadFilename}${extension}`,
    conflictAction: "uniquify",
  });

  nextDownloadFilename = null;

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (!tabId) {
    sendResponse({ ok: false, error: "No tab ID found" });
    return;
  }

  async function attachDebugger() {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (err) {
      const errorMessage = err?.message || String(err);

      if (!errorMessage.includes("Another debugger is already attached")) {
        throw err;
      }
    }
  }

  async function detachDebugger() {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // Ignore detach errors.
    }
  }

  if (message?.type === "FPQ_SET_NEXT_DOWNLOAD_FILENAME") {
    nextDownloadFilename = sanitizeFilename(message.filename || "flow-image");

    sendResponse({
      ok: true,
      filename: nextDownloadFilename,
    });

    return true;
  }

  if (message?.type === "FPQ_INSERT_TEXT") {
    (async () => {
      try {
        await attachDebugger();

        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
          text: message.text,
        });

        await detachDebugger();

        sendResponse({ ok: true });
      } catch (err) {
        await detachDebugger();

        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_MOUSE_MOVE_TO") {
    (async () => {
      try {
        await attachDebugger();

        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: message.x,
            y: message.y,
            button: "none",
            pointerType: "mouse",
          },
        );

        await detachDebugger();

        sendResponse({ ok: true });
      } catch (err) {
        await detachDebugger();

        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_CLICK_AT") {
    (async () => {
      try {
        await attachDebugger();

        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: message.x,
            y: message.y,
            button: "none",
            pointerType: "mouse",
          },
        );

        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: message.x,
            y: message.y,
            button: "left",
            clickCount: 1,
            pointerType: "mouse",
          },
        );

        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: message.x,
            y: message.y,
            button: "left",
            clickCount: 1,
            pointerType: "mouse",
          },
        );

        await detachDebugger();

        sendResponse({ ok: true });
      } catch (err) {
        await detachDebugger();

        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_PRESS_ENTER") {
    (async () => {
      try {
        await attachDebugger();

        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });

        await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });

        await detachDebugger();

        sendResponse({ ok: true });
      } catch (err) {
        await detachDebugger();

        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  sendResponse({
    ok: false,
    error: `Unknown message type: ${message?.type}`,
  });
});
