let nextDownloadFilename = null;
let nextDownloadRequestId = 0;
const debuggerCommandChains = new Map();
const downloadWaiters = new Map();
let flowControllerTabId = null;
let metaWorkerTabId = null;
const metaJobQueue = [];
let activeMetaJob = null;
let activeMetaJobTimer = null;
let metaBootstrapPromise = null;
const FLOW_URL_PATTERNS = ["https://labs.google/fx/tools/flow*"];
const META_JOB_QUEUE_STORAGE_KEY = "maqMetaJobQueue";
let metaJobQueueLoaded = false;
let metaJobQueueLoadPromise = null;

function getMetaJobStorageArea() {
  return chrome.storage.session || chrome.storage.local;
}

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    area.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(items || {});
    });
  });
}

function storageSet(area, items) {
  return new Promise((resolve, reject) => {
    area.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve();
    });
  });
}

async function loadMetaJobQueue() {
  if (metaJobQueueLoaded) {
    return;
  }

  if (metaJobQueueLoadPromise) {
    await metaJobQueueLoadPromise;
    return;
  }

  metaJobQueueLoadPromise = (async () => {
    try {
      const items = await storageGet(getMetaJobStorageArea(), [
        META_JOB_QUEUE_STORAGE_KEY,
      ]);
      const storedQueue = items[META_JOB_QUEUE_STORAGE_KEY];

      metaJobQueue.splice(
        0,
        metaJobQueue.length,
        ...(Array.isArray(storedQueue) ? storedQueue : []),
      );
    } catch (err) {
      console.warn("[MAQ] Could not load persisted Meta queue", err?.message || err);
    } finally {
      metaJobQueueLoaded = true;
      metaJobQueueLoadPromise = null;
    }
  })();

  await metaJobQueueLoadPromise;
}

async function persistMetaJobQueue() {
  try {
    await storageSet(getMetaJobStorageArea(), {
      [META_JOB_QUEUE_STORAGE_KEY]: metaJobQueue,
    });
  } catch (err) {
    console.warn("[MAQ] Could not persist Meta queue", err?.message || err);
  }
}

function sanitizeFilename(name) {
  const cleaned = String(name || "flow-image")
    .replace(/\\+/g, "/")
    .split("/")
    .map((part) =>
      part
        .trim()
        .replace(/[<>:"|?*\x00-\x1F]/g, "")
        .replace(/^\.+$/g, "")
        .replace(/\s+/g, "-"),
    )
    .filter(Boolean)
    .join("/");

  return cleaned.slice(0, 180) || "flow-image";
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function ensureDownloadWaiter(requestId, filename) {
  const key = String(requestId);
  const existing = downloadWaiters.get(key);

  if (existing) {
    return existing;
  }

  const deferred = createDeferred();
  const waiter = {
    key,
    filename,
    deferred,
    downloadId: null,
    finalState: null,
    timer: setTimeout(() => {
      if (downloadWaiters.get(key) !== waiter) return;

      waiter.finalState = "timeout";
      waiter.deferred.resolve({
        ok: false,
        requestId: key,
        state: "timeout",
        filename: waiter.filename,
      });
      downloadWaiters.delete(key);
    }, 45000),
  };

  downloadWaiters.set(key, waiter);
  return waiter;
}

function settleDownloadWaiter(waiter, payload) {
  if (!waiter || waiter.finalState) {
    return;
  }

  waiter.finalState = payload.state;
  clearTimeout(waiter.timer);
  waiter.deferred.resolve(payload);
  downloadWaiters.delete(waiter.key);
}

function finishDownloadWaiterById(downloadId, state, extra = {}) {
  if (downloadId == null) return;

  for (const waiter of downloadWaiters.values()) {
    if (waiter.downloadId !== downloadId) continue;

    settleDownloadWaiter(waiter, {
      ok: state === "complete",
      requestId: waiter.key,
      state,
      filename: waiter.filename,
      downloadId,
      ...extra,
    });
  }
}

function queueDebuggerCommand(tabId, work) {
  const prior = debuggerCommandChains.get(tabId) || Promise.resolve();

  const next = prior
    .catch(() => {})
    .then(async () => {
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

      await attachDebugger();

      try {
        return await work();
      } finally {
        await detachDebugger();
      }
    });

  debuggerCommandChains.set(
    tabId,
    next.finally(() => {
      if (debuggerCommandChains.get(tabId) === next) {
        debuggerCommandChains.delete(tabId);
      }
    }),
  );

  return next;
}

function notifyFlowTab(payload) {
  if (!flowControllerTabId) return;

  chrome.tabs.sendMessage(flowControllerTabId, payload, () => {
    void chrome.runtime.lastError;
  });
}

async function activateTab(tabId) {
  if (!tabId) return false;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (err) {
    console.warn("[MAQ] Could not activate tab", tabId, err?.message || err);
    return false;
  }
}

async function findFlowControllerTabId() {
  const tabs = await chrome.tabs.query({ url: FLOW_URL_PATTERNS });
  const tab = tabs.find((candidate) => typeof candidate.id === "number");
  return tab?.id || null;
}

async function activateFlowControllerTab() {
  if (await activateTab(flowControllerTabId)) {
    return flowControllerTabId;
  }

  const fallbackTabId = await findFlowControllerTabId();
  if (!fallbackTabId) {
    return null;
  }

  flowControllerTabId = fallbackTabId;
  return (await activateTab(fallbackTabId)) ? fallbackTabId : null;
}

function clearActiveMetaJobTimer() {
  if (activeMetaJobTimer) {
    clearTimeout(activeMetaJobTimer);
    activeMetaJobTimer = null;
  }
}

function armActiveMetaJobTimer() {
  clearActiveMetaJobTimer();
  activeMetaJobTimer = setTimeout(() => {
    if (!activeMetaJob) return;

    const jobId = activeMetaJob.jobId;
    console.warn("[MAQ] Meta job watchdog fired", jobId);
    notifyFlowTab({
      type: "MAQ_META_JOB_STATUS",
      jobId,
      status: "failed",
      error: "Meta job timed out before completing",
    });
    activeMetaJob = null;
    void dispatchNextMetaJob();
  }, 360000);
}

async function dispatchNextMetaJob() {
  await loadMetaJobQueue();

  if (activeMetaJob || !metaJobQueue.length) {
    return;
  }

  if (!metaWorkerTabId) {
    metaWorkerTabId = await ensureMetaWorkerReady();
    if (!metaWorkerTabId) {
      return;
    }
  }

  const job = metaJobQueue.shift();
  await persistMetaJobQueue();
  activeMetaJob = job;
  armActiveMetaJobTimer();
  notifyFlowTab({
    type: "MAQ_META_JOB_STATUS",
    jobId: job.jobId,
    status: "running",
  });

  try {
    await activateTab(metaWorkerTabId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await chrome.tabs.sendMessage(metaWorkerTabId, {
      type: "MAQ_RUN_META_JOB",
      job,
    });
  } catch (err) {
    clearActiveMetaJobTimer();
    activeMetaJob = null;
    metaJobQueue.unshift(job);
    await persistMetaJobQueue();
    notifyFlowTab({
      type: "MAQ_META_JOB_STATUS",
      jobId: job.jobId,
      status: "queued",
      error: err?.message || String(err),
    });
    setTimeout(() => {
      void dispatchNextMetaJob();
    }, 1500);
  }
}

async function enqueueMetaJob(job) {
  await loadMetaJobQueue();
  metaJobQueue.push(job);
  await persistMetaJobQueue();
  notifyFlowTab({
    type: "MAQ_META_JOB_STATUS",
    jobId: job.jobId,
    status: "queued",
  });
  void ensureMetaWorkerReady();
  void dispatchNextMetaJob();
}

async function findMetaWorkerTabId() {
  const tabs = await chrome.tabs.query({
    url: ["https://www.meta.ai/*", "https://meta.ai/*"],
  });

  return tabs.find((tab) => typeof tab.id === "number")?.id || null;
}

async function ensureMetaWorkerReady() {
  if (metaWorkerTabId) {
    return metaWorkerTabId;
  }

  if (metaBootstrapPromise) {
    return metaBootstrapPromise;
  }

  metaBootstrapPromise = (async () => {
    const candidateTabId = await findMetaWorkerTabId();

    if (!candidateTabId) {
      return null;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: candidateTabId },
        files: ["meta-ai.js"],
      });
    } catch (err) {
      console.warn(
        "[MAQ] Could not inject Meta worker into existing tab:",
        err?.message || err,
      );
    }

    return candidateTabId;
  })().finally(() => {
    metaBootstrapPromise = null;
  });

  return metaBootstrapPromise;
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

chrome.downloads.onCreated.addListener((downloadItem) => {
  if (!nextDownloadFilename) {
    return;
  }

  for (const waiter of downloadWaiters.values()) {
    if (waiter.downloadId || waiter.finalState) continue;

    waiter.downloadId = downloadItem.id;
    break;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === "complete") {
    finishDownloadWaiterById(delta.id, "complete");
    return;
  }

  if (delta.error?.current) {
    finishDownloadWaiterById(delta.id, "interrupted", {
      error: delta.error.current,
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (!tabId) {
    sendResponse({ ok: false, error: "No tab ID found" });
    return;
  }

  if (message?.type === "MAQ_REGISTER_FLOW_CONTROLLER") {
    flowControllerTabId = tabId;
    sendResponse({ ok: true, role: "flow-controller" });
    return;
  }

  if (message?.type === "MAQ_REGISTER_META_WORKER") {
    metaWorkerTabId = tabId;
    sendResponse({ ok: true, role: "meta-worker" });
    void dispatchNextMetaJob();
    return;
  }

  if (message?.type === "FPQ_SET_NEXT_DOWNLOAD_FILENAME") {
    nextDownloadFilename = sanitizeFilename(message.filename || "flow-image");
    nextDownloadRequestId += 1;

    const waiter = ensureDownloadWaiter(nextDownloadRequestId, nextDownloadFilename);

    sendResponse({
      ok: true,
      filename: nextDownloadFilename,
      requestId: waiter.key,
    });

    return true;
  }

  if (message?.type === "FPQ_WAIT_FOR_DOWNLOAD") {
    const key = String(message.requestId || "");
    const waiter = downloadWaiters.get(key);

    if (!waiter) {
      sendResponse({
        ok: false,
        error: "Download request not found",
        requestId: key,
      });
      return true;
    }

    waiter.deferred.promise.then(sendResponse);
    return true;
  }

  if (message?.type === "FPQ_INSERT_TEXT") {
    (async () => {
      try {
        await queueDebuggerCommand(tabId, () =>
          chrome.debugger.sendCommand({ tabId }, "Input.insertText", {
            text: message.text,
          }),
        );

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_CLEAR_TEXT") {
    (async () => {
      try {
        await queueDebuggerCommand(tabId, async () => {
          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key: "a",
              code: "KeyA",
              windowsVirtualKeyCode: 65,
              nativeVirtualKeyCode: 65,
              modifiers: 2,
            },
          );

          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: "a",
              code: "KeyA",
              windowsVirtualKeyCode: 65,
              nativeVirtualKeyCode: 65,
              modifiers: 2,
            },
          );

          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
              nativeVirtualKeyCode: 8,
            },
          );

          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
              nativeVirtualKeyCode: 8,
            },
          );
        });

        sendResponse({ ok: true });
      } catch (err) {
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
        await queueDebuggerCommand(tabId, () =>
          chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: message.x,
            y: message.y,
            button: "none",
            pointerType: "mouse",
          }),
        );

        sendResponse({ ok: true });
      } catch (err) {
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
        await queueDebuggerCommand(tabId, async () => {
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
        });

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_RIGHTCLICK_AT") {
    (async () => {
      try {
        await queueDebuggerCommand(tabId, async () => {
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
              button: "right",
              buttons: 2,
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
              button: "right",
              buttons: 2,
              clickCount: 1,
              pointerType: "mouse",
            },
          );
        });

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "FPQ_SET_FILE_INPUT") {
    (async () => {
      try {
        await queueDebuggerCommand(tabId, async () => {
          const { root } = await chrome.debugger.sendCommand(
            { tabId },
            "DOM.getDocument",
            { depth: 0 },
          );

          const { nodeId } = await chrome.debugger.sendCommand(
            { tabId },
            "DOM.querySelector",
            {
              nodeId: root.nodeId,
              selector: message.selector || 'input[type="file"]',
            },
          );

          if (!nodeId) {
            throw new Error("File input not found");
          }

          await chrome.debugger.sendCommand(
            { tabId },
            "DOM.setFileInputFiles",
            {
              files: message.files,
              nodeId,
            },
          );
        });

        sendResponse({ ok: true });
      } catch (err) {
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
        await queueDebuggerCommand(tabId, async () => {
          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyDown",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            },
          );

          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            },
          );
        });

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();

    return true;
  }

  if (message?.type === "MAQ_READ_FILE") {
    (async () => {
      try {
        const fileUrl = "file:///" + message.path.replace(/\\/g, "/").replace(/^\//, "");
        const resp = await fetch(fileUrl);
        if (!resp.ok) { sendResponse({ ok: false, error: `HTTP ${resp.status}` }); return; }
        const blob = await resp.blob();
        const reader = new FileReaderSync ? new FileReaderSync() : null;
        // Use arrayBuffer → base64
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        sendResponse({ ok: true, base64, type: blob.type });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message?.type === "MAQ_EVAL") {
    (async () => {
      try {
        const result = await queueDebuggerCommand(tabId, () =>
          chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
            expression: message.expression,
            returnByValue: true,
          }),
        );

        sendResponse({ ok: true, result: result?.result?.value });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message?.type === "MAQ_DOWNLOAD_VIDEO") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: sanitizeFilename(message.filename || "agua-viva/video.mp4"),
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      },
    );
    return true;
  }

  if (message?.type === "MAQ_ENQUEUE_META_JOB") {
    (async () => {
      try {
        await enqueueMetaJob({
          ...message.job,
          sourceTabId: tabId,
        });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  if (message?.type === "MAQ_META_JOB_DONE") {
    if (!activeMetaJob || activeMetaJob.jobId === message.jobId) {
      clearActiveMetaJobTimer();
      notifyFlowTab({
        type: "MAQ_META_JOB_STATUS",
        jobId: message.jobId,
        status: "done",
      });
      activeMetaJob = null;
      void dispatchNextMetaJob();
    }

    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "MAQ_META_JOB_STARTED") {
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "MAQ_ACTIVATE_FLOW_TAB") {
    (async () => {
      try {
        const activatedTabId = await activateFlowControllerTab();
        sendResponse({
          ok: Boolean(activatedTabId),
          tabId: activatedTabId,
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err),
        });
      }
    })();
    return true;
  }

  if (message?.type === "MAQ_META_JOB_VIDEO_STARTED") {
    void activateFlowControllerTab();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "MAQ_META_JOB_FAILED") {
    if (!activeMetaJob || activeMetaJob.jobId === message.jobId) {
      clearActiveMetaJobTimer();
      notifyFlowTab({
        type: "MAQ_META_JOB_STATUS",
        jobId: message.jobId,
        status: "failed",
        error: message.error || "Meta job failed",
      });
      activeMetaJob = null;
      void dispatchNextMetaJob();
    }

    sendResponse({ ok: true });
    return;
  }

  sendResponse({
    ok: false,
    error: `Unknown message type: ${message?.type}`,
  });
});
