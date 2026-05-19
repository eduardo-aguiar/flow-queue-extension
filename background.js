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
      const message = err?.message || String(err);

      /**
       * Sometimes the debugger is already attached from the previous action.
       * This should not immediately fail the flow.
       */
      if (!message.includes("Another debugger is already attached")) {
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
