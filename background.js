chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (!tabId) {
    sendResponse({ ok: false, error: "No tab ID found" });
    return;
  }

  if (message?.type === "FPQ_INSERT_TEXT") {
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");

        await chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
          text: message.text,
        });

        await chrome.debugger.detach({ tabId });

        sendResponse({ ok: true });
      } catch (err) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch (_) {}

        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_CLICK_AT") {
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");

        await chrome.debugger.sendCommand(
          { tabId },
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: message.x,
            y: message.y,
            button: "none",
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
          },
        );

        await chrome.debugger.detach({ tabId });

        sendResponse({ ok: true });
      } catch (err) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch (_) {}

        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_PRESS_ENTER") {
    (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");

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

        await chrome.debugger.detach({ tabId });

        sendResponse({ ok: true });
      } catch (err) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch (_) {}

        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  }
});
