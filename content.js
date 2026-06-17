// Flow Prompt Queue — content script
// Injected into https://labs.google/fx/tools/flow*

(function () {
  "use strict";

  // ─── CONFIG ───────────────────────────────────────────────────
  const SELECTORS = {
    promptInput: [
      'div[data-slate-editor="true"][contenteditable="true"]',
      'div[contenteditable="true"][data-slate-node="value"]',
      'div[role="textbox"][contenteditable="true"]',
    ],

    loadingIndicator: [
      '[aria-label*="loading" i]',
      '[aria-busy="true"]',
      '[role="progressbar"]',
      ".loading",
      "mat-progress-bar",
    ],
  };

  const POLL_INTERVAL = 1500;
  const MAX_WAIT_MS = 180000; // 3 min max per prompt
  const DOCK_WIDTH_PX = 360;

  // ─── STATE ────────────────────────────────────────────────────
  let queue = [];
  let running = false;
  let stopFlag = false;
  let delayBetween = 25;
  let downloadFolder = "flow-images";
  let referenceImage = null;
  let referenceAssetSearchText = "";
  let idCounter = 0;

  // ─── PANEL BUILD ──────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "fpq-root";
  root.innerHTML = `
    <div id="fpq-header">
      <div id="fpq-title">
        <div id="fpq-title-dot"></div>
        Flow Queue
      </div>
      <div id="fpq-header-btns">
        <button class="fpq-icon-btn" id="fpq-collapse-btn" title="Collapse">▲</button>
        <button class="fpq-icon-btn" id="fpq-close-btn" title="Close">✕</button>
      </div>
    </div>

    <div id="fpq-body">
      <div id="fpq-input-area">
        <div class="fpq-prompt-label">Flow prompts</div>
        <textarea id="fpq-textarea" placeholder="Paste prompt blocks separated by blank lines" rows="3"></textarea>
        <div class="fpq-prompt-label">Meta prompts</div>
        <textarea id="fpq-meta-textarea" placeholder="Paste matching prompt blocks separated by blank lines" rows="3"></textarea>
        <div id="fpq-reference-drop" tabindex="0" role="button">
          <span id="fpq-reference-text">choose reference image</span>
          <span id="fpq-reference-name">none</span>
          <button id="fpq-reference-clear" type="button" title="Remove reference image">×</button>
          <input id="fpq-reference-input" type="file" accept="image/*" />
        </div>
        <div id="fpq-folder-row">
          <span id="fpq-folder-label">download folder</span>
          <input id="fpq-folder-input" type="text" value="flow-images" placeholder="flow-images" />
        </div>
        <div id="fpq-add-row">
          <span id="fpq-delay-label">delay after completion (s)</span>
          <input id="fpq-delay-input" type="number" min="1" max="300" value="25" />
          <button id="fpq-add-btn">+ Add to Queue</button>
        </div>
      </div>

      <div id="fpq-progress-bar-wrap"><div id="fpq-progress-bar"></div></div>

      <div id="fpq-queue-area">
        <div id="fpq-queue-empty">Queue is empty — add prompt blocks above</div>
      </div>

      <div id="fpq-controls">
        <button class="fpq-ctrl-btn" id="fpq-run-btn">▶ Run All</button>
        <button class="fpq-ctrl-btn" id="fpq-stop-btn">■ Stop</button>
        <button class="fpq-ctrl-btn" id="fpq-clear-btn">Clear</button>
      </div>

      <div id="fpq-status-bar">Ready</div>
    </div>
  `;
  document.documentElement.style.setProperty(
    "--fpq-dock-width",
    `${DOCK_WIDTH_PX}px`,
  );
  document.documentElement.classList.add("fpq-docked");
  document.body.appendChild(root);

  // ─── ELEMENT REFS ─────────────────────────────────────────────
  const $ = (id) => root.querySelector("#" + id);

  const textarea = $("fpq-textarea");
  const metaTextarea = $("fpq-meta-textarea");
  const referenceDrop = $("fpq-reference-drop");
  const referenceText = $("fpq-reference-text");
  const referenceName = $("fpq-reference-name");
  const referenceClear = $("fpq-reference-clear");
  const referenceInput = $("fpq-reference-input");
  const delayInput = $("fpq-delay-input");
  const folderInput = $("fpq-folder-input");
  const addBtn = $("fpq-add-btn");
  const runBtn = $("fpq-run-btn");
  const stopBtn = $("fpq-stop-btn");
  const clearBtn = $("fpq-clear-btn");
  const queueArea = $("fpq-queue-area");
  const statusBar = $("fpq-status-bar");
  const titleDot = $("fpq-title-dot");
  const collapseBtn = $("fpq-collapse-btn");
  const closeBtn = $("fpq-close-btn");
  const progressBar = $("fpq-progress-bar");

  // ─── HELPERS ──────────────────────────────────────────────────
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function sanitizeDownloadFolder(value) {
    const cleaned = String(value || "")
      .trim()
      .replace(/\\+/g, "/")
      .replace(/\/+$/g, "")
      .replace(/^\/+/, "")
      .split("/")
      .map((part) =>
        part
          .trim()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[<>:"|?*\x00-\x1F]/g, "")
          .replace(/^\.+$/g, "")
          .replace(/\s+/g, "-"),
      )
      .filter(Boolean)
      .join("/");

    return cleaned || "flow-images";
  }

  function getDownloadFolder() {
    return sanitizeDownloadFolder(folderInput?.value || downloadFolder);
  }

  function buildDownloadFilename(folder, filename) {
    const safeFolder = sanitizeDownloadFolder(folder);
    const safeFilename =
      String(filename || "flow-image")
        .trim()
        .replace(/\\+/g, "-")
        .replace(/\/+/g, "-")
        .replace(/[<>:"|?*\x00-\x1F]/g, "-")
        .replace(/^-+|-+$/g, "") || "flow-image";

    return `${safeFolder}/${safeFilename}`;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToFile(dataUrl, name, type) {
    const [header, base64] = String(dataUrl || "").split(",");
    const mime = type || header.match(/data:([^;]+)/)?.[1] || "image/png";
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new File([bytes], name || "reference-image.png", { type: mime });
  }

  function updateReferenceImageUi() {
    if (!referenceImage) {
      referenceDrop.classList.remove("has-image");
      referenceText.textContent = "choose reference image";
      referenceName.textContent = "none";
      return;
    }

    referenceDrop.classList.add("has-image");
    referenceText.textContent = "reference image";
    referenceName.textContent = referenceImage.name;
  }

  async function setReferenceImageFromFile(file) {
    if (!file?.type?.startsWith("image/")) {
      setStatus("warn", "Choose an image file to use as reference");
      return;
    }

    referenceImage = {
      dataUrl: await fileToDataUrl(file),
      name: file.name || "reference-image.png",
      type: file.type || "image/png",
    };
    referenceAssetSearchText = "";

    updateReferenceImageUi();
    setStatus("ok", `Reference image set: ${referenceImage.name}`);
  }

  function setStatus(type, msg) {
    statusBar.textContent = msg;
    statusBar.className = type || "";
  }

  function isVisible(el) {
    if (!el) return false;

    const rect = el.getBoundingClientRect();

    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    let current = el;

    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);

      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0" ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return false;
      }

      current = current.parentElement;
    }

    return true;
  }

  function findEl(selectorList) {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);

      if (el && isVisible(el)) {
        return el;
      }
    }

    return null;
  }

  function normalizeIdSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);

    console.warn("[Flow Queue] Invalid previousTileIds value:", value);
    return new Set();
  }

  function getGenerationRoot() {
    return (
      document.querySelector('[data-testid="virtuoso-item-list"]') || document
    );
  }

  function getGeneratedTileIds() {
    return new Set(
      getGenerationTiles()
        .map(getGenerationTileKey)
        .filter(Boolean),
    );
  }

  function getGenerationTileKey(tile) {
    if (!tile) return "";

    const tileId =
      tile.getAttribute("data-tile-id") ||
      tile.closest("[data-tile-id]")?.getAttribute("data-tile-id");

    if (tileId) return `tile:${tileId}`;

    const editHref =
      tile.matches?.('a[href*="/edit/"]') && tile.href
        ? tile.href
        : tile.querySelector?.('a[href*="/edit/"]')?.href ||
          tile.closest?.('a[href*="/edit/"]')?.href;

    if (editHref) return `edit:${editHref}`;

    const media = tile.matches?.("img, canvas, video")
      ? tile
      : tile.querySelector?.("img, canvas, video");

    if (media) {
      const src =
        media.currentSrc ||
        media.src ||
        media.getAttribute("src") ||
        media.getAttribute("poster") ||
        media.getAttribute("alt") ||
        "";

      const rect = media.getBoundingClientRect();
      const rectKey = [
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
      ].join(":");

      return `media:${src.slice(0, 160)}:${rectKey}`;
    }

    return "";
  }

  function findGenerationCandidateContainer(el) {
    if (!el || !isVisible(el)) return null;

    const byTileId = el.closest("[data-tile-id]");
    if (byTileId && isVisible(byTileId)) return byTileId;

    const byEditLink = el.closest('a[href*="/edit/"]');
    if (byEditLink && isVisible(byEditLink)) return byEditLink;

    let current = el;
    let best = el;

    for (let i = 0; i < 8 && current?.parentElement; i++) {
      current = current.parentElement;

      if (!isVisible(current) || current.closest("#fpq-root")) continue;

      const rect = current.getBoundingClientRect();
      const bestRect = best.getBoundingClientRect();
      const area = rect.width * rect.height;
      const bestArea = bestRect.width * bestRect.height;
      const hasGenerationSurface = current.querySelector(
        'img, canvas, video, a[href*="/edit/"]',
      );

      if (
        hasGenerationSurface &&
        area >= bestArea &&
        rect.width >= 120 &&
        rect.height >= 120
      ) {
        best = current;
      }
    }

    return best;
  }

  function getGenerationTiles() {
    const root = getGenerationRoot();
    const candidates = [];

    const addCandidate = (el) => {
      const candidate = findGenerationCandidateContainer(el);

      if (!candidate || candidate.closest("#fpq-root")) return;
      if (!isVisible(candidate)) return;

      candidates.push(candidate);
    };

    Array.from(
      root.querySelectorAll('[data-tile-id], a[href*="/edit/"], img, canvas, video'),
    )
      .filter(isVisible)
      .forEach(addCandidate);

    const seen = new Set();

    return candidates.filter((candidate) => {
      const key = getGenerationTileKey(candidate);

      if (!key || seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  }

  function getNewGenerationTiles(previousTileIds) {
    const safePreviousIds = normalizeIdSet(previousTileIds);

    return getGenerationTiles().filter((tile) => {
      const id = getGenerationTileKey(tile);
      return id && !safePreviousIds.has(id);
    });
  }

  function getProgressCards() {
    const root = getGenerationRoot();

    return Array.from(root.querySelectorAll("div")).filter((el) => {
      const text = el.textContent?.trim() || "";

      if (!/^\d{1,3}%$/.test(text)) return false;

      const value = parseInt(text.replace("%", ""), 10);

      if (!Number.isFinite(value)) return false;
      if (value >= 100) return false;

      return isVisible(el);
    });
  }

  function hasActiveGenerationProgress() {
    return getProgressCards().length > 0;
  }

  function getLatestProgressValue() {
    const values = getProgressCards()
      .map((el) => parseInt(el.textContent.trim().replace("%", ""), 10))
      .filter((n) => Number.isFinite(n));

    return values.length ? Math.max(...values) : null;
  }

  function tileHasProgress(tile) {
    if (!tile) return false;

    return Array.from(tile.querySelectorAll("div")).some((el) => {
      const text = el.textContent?.trim() || "";

      if (!/^\d{1,3}%$/.test(text) || !isVisible(el)) {
        return false;
      }

      const value = parseInt(text.replace("%", ""), 10);

      return Number.isFinite(value) && value < 100;
    });
  }

  function hasVisibleText(tile, matcher) {
    if (!tile) return false;

    return Array.from(tile.querySelectorAll("*")).some((el) => {
      if (!isVisible(el)) return false;

      const text = el.textContent?.trim().toLowerCase() || "";

      return matcher(text, el);
    });
  }

  function getOwnText(el) {
    return Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim().toLowerCase())
      .filter(Boolean)
      .join(" ");
  }

  function tileIsFailed(tile) {
    if (!tile || !isVisible(tile)) return false;

    return hasVisibleText(tile, (_text, el) => {
      const ownText = getOwnText(el);

      return ownText === "failed";
    });
  }

  function tileLooksCompleted(tile) {
    if (!tile || !isVisible(tile)) return false;

    if (tileHasProgress(tile)) return false;
    if (tileIsFailed(tile)) return false;

    const hasVisibleMedia = Array.from(
      tile.querySelectorAll("img, canvas, video"),
    ).some(isVisible);

    const hasVisibleReusePrompt = hasVisibleText(tile, (text) =>
      text.includes("reuse prompt"),
    );

    const hasVisibleDelete = hasVisibleText(tile, (text) =>
      text.includes("delete"),
    );

    return hasVisibleMedia || hasVisibleReusePrompt || hasVisibleDelete;
  }

  function getVisibleText(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );

    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getElementCenter(el) {
    const rect = el.getBoundingClientRect();

    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      rect,
    };
  }

  function distanceBetweenRects(a, b) {
    const ac = getElementCenter(a);
    const bc = getElementCenter(b);

    return Math.hypot(ac.x - bc.x, ac.y - bc.y);
  }

  function getPromptEditorClickTarget(editor) {
    if (!editor) return null;

    const targetLooksClickable = (el) => {
      if (!el || el === editor) return false;

      const rect = el.getBoundingClientRect();

      if (rect.height <= 0) return false;

      const style = window.getComputedStyle(el);

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    return Array.from(
      editor.querySelectorAll(
        [
          '[data-slate-string="true"]',
          "[data-slate-zero-width]",
          '[data-slate-leaf="true"]',
          '[data-slate-node="text"]',
        ].join(", "),
      ),
    )
      .reverse()
      .find(targetLooksClickable);
  }

  async function focusSlateEditor(editor, label = "prompt editor") {
    if (!editor) return false;

    editor.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(300);

    const clickTarget = getPromptEditorClickTarget(editor);

    if (clickTarget) {
      const rect = clickTarget.getBoundingClientRect();

      if (rect.width > 0) {
        await realClickElement(clickTarget, label);
      } else {
        editor.focus({ preventScroll: true });
      }
    } else {
      editor.focus({ preventScroll: true });
    }

    await sleep(500);

    return (
      document.activeElement === editor ||
      editor.contains(document.activeElement)
    );
  }

  async function realClickPromptEditor(editor, label = "prompt editor") {
    const clickTarget = getPromptEditorClickTarget(editor);

    if (!clickTarget) {
      editor?.focus?.({ preventScroll: true });
      return false;
    }

    return realClickElement(clickTarget, label);
  }

  function findBestCardContainer(tile) {
    if (!tile) return null;

    // Best stable anchor: generated tiles already have data-tile-id.
    const byTileId = tile.closest("[data-tile-id]");
    if (byTileId) return byTileId;

    // Fallback: climb up until we find a visible parent that looks like a card.
    let current = tile;
    let best = tile;

    for (let i = 0; i < 10 && current?.parentElement; i++) {
      current = current.parentElement;

      if (!isVisible(current)) continue;

      const rect = current.getBoundingClientRect();
      const bestRect = best.getBoundingClientRect();

      const area = rect.width * rect.height;
      const bestArea = bestRect.width * bestRect.height;

      const hasMedia = current.querySelector("img, canvas, video");
      const hasButtons = current.querySelector("button, [role='button']");

      // Prefer a parent that contains media + buttons and has a card-like size.
      if (
        area > bestArea &&
        rect.width >= 160 &&
        rect.height >= 160 &&
        (hasMedia || hasButtons)
      ) {
        best = current;
      }
    }

    return best;
  }

  function buttonLooksLikeMore(btn) {
    if (!btn || !isVisible(btn)) return false;

    const iconTexts = Array.from(btn.querySelectorAll("i"))
      .map((icon) => icon.textContent?.trim())
      .filter(Boolean);

    if (
      iconTexts.includes("more_vert") ||
      iconTexts.includes("more_horiz") ||
      iconTexts.includes("more") ||
      iconTexts.includes("kebab_vertical") ||
      iconTexts.includes("overflow")
    ) {
      return true;
    }

    const label = [
      btn.getAttribute("aria-label"),
      btn.getAttribute("title"),
      btn.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      label.includes("more") ||
      label.includes("options") ||
      label.includes("menu") ||
      label.includes("actions")
    );
  }

  function getRectDistance(a, b) {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();

    const ax = ar.left + ar.width / 2;
    const ay = ar.top + ar.height / 2;
    const bx = br.left + br.width / 2;
    const by = br.top + br.height / 2;

    return Math.hypot(ax - bx, ay - by);
  }

  function findTileMoreButton(tile) {
    if (!tile) return null;

    const card = findBestCardContainer(tile);

    if (!card) return null;

    // 1. First try buttons inside the card.
    const localButtons = Array.from(
      card.querySelectorAll("button, [role='button']"),
    ).filter(isVisible);

    const localMoreButton = localButtons.find(buttonLooksLikeMore);

    if (localMoreButton) {
      return localMoreButton;
    }

    // 2. If no obvious "more" button, choose the top-right visible button inside the card.
    // This is usually where Flow puts the menu button.
    const cardRect = card.getBoundingClientRect();

    const topRightLocalButton = localButtons
      .map((btn) => {
        const rect = btn.getBoundingClientRect();

        const distanceFromTopRight = Math.hypot(
          rect.left + rect.width / 2 - cardRect.right,
          rect.top + rect.height / 2 - cardRect.top,
        );

        return {
          btn,
          distanceFromTopRight,
        };
      })
      .sort((a, b) => a.distanceFromTopRight - b.distanceFromTopRight)[0]?.btn;

    if (topRightLocalButton) {
      return topRightLocalButton;
    }

    // 3. Last fallback: search all visible menu-like buttons globally
    // and pick the one closest to the generated card.
    const globalMoreButtons = Array.from(
      document.querySelectorAll("button, [role='button']"),
    )
      .filter((btn) => isVisible(btn))
      .filter((btn) => !btn.closest("#fpq-root"))
      .filter(buttonLooksLikeMore);

    if (!globalMoreButtons.length) {
      return null;
    }

    globalMoreButtons.sort(
      (a, b) => getRectDistance(a, card) - getRectDistance(b, card),
    );

    return globalMoreButtons[0];
  }

  function makeFilenameFromPrompt(index, prompt) {
    const raw = String(prompt || "flow-image")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    const excerpt =
      raw
        .split(" ")
        .filter(Boolean)
        .slice(0, 6)
        .join("-") || "flow-image";

    return `${index + 1},${excerpt}`;
  }

  async function setNextDownloadFilename(filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_SET_NEXT_DOWNLOAD_FILENAME",
          filename,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Could not set next download filename:",
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn(
              "[Flow Queue] Could not set next download filename:",
              response,
            );
            resolve(false);
            return;
          }

          resolve({
            ok: true,
            filename: response.filename,
            requestId: response.requestId,
          });
        },
      );
    });
  }

  async function waitForDownloadConfirmation(requestId) {
    if (!requestId) {
      return false;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_WAIT_FOR_DOWNLOAD",
          requestId,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Download confirmation failed:",
              chrome.runtime.lastError.message,
            );
            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn(
              "[Flow Queue] Download confirmation returned non-ok response:",
              response,
            );
            resolve(false);
            return;
          }

          resolve(response.state === "complete");
        },
      );
    });
  }

  async function insertTextWithDebugger(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_INSERT_TEXT",
          text,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Debugger insert failed:",
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn("[Flow Queue] Debugger insert failed:", response);
            resolve(false);
            return;
          }

          resolve(true);
        },
      );
    });
  }

  async function clearTextWithDebugger() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_CLEAR_TEXT",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Debugger clear failed:",
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn("[Flow Queue] Debugger clear failed:", response);
            resolve(false);
            return;
          }

          resolve(true);
        },
      );
    });
  }

  async function realClickElement(el, label = "element") {
    if (!el || !isVisible(el)) {
      console.warn(`[Flow Queue] Cannot click ${label}: not visible`);
      return false;
    }

    el.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(500);

    const rect = el.getBoundingClientRect();

    const isSubmenuTrigger =
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-expanded") !== null;

    const x = Math.round(
      isSubmenuTrigger
        ? rect.right - Math.min(12, rect.width / 4)
        : rect.left + rect.width / 2,
    );

    const y = Math.round(rect.top + rect.height / 2);

    const clicked = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_CLICK_AT",
          x,
          y,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              `[Flow Queue] Debugger click failed for ${label}:`,
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn(
              `[Flow Queue] Debugger click failed for ${label}:`,
              response,
            );
            resolve(false);
            return;
          }

          resolve(true);
        },
      );
    });

    if (clicked) return true;

    try {
      el.click();
      return true;
    } catch (err) {
      console.warn(`[Flow Queue] Fallback click failed for ${label}:`, err);
      return false;
    }
  }

  function findVisibleMenuItemByText(text) {
    const target = text.toLowerCase();

    return Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (item) => {
        if (!isVisible(item)) return false;

        const itemText = getVisibleText(item).toLowerCase();

        return itemText.includes(target);
      },
    );
  }

  async function hoverElement(el, label = "element") {
    if (!el) return false;

    el.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(500);

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    const events = [
      new PointerEvent("pointerover", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        pointerType: "mouse",
      }),
      new PointerEvent("pointerenter", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        pointerType: "mouse",
      }),
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        pointerType: "mouse",
      }),
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
      new MouseEvent("mouseenter", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      }),
    ];

    events.forEach((event) => el.dispatchEvent(event));

    console.log(`[Flow Queue] Hovered ${label}`);

    await sleep(1200);

    return true;
  }

  async function moveMouseToPoint(x, y, label = "point") {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_MOUSE_MOVE_TO",
          x,
          y,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              `[Flow Queue] Debugger mouse move failed for ${label}:`,
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          resolve(Boolean(response?.ok));
        },
      );
    });
  }

  async function moveMouseToElement(el, label = "element") {
    if (!el || !isVisible(el)) return false;

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    return moveMouseToPoint(x, y, label);
  }

  function findTileMoreButton(tile) {
    if (!tile) return null;

    const card = findBestCardContainer(tile);

    const localCandidates = Array.from(
      card.querySelectorAll("button, [role='button']"),
    );

    const localMoreButton = localCandidates.find(buttonLooksLikeMore);

    if (localMoreButton) return localMoreButton;

    const globalCandidates = Array.from(
      document.querySelectorAll("button, [role='button']"),
    ).filter((btn) => isVisible(btn) && buttonLooksLikeMore(btn));

    if (!globalCandidates.length) {
      return null;
    }

    globalCandidates.sort(
      (a, b) => distanceBetweenRects(a, card) - distanceBetweenRects(b, card),
    );

    return globalCandidates[0];
  }

  async function waitForMenuOpen(timeout = 5000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(
        isVisible,
      );

      if (menu) return menu;

      await sleep(500);
    }

    return null;
  }

  async function getVisibleMenuItems() {
    return Array.from(document.querySelectorAll('[role="menuitem"]')).filter(
      isVisible,
    );
  }

  async function waitForDownloadSubmenuOpen(timeout = 8000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const menuItems = await getVisibleMenuItems();

      const twoKItem = menuItems.find((item) => {
        const text = getVisibleText(item).toLowerCase();
        const ariaDisabled = item.getAttribute("aria-disabled") === "true";

        return (
          !ariaDisabled &&
          (text.includes("2k") ||
            text.includes("2 k") ||
            text.includes("upscaled"))
        );
      });

      if (twoKItem) return twoKItem;

      await sleep(300);
    }

    return null;
  }

  async function clickDownloadMenuItem() {
    const menuItems = await getVisibleMenuItems();

    const downloadItem = menuItems.find((item) => {
      const text = getVisibleText(item).toLowerCase();

      const hasDownloadIcon = Array.from(item.querySelectorAll("i")).some(
        (icon) => icon.textContent?.trim() === "download",
      );

      const hasSubmenu =
        item.getAttribute("aria-haspopup") === "menu" ||
        item.getAttribute("aria-expanded") !== null;

      return hasDownloadIcon && hasSubmenu && text.includes("download");
    });

    if (!downloadItem) {
      console.warn("[Flow Queue] Download menu item not found");
      return false;
    }

    downloadItem.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(300);

    const rect = downloadItem.getBoundingClientRect();

    const x = Math.round(rect.right - 8);
    const y = Math.round(rect.top + rect.height / 2);

    await moveMouseToPoint(x, y, "Download submenu trigger");

    const hoverEvents = [
      "pointerover",
      "pointerenter",
      "pointermove",
      "mouseover",
      "mouseenter",
      "mousemove",
    ];

    for (const eventName of hoverEvents) {
      const EventCtor = eventName.startsWith("pointer")
        ? PointerEvent
        : MouseEvent;

      downloadItem.dispatchEvent(
        new EventCtor(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          pointerType: "mouse",
        }),
      );
    }

    await sleep(1200);

    const submenuItem = await waitForDownloadSubmenuOpen(5000);

    if (submenuItem) {
      console.log("[Flow Queue] Download submenu opened by hover");
      return true;
    }

    console.warn(
      "[Flow Queue] Hover did not open Download submenu, trying click",
    );

    await realClickElement(downloadItem, "Download menu item fallback click");
    await sleep(1200);

    return Boolean(await waitForDownloadSubmenuOpen(5000));
  }

  async function syntheticClick(el, label = "element") {
    if (!el || !isVisible(el)) {
      console.warn(`[Flow Queue] Cannot synthetic-click ${label}: not visible`);
      return false;
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(300);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const sequence = [
      "pointerover",
      "pointerenter",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ];

    for (const eventName of sequence) {
      const EventCtor = eventName.startsWith("pointer")
        ? PointerEvent
        : MouseEvent;

      el.dispatchEvent(
        new EventCtor(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button: 0,
          pointerType: "mouse",
        }),
      );
    }

    return true;
  }

  function findDownloadToolbarButtonNow() {
    return (
      Array.from(
        document.querySelectorAll('button[aria-haspopup="menu"]'),
      ).find((btn) => {
        if (!isVisible(btn)) return false;

        const hasDownloadIcon = Array.from(btn.querySelectorAll("i")).some(
          (icon) => icon.textContent?.trim() === "download",
        );

        return hasDownloadIcon;
      }) || null
    );
  }

  async function waitForDownloadToolbarButton(timeout = 8000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const btn = findDownloadToolbarButtonNow();

      if (btn) return btn;

      await sleep(400);
    }

    return null;
  }

  async function clickDownloadSubmenuOption() {
    const started = Date.now();
    const timeout = 10000;

    const matches2K = (text) =>
      text.includes("2k") || text.includes("2 k") || text.includes("upscaled");

    let openedDownloadSubmenu = false;

    while (Date.now() - started < timeout) {
      const menuItems = await getVisibleMenuItems();

      // Direct 2K item visible?
      const twoKItem = menuItems.find((item) => {
        const text = getVisibleText(item).toLowerCase();
        const ariaDisabled = item.getAttribute("aria-disabled") === "true";

        return !ariaDisabled && matches2K(text);
      });

      if (twoKItem) {
        await moveMouseToElement(twoKItem, "2K download option");
        await sleep(300);

        return realClickElement(twoKItem, "2K download option");
      }

      // Otherwise, a "Download" submenu trigger may need hovering first.
      if (!openedDownloadSubmenu) {
        const downloadSubmenu = menuItems.find((item) => {
          const text = getVisibleText(item).toLowerCase();
          const hasSubmenu =
            item.getAttribute("aria-haspopup") === "menu" ||
            item.getAttribute("aria-expanded") !== null;

          return text.includes("download") && hasSubmenu;
        });

        if (downloadSubmenu) {
          await moveMouseToElement(downloadSubmenu, "Download submenu trigger");
          await sleep(900);
          openedDownloadSubmenu = true;
          continue;
        }
      }

      await sleep(300);
    }

    console.warn("[Flow Queue] 2K download option not found");
    return false;
  }

  async function downloadTile(tile, filename = "flow-image") {
    if (!tile || !isVisible(tile)) {
      console.warn("[Flow Queue] Cannot download: completed tile not found");
      return false;
    }

    // Open the image detail view, where the Download button lives.
    // Each gallery tile image sits inside an <a href=".../edit/<id>"> link,
    // so we navigate via that link. The completed tile passed in may itself
    // not contain the link, so we resolve it robustly.
    const tileImg = tile.querySelector("img");

    let detailLink = tile.querySelector('a[href*="/edit/"]');

    // Fallback 1: the tile may be nested inside the link.
    if (!detailLink) {
      detailLink = tile.closest('a[href*="/edit/"]');
    }

    // Fallback 2: resolve via the tile's data-tile-id across the gallery.
    if (!detailLink) {
      const tid =
        tile.getAttribute("data-tile-id") ||
        tile.closest("[data-tile-id]")?.getAttribute("data-tile-id");

      if (tid) {
        const galleryTile = Array.from(
          document.querySelectorAll(`[data-tile-id="${tid}"]`),
        ).find((t) => t.querySelector('a[href*="/edit/"]'));

        detailLink = galleryTile?.querySelector('a[href*="/edit/"]') || null;
      }
    }

    // Fallback 3: any visible detail link tied to the tile's image src.
    if (!detailLink && tileImg) {
      const links = Array.from(
        document.querySelectorAll('a[href*="/edit/"]'),
      ).filter(isVisible);

      detailLink =
        links.find((a) => a.querySelector("img") === tileImg) ||
        links.find((a) => a.contains(tileImg)) ||
        null;
    }

    console.log("[Flow Queue] Download nav target:", {
      foundDetailLink: !!detailLink,
      href: detailLink?.getAttribute("href") || null,
      tileId: tile.getAttribute("data-tile-id") || null,
    });

    setStatus("", "Opening image detail view…");

    // The detail <a> link may not be navigable immediately after generation.
    // Poll: (re)resolve the link, synthetic-click it, and confirm the URL
    // actually moved to /edit/ — retry until it does or we time out.
    const navStarted = Date.now();
    const navTimeout = 20000;

    const resolveDetailLink = () => {
      let link = tile.querySelector('a[href*="/edit/"]');

      if (!link) link = tile.closest('a[href*="/edit/"]');

      if (!link) {
        const tid =
          tile.getAttribute("data-tile-id") ||
          tile.closest("[data-tile-id]")?.getAttribute("data-tile-id");

        if (tid) {
          const gt = Array.from(
            document.querySelectorAll(`[data-tile-id="${tid}"]`),
          ).find((t) => t.querySelector('a[href*="/edit/"]'));

          link = gt?.querySelector('a[href*="/edit/"]') || null;
        }
      }

      if (!link && tileImg) {
        const links = Array.from(
          document.querySelectorAll('a[href*="/edit/"]'),
        ).filter(isVisible);

        link =
          links.find((a) => a.contains(tileImg)) || null;
      }

      return link;
    };

    while (!location.href.includes("/edit/") && Date.now() - navStarted < navTimeout) {
      const link = resolveDetailLink() || detailLink;

      if (link && isVisible(link)) {
        await syntheticClick(link, "image detail link");
      } else if (tileImg && isVisible(tileImg)) {
        await syntheticClick(tileImg, "generated image");
      }

      await sleep(1500);
    }

    console.log("[Flow Queue] After nav, url:", location.href);

    const tryTriggerDownload = async (attemptNumber) => {
      setStatus("", `Locating Download button (attempt ${attemptNumber})…`);

      const downloadButton = await waitForDownloadToolbarButton(8000);

      if (!downloadButton) {
        console.warn("[Flow Queue] Download toolbar button not found", {
          haspopupButtons: Array.from(
            document.querySelectorAll('button[aria-haspopup="menu"]'),
          ).map((b) => ({
            icons: Array.from(b.querySelectorAll("i")).map((i) =>
              i.textContent?.trim(),
            ),
            visible: isVisible(b),
          })),
        });
        return false;
      }

      setStatus("", `Opening Download menu (attempt ${attemptNumber})…`);

      await realClickElement(downloadButton, "Download button");

      let menu = await waitForMenuOpen(3000);

      if (!menu) {
        await syntheticClick(downloadButton, "Download button (synthetic)");
        menu = await waitForMenuOpen(4000);
      }

      if (!menu) {
        console.warn("[Flow Queue] Download menu did not open");
        return false;
      }

      await sleep(1000);

      setStatus("", `Selecting 2K download option (attempt ${attemptNumber})…`);

      const nextDownload = await setNextDownloadFilename(filename);

      if (!nextDownload?.ok) {
        console.warn("[Flow Queue] Could not prepare next download filename");
        return false;
      }

      const clicked2K = await clickDownloadSubmenuOption();

      if (!clicked2K) {
        console.warn("[Flow Queue] Could not select 2K download option");
        return false;
      }

      setStatus("", "Waiting for download confirmation…");

      const confirmed = await waitForDownloadConfirmation(
        nextDownload.requestId,
      );

      if (!confirmed) {
        console.warn("[Flow Queue] Download was not confirmed by Chrome");
        return false;
      }

      return true;
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const ok = await tryTriggerDownload(attempt);

      if (ok) {
        setStatus("ok", "2K download confirmed");
        return true;
      }

      if (attempt < 2) {
        setStatus("warn", "Download did not confirm. Retrying…");
        await sleep(1800);
      }
    }

    setStatus("warn", "Download could not be confirmed after retry");
    return false;
  }

  function registerFlowController() {
    chrome.runtime.sendMessage({ type: "MAQ_REGISTER_FLOW_CONTROLLER" }, () => {
      void chrome.runtime.lastError;
    });
  }

  function activateFlowTab() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MAQ_ACTIVATE_FLOW_TAB" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        resolve(Boolean(response?.ok));
      });
    });
  }

  function pickSrcFromSrcset(srcset) {
    return String(srcset || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
      .pop();
  }

  function getBackgroundImageUrl(el) {
    const match = window
      .getComputedStyle(el)
      .backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);

    return match?.[1] || "";
  }

  async function imageSourceToPayload(src) {
    if (!src) return null;

    if (src.startsWith("data:")) {
      const mimeType = src.match(/^data:([^;,]+)/)?.[1] || "image/png";
      return { dataUrl: src, mimeType };
    }

    const resp = await fetch(src);
    if (!resp.ok) {
      throw new Error(`Could not fetch generated image (${resp.status})`);
    }

    const blob = await resp.blob();
    if (!blob.size) {
      throw new Error("Generated image payload was empty");
    }

    return {
      dataUrl: await fileToDataUrl(blob),
      mimeType: blob.type || "image/png",
    };
  }

  async function mediaElementToPayload(el) {
    if (!el || !isVisible(el) || el.closest("#fpq-root")) {
      return null;
    }

    if (el.tagName === "CANVAS") {
      const dataUrl = el.toDataURL("image/png");
      return dataUrl ? { dataUrl, mimeType: "image/png" } : null;
    }

    const src =
      el.currentSrc ||
      el.src ||
      pickSrcFromSrcset(el.getAttribute?.("srcset")) ||
      el.getAttribute?.("src") ||
      getBackgroundImageUrl(el);

    return imageSourceToPayload(src);
  }

  async function extractTileImagePayload(tile) {
    const roots = [tile, location.href.includes("/edit/") ? document : null].filter(
      Boolean,
    );

    const candidates = [];
    for (const rootNode of roots) {
      const nodes = Array.from(
        rootNode.querySelectorAll?.("img, source, canvas, [role='img']") || [],
      );

      if (rootNode.matches?.("img, source, canvas, [role='img']")) {
        nodes.unshift(rootNode);
      }

      candidates.push(...nodes.filter(isVisible));
    }

    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });

    for (const candidate of candidates) {
      try {
        const payload = await mediaElementToPayload(candidate);
        if (payload) return payload;
      } catch (err) {
        console.warn("[Flow Queue] Image payload candidate failed:", err);
      }
    }

    return null;
  }

  function enqueueMetaJob(job) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "MAQ_ENQUEUE_META_JOB", job },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Could not enqueue Meta job:",
              chrome.runtime.lastError.message,
            );
            resolve(false);
            return;
          }

          resolve(Boolean(response?.ok));
        },
      );
    });
  }

  function getGeneratedAssetSearchText(tile) {
    const imgAlt = tile?.querySelector("img[alt]")?.getAttribute("alt") || "";
    const visibleText = getVisibleText(tile);

    return (imgAlt || visibleText).replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function normalizeAssetName(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function findCreateAssetButton() {
    return Array.from(document.querySelectorAll("button")).find((btn) => {
      if (!isVisible(btn)) return false;

      const text = getVisibleText(btn).toLowerCase();
      const iconText = btn.querySelector("i")?.textContent?.trim();

      return iconText === "add_2" || text === "create";
    });
  }

  async function waitForAssetDialog(timeout = 8000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const searchInput = document.querySelector("#quick-search-input");
      const dialog = searchInput?.closest('[role="dialog"]');

      if (dialog && isVisible(dialog)) {
        return dialog;
      }

      await sleep(300);
    }

    return null;
  }

  async function waitForAssetDialogClosed(timeout = 6000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const searchInput = document.querySelector("#quick-search-input");
      const dialog = searchInput?.closest('[role="dialog"]');

      if (!dialog || !isVisible(dialog)) {
        return true;
      }

      await sleep(300);
    }

    return false;
  }

  function getAssetOptions(dialog) {
    const list =
      dialog.querySelector('[data-testid="virtuoso-item-list"]') || dialog;

    return Array.from(list.querySelectorAll('[role="option"]')).filter(
      (option) => isVisible(option),
    );
  }

  function findAssetOption(dialog, searchText = "") {
    const options = getAssetOptions(dialog).filter((option) =>
      getVisibleText(option).toLowerCase().includes("image"),
    );

    const normalizedSearch = normalizeAssetName(searchText);

    if (normalizedSearch) {
      const matchingOption = options.find((option) => {
        const text = normalizeAssetName(getVisibleText(option));
        const imgAlt = normalizeAssetName(
          option.querySelector("img[alt]")?.getAttribute("alt") || "",
        );

        return (
          text.includes(normalizedSearch) ||
          normalizedSearch.includes(text) ||
          (imgAlt &&
            (imgAlt.includes(normalizedSearch) ||
              normalizedSearch.includes(imgAlt)))
        );
      });

      if (matchingOption) return matchingOption;
    }

    return options[0] || null;
  }

  function findMatchingAssetOption(dialog, searchText = "") {
    const options = getAssetOptions(dialog).filter((option) =>
      getVisibleText(option).toLowerCase().includes("image"),
    );
    const normalizedSearch = normalizeAssetName(searchText);

    if (!normalizedSearch) return null;

    return (
      options.find((option) => {
        const text = normalizeAssetName(getVisibleText(option));
        const imgAlt = normalizeAssetName(
          option.querySelector("img[alt]")?.getAttribute("alt") || "",
        );

        return (
          text.includes(normalizedSearch) ||
          normalizedSearch.includes(text) ||
          (imgAlt &&
            (imgAlt.includes(normalizedSearch) ||
              normalizedSearch.includes(imgAlt)))
        );
      }) || null
    );
  }

  async function waitForMatchingAssetOption(
    dialog,
    searchText = "",
    timeout = 5000,
  ) {
    const searchInput = dialog.querySelector("#quick-search-input");
    const started = Date.now();

    if (searchText && searchInput) {
      searchInput.focus();
      setNativeInputValue(searchInput, searchText);
    }

    while (Date.now() - started < timeout) {
      const option = searchText
        ? findMatchingAssetOption(dialog, searchText)
        : findAssetOption(dialog, searchText);

      if (option) return option;

      await sleep(300);
    }

    return null;
  }

  async function openAssetDialog() {
    const createButton = findCreateAssetButton();

    if (!createButton) {
      console.warn("[Flow Queue] Create asset button not found");
      setStatus("err", "Create button not found");
      return null;
    }

    setStatus("", "Opening assets picker...");
    await realClickElement(createButton, "Create asset button");

    const dialog = await waitForAssetDialog();

    if (!dialog) {
      setStatus("err", "Assets picker did not open");
      return null;
    }

    const imagesTab = Array.from(dialog.querySelectorAll('[role="tab"]')).find(
      (tab) => getVisibleText(tab).toLowerCase().includes("images"),
    );

    if (imagesTab && imagesTab.getAttribute("aria-selected") !== "true") {
      await realClickElement(imagesTab, "Images tab");
      await sleep(800);
    }

    return dialog;
  }

  async function closeAssetDialog(dialog) {
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      await sleep(500);
    } catch (err) {
      console.warn("[Flow Queue] Could not close assets picker:", err);
    }
  }

  async function findReferenceImageInAssets() {
    if (!referenceImage?.name) return "";

    const dialog = await openAssetDialog();

    if (!dialog) return "";

    const option = await waitForMatchingAssetOption(
      dialog,
      referenceImage.name,
      7000,
    );
    const matchedText = option ? getVisibleText(option) : "";

    await closeAssetDialog(dialog);

    if (!option) return "";

    return matchedText || referenceImage.name;
  }

  async function waitForAddToPromptButton(dialog, timeout = 5000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const addButton = Array.from(dialog.querySelectorAll("button")).find(
        (btn) => {
          const text = getVisibleText(btn).toLowerCase();

          return (
            isVisible(btn) &&
            !btn.disabled &&
            btn.getAttribute("aria-disabled") !== "true" &&
            text.trim() === "add to prompt"
          );
        },
      );

      if (addButton) return addButton;

      await sleep(300);
    }

    return null;
  }

  async function selectAssetOption(option, dialog, searchText = "") {
    const started = Date.now();
    const timeout = 5000;

    while (Date.now() - started < timeout) {
      if (!option?.isConnected || !isVisible(option)) {
        option = searchText
          ? findMatchingAssetOption(dialog, searchText)
          : findAssetOption(dialog);
      }

      if (!option) {
        await sleep(300);
        continue;
      }

      const existingAddButton = await waitForAddToPromptButton(dialog, 200);

      if (
        option.getAttribute("aria-selected") === "true" &&
        existingAddButton
      ) {
        return true;
      }

      option.scrollIntoView({
        block: "center",
        inline: "center",
      });

      await sleep(250);

      if (!option.isConnected || !isVisible(option)) {
        option = searchText
          ? findMatchingAssetOption(dialog, searchText)
          : findAssetOption(dialog);
        continue;
      }

      const clickTarget =
        option.querySelector(".sc-149a23e6-14") ||
        option.querySelector("img[alt]") ||
        option;

      clickTarget.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerType: "mouse",
        }),
      );
      clickTarget.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      clickTarget.click();
      clickTarget.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      clickTarget.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );

      await realClickElement(clickTarget, "Generated image asset");
      await sleep(500);

      if (
        option.getAttribute("aria-selected") === "true" ||
        (await waitForAddToPromptButton(dialog, 600))
      ) {
        return true;
      }
    }

    return false;
  }

  async function clickAddToPromptButton(addButton) {
    addButton.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(250);
    addButton.click();
    await sleep(500);

    if (await waitForAssetDialogClosed(1200)) {
      return true;
    }

    await realClickElement(addButton, "Add to Prompt button");

    return waitForAssetDialogClosed(5000);
  }

  function getPromptComposerRoot() {
    const editor = findEl(SELECTORS.promptInput);

    return (
      editor?.closest(".sc-439ac1d3-0") ||
      editor?.closest("form") ||
      editor?.parentElement ||
      document
    );
  }

  function getPromptAttachedMediaElements() {
    const promptRoot = getPromptComposerRoot();

    return Array.from(
      promptRoot.querySelectorAll(
        [
          'button[data-card-open] img[alt*="present in your collection" i]',
          'button[data-card-open] img[src*="media.getMediaUrlRedirect"]',
          'button[data-card-open="false"] img',
        ].join(", "),
      ),
    ).filter(isVisible);
  }

  function getPromptAttachedMediaCount() {
    return getPromptAttachedMediaElements().length;
  }

  function promptHasAttachedMedia() {
    return getPromptAttachedMediaCount() > 0;
  }

  async function waitForPromptAttachedMedia(timeout = 8000, previousCount = 0) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const attachedCount = getPromptAttachedMediaCount();

      if (attachedCount > previousCount) {
        return true;
      }

      await sleep(300);
    }

    return false;
  }

  async function addGeneratedAssetToPrompt(tile = null, searchOverride = "") {
    const previousAttachedCount = getPromptAttachedMediaCount();
    const dialog = await openAssetDialog();

    if (!dialog) {
      return false;
    }

    const searchText = searchOverride || getGeneratedAssetSearchText(tile);
    const searchInput = dialog.querySelector("#quick-search-input");
    let option = searchText
      ? findMatchingAssetOption(dialog, searchText)
      : findAssetOption(dialog);

    if (!option && searchText) {
      option = await waitForMatchingAssetOption(dialog, searchText, 7000);
    }

    if (!option && searchInput) {
      setNativeInputValue(searchInput, "");
      await sleep(1200);
      option = findAssetOption(dialog, searchText);
    }

    if (!option) {
      setStatus("err", "Generated image not found in assets");
      return false;
    }

    const selected = await selectAssetOption(option, dialog, searchText);

    if (!selected) {
      setStatus("err", "Could not select generated image asset");
      return false;
    }

    const addButton = await waitForAddToPromptButton(dialog);

    if (!addButton) {
      setStatus("err", "Add to Prompt button not found");
      return false;
    }

    const added = await clickAddToPromptButton(addButton);

    if (!added) {
      setStatus("err", "Asset was not added to prompt");
      return false;
    }

    const attached = await waitForPromptAttachedMedia(
      10000,
      previousAttachedCount,
    );

    if (!attached) {
      setStatus("err", "Asset thumbnail did not appear in prompt");
      return false;
    }

    await sleep(800);

    return true;
  }

  async function addPromptTextToCurrentPrompt(text) {
    let editor = findEl(SELECTORS.promptInput);

    if (!editor) {
      await sleep(1000);
      editor = findEl(SELECTORS.promptInput);

      if (!editor) {
        setStatus("err", "Prompt editor not found");
        return false;
      }
    }

    await focusPromptEditor(editor);

    const inserted = await insertPromptTextIntoEditor(editor, text);

    if (!inserted) {
      setStatus("err", "Could not insert prompt after adding asset");
      return false;
    }

    await sleep(900);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    const currentText = (editor.innerText || editor.textContent || "").trim();

    if (!currentText.includes(text.slice(0, Math.min(30, text.length)))) {
      const submitBtn = await waitForSubmitButton(2000);

      if (!submitBtn) {
        setStatus("err", "Prompt text was not added after asset selection");
        return false;
      }
    }

    return true;
  }

  // ─── DRAGGING ─────────────────────────────────────────────────
  let dragging = false;
  let dragOffX = 0;
  let dragOffY = 0;

  $("fpq-header").addEventListener("mousedown", (e) => {
    if (document.documentElement.classList.contains("fpq-docked")) return;
    if (e.target.closest(".fpq-icon-btn")) return;

    dragging = true;

    const rect = root.getBoundingClientRect();

    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;

    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;

    root.style.right = "auto";
    root.style.left = e.clientX - dragOffX + "px";
    root.style.top = e.clientY - dragOffY + "px";
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
  });

  // ─── COLLAPSE / CLOSE ─────────────────────────────────────────
  collapseBtn.addEventListener("click", () => {
    root.classList.toggle("fpq-collapsed");
    const isCollapsed = root.classList.contains("fpq-collapsed");

    if (!isCollapsed) {
      root.style.left = "";
      root.style.top = "";
      root.style.right = "";
    }

    document.documentElement.classList.toggle("fpq-docked", !isCollapsed);

    collapseBtn.textContent = isCollapsed ? "▼" : "▲";
  });

  closeBtn.addEventListener("click", () => {
    document.documentElement.classList.remove("fpq-docked");
    document.documentElement.style.removeProperty("--fpq-dock-width");
    root.remove();
  });

  // ─── REFERENCE IMAGE ──────────────────────────────────────────
  referenceDrop.addEventListener("click", (e) => {
    if (e.target === referenceClear || e.target === referenceInput) return;
    referenceInput.click();
  });

  referenceDrop.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;

    e.preventDefault();
    referenceInput.click();
  });

  referenceInput.addEventListener("change", async () => {
    const file = Array.from(referenceInput.files || []).find((item) =>
      item.type?.startsWith("image/"),
    );

    await setReferenceImageFromFile(file);
    referenceInput.value = "";
  });

  ["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    referenceDrop.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  referenceClear.addEventListener("click", (e) => {
    e.stopPropagation();
    referenceImage = null;
    referenceAssetSearchText = "";
    updateReferenceImageUi();
    setStatus("", "Reference image removed");
  });

  // ─── ADD PROMPTS ──────────────────────────────────────────────
  function splitPromptBlocks(raw) {
    return String(raw || "")
      .trim()
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  function addPrompts() {
    const flowRaw = textarea.value.trim();
    const metaRaw = metaTextarea.value.trim();

    if (!flowRaw || !metaRaw) return;

    const flowBlocks = splitPromptBlocks(flowRaw);
    const metaBlocks = splitPromptBlocks(metaRaw);
    const n = Math.min(flowBlocks.length, metaBlocks.length);

    if (!n) return;

    if (flowBlocks.length !== metaBlocks.length) {
      setStatus(
        "warn",
        `${flowBlocks.length} flow blocks vs ${metaBlocks.length} meta blocks - running ${n} paired jobs`,
      );
    }

    for (let i = 0; i < n; i++) {
      queue.push({
        text: flowBlocks[i],
        flowText: flowBlocks[i],
        metaText: metaBlocks[i],
        done: false,
        active: false,
        metaStatus: "idle",
        id: ++idCounter,
      });
    }

    textarea.value = "";
    metaTextarea.value = "";
    delayBetween = parseInt(delayInput.value, 10) || 5;
    downloadFolder = getDownloadFolder();

    renderQueue();
    setStatus("", `${n} paired job(s) added`);
  }

  addBtn.addEventListener("click", addPrompts);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      addPrompts();
    }
  });

  if (metaTextarea) {
    metaTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        addPrompts();
      }
    });
  }

  // ─── RENDER QUEUE ─────────────────────────────────────────────
  function renderQueue() {
    const empty = root.querySelector("#fpq-queue-empty");

    root.querySelectorAll(".fpq-item").forEach((el) => el.remove());

    if (queue.length === 0) {
      if (empty) empty.style.display = "";
      progressBar.style.width = "0%";
      return;
    }

    if (empty) empty.style.display = "none";

    queue.forEach((item, i) => {
      const el = document.createElement("div");

      el.className =
        "fpq-item" +
        (item.done ? " fpq-done" : "") +
        (item.active ? " fpq-active" : "");

      el.dataset.id = item.id;

      const metaStatus = item.metaStatus || "idle";
      const metaStatusLabel =
        metaStatus === "done"
          ? "video done"
          : metaStatus === "running"
            ? "video running in background"
            : metaStatus === "queued"
              ? "video queued"
              : metaStatus === "failed"
                ? "video failed"
                : "video waiting";
      const statusIcon =
        metaStatus === "done"
          ? "✓"
          : metaStatus === "running"
            ? "▶"
            : metaStatus === "queued"
              ? "…"
              : item.done
                ? "✓"
                : item.active
                  ? "⟳"
                  : "·";

      el.innerHTML = `
        <span class="fpq-item-index">${i + 1}</span>
        <span class="fpq-item-text">${escHtml(item.flowText || item.text)}<br><span style="opacity:.55;font-size:10px">meta: ${escHtml(item.metaText || "")}</span><br><span style="opacity:.72;font-size:10px">${escHtml(metaStatusLabel)}</span></span>
        <span class="fpq-item-status">${statusIcon}</span>
        <button class="fpq-item-del" data-id="${item.id}" title="Remove">×</button>
      `;

      queueArea.appendChild(el);
    });

    root.querySelectorAll(".fpq-item-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();

        const id = parseInt(btn.dataset.id, 10);

        queue = queue.filter((q) => q.id !== id);

        renderQueue();
      });
    });

    const done = queue.filter((q) => q.done).length;

    progressBar.style.width = queue.length
      ? (done / queue.length) * 100 + "%"
      : "0%";
  }

  // ─── FIND SUBMIT BUTTON ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "MAQ_META_JOB_STATUS") {
      return;
    }

    const item = queue.find((q) => q.id === message.jobId);

    if (!item) {
      return;
    }

    item.metaStatus = message.status || item.metaStatus || "idle";
    if (message.error) {
      item.metaError = message.error;
    }
    renderQueue();
  });

  function buttonIsEnabled(btn) {
    return (
      btn &&
      isVisible(btn) &&
      !btn.disabled &&
      btn.getAttribute("aria-disabled") !== "true"
    );
  }

  function buttonIsInDialog(btn) {
    return Boolean(
      btn.closest('[role="dialog"], [data-radix-popper-content-wrapper]'),
    );
  }

  function buttonHasSubmitIcon(btn) {
    const iconText = btn.querySelector("i")?.textContent?.trim();

    return ["arrow_forward", "send", "arrow_upward"].includes(iconText);
  }

  function buttonHasIcon(btn, iconName) {
    return Array.from(btn.querySelectorAll("i")).some(
      (icon) => icon.textContent?.trim() === iconName,
    );
  }

  function buttonLooksLikeAssetCreate(btn) {
    return (
      buttonHasIcon(btn, "add_2") ||
      btn.getAttribute("aria-haspopup") === "dialog"
    );
  }

  function buttonLooksLikeSubmit(btn) {
    const label = [
      btn.getAttribute("aria-label"),
      btn.getAttribute("title"),
      btn.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      label.trim() === "create" ||
      label.includes("create") ||
      label.includes("submit") ||
      label.includes("generate") ||
      label.includes("send") ||
      buttonHasSubmitIcon(btn)
    );
  }

  function findDirectCreateSubmitButton(root = document) {
    const buttons = Array.from(
      root.querySelectorAll('button[aria-disabled="false"], button'),
    )
      .filter((btn) => buttonIsEnabled(btn) && !buttonIsInDialog(btn))
      .filter((btn) => !btn.closest("#fpq-root"))
      .filter((btn) => !buttonLooksLikeAssetCreate(btn));

    const submitIconButton = buttons.find(buttonHasSubmitIcon);

    if (submitIconButton) return submitIconButton;

    return buttons.find((btn) => {
      const text = [
        btn.getAttribute("aria-label"),
        btn.getAttribute("title"),
        btn.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return root !== document && text.includes("create");
    });
  }

  function findExactComposerSubmitButton(root = document) {
    return Array.from(
      root.querySelectorAll(
        'button.sc-439ac1d3-5, button[aria-disabled="false"]',
      ),
    )
      .filter((btn) => buttonIsEnabled(btn) && !buttonIsInDialog(btn))
      .filter((btn) => !btn.closest("#fpq-root"))
      .filter((btn) => !buttonLooksLikeAssetCreate(btn))
      .find(buttonHasSubmitIcon);
  }

  function findSubmitBtn() {
    const editor = findEl(SELECTORS.promptInput);
    const promptRoot =
      editor?.closest(".sc-439ac1d3-0") ||
      editor?.closest("form") ||
      editor?.parentElement;

    const exactPromptButton = promptRoot
      ? findExactComposerSubmitButton(promptRoot)
      : null;

    if (exactPromptButton) {
      return exactPromptButton;
    }

    const directPromptButton = promptRoot
      ? findDirectCreateSubmitButton(promptRoot)
      : null;

    if (directPromptButton) {
      return directPromptButton;
    }

    const promptSubmitButton = promptRoot
      ? Array.from(promptRoot.querySelectorAll("button"))
          .filter((btn) => buttonIsEnabled(btn) && !btn.closest("#fpq-root"))
          .filter((btn) => !buttonLooksLikeAssetCreate(btn))
          .find(buttonLooksLikeSubmit)
      : null;

    if (promptSubmitButton) {
      return promptSubmitButton;
    }

    const exactGlobalButton = findExactComposerSubmitButton();

    if (exactGlobalButton) {
      return exactGlobalButton;
    }

    const directGlobalButton = findDirectCreateSubmitButton();

    if (directGlobalButton) {
      return directGlobalButton;
    }

    const globalSubmitButton = Array.from(document.querySelectorAll("button"))
      .filter((btn) => buttonIsEnabled(btn) && !buttonIsInDialog(btn))
      .filter((btn) => !btn.closest("#fpq-root"))
      .find((btn) => {
        if (!buttonLooksLikeSubmit(btn)) return false;

        const label = [
          btn.getAttribute("aria-label"),
          btn.getAttribute("title"),
          btn.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (label.includes("create") && !buttonHasSubmitIcon(btn)) {
          return Boolean(btn.closest("form") || btn.closest(".sc-439ac1d3-0"));
        }

        return true;
      });

    const modelButton = Array.from(document.querySelectorAll("button")).find(
      (btn) => {
        if (!isVisible(btn)) return false;

        const text = btn.textContent?.trim().toLowerCase() || "";

        return (
          text.includes("nano") ||
          text.includes("banana") ||
          text.includes("veo")
        );
      },
    );

    if (!modelButton) {
      return globalSubmitButton || null;
    }

    const parent = modelButton.parentElement;

    if (!parent) {
      return globalSubmitButton || null;
    }

    const siblingButtons = Array.from(
      parent.querySelectorAll(":scope > button"),
    );

    const submitButton = siblingButtons.find((btn) => {
      if (btn === modelButton) return false;

      return buttonIsEnabled(btn) && buttonLooksLikeSubmit(btn);
    });

    if (!submitButton) {
      return globalSubmitButton || null;
    }

    return submitButton;
  }

  async function waitForSubmitButton(timeout = 15000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const btn = findSubmitBtn();

      if (
        btn &&
        !btn.disabled &&
        btn.getAttribute("aria-disabled") !== "true"
      ) {
        return btn;
      }

      await sleep(500);
    }

    return null;
  }

  // ─── CLICK SUBMIT ─────────────────────────────────────────────
  async function pressEnterToSubmit() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_PRESS_ENTER",
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Enter submit failed:",
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          resolve(Boolean(response?.ok));
        },
      );
    });
  }

  async function clickSubmit() {
    const btn = await waitForSubmitButton(15000);

    if (!btn) {
      console.warn("[Flow Queue] Submit button not found or still disabled");

      const editor = findEl(SELECTORS.promptInput);

      if (editor) {
        await focusPromptEditor(editor);
      }

      setStatus("warn", "Submit button not found, trying Enter...");

      return pressEnterToSubmit();
    }

    btn.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(300);

    try {
      btn.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          view: window,
          pointerType: "mouse",
        }),
      );
      btn.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      btn.click();
      btn.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
      btn.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );
    } catch (err) {
      console.warn("[Flow Queue] DOM submit click failed:", err);
    }

    await sleep(500);

    const submitIcon = btn.querySelector("i");
    const clickTarget = submitIcon && isVisible(submitIcon) ? submitIcon : btn;
    const rect = clickTarget.getBoundingClientRect();

    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

    const clicked = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "FPQ_CLICK_AT",
          x,
          y,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn(
              "[Flow Queue] Debugger click failed:",
              chrome.runtime.lastError.message,
            );

            resolve(false);
            return;
          }

          if (!response?.ok) {
            console.warn("[Flow Queue] Debugger click failed:", response);
            resolve(false);
            return;
          }

          resolve(true);
        },
      );
    });

    if (!clicked) {
      setStatus("warn", "Real click failed, trying Enter…");

      const pressedEnter = await pressEnterToSubmit();

      if (!pressedEnter) {
        setStatus("err", "Could not submit prompt");
        return false;
      }
    }

    await sleep(400);
    await pressEnterToSubmit();

    await sleep(1200);

    return true;
  }

  // ─── INJECT PROMPT ────────────────────────────────────────────
  async function focusPromptEditor(editor) {
    return focusSlateEditor(editor, "prompt editor");
  }

  async function insertPromptTextIntoEditor(editor, text) {
    await focusPromptEditor(editor);

    const expected = text.slice(0, Math.min(30, text.length));
    const hasText = () =>
      (editor.innerText || editor.textContent || "").trim().includes(expected);

    const inserted = await insertTextWithDebugger(text);

    if (!inserted) {
      return false;
    }

    await sleep(900);

    if (hasText()) return true;

    const submitBtn = await waitForSubmitButton(5000);

    if (!submitBtn) {
      console.warn(
        "[Flow Queue] Prompt text not readable yet; continuing after debugger insert",
      );
    }

    return true;
  }

  async function clearPromptEditor(editor) {
    await focusPromptEditor(editor);

    await clearTextWithDebugger();
    await sleep(500);

    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function uploadReferenceImageForAsset() {
    if (!referenceImage) return null;

    const editor = findEl(SELECTORS.promptInput);

    if (!editor) {
      setStatus("err", "Prompt editor not found");
      return null;
    }

    await clearPromptEditor(editor);

    const file = dataUrlToFile(
      referenceImage.dataUrl,
      referenceImage.name,
      referenceImage.type,
    );

    await focusPromptEditor(editor);
    setStatus("", `Uploading reference image: ${referenceImage.name}`);

    const previousTileIds = getGeneratedTileIds();
    const fileInputs = Array.from(
      document.querySelectorAll("input[type='file']"),
    ).filter((input) => {
      const accept = (input.getAttribute("accept") || "").toLowerCase();
      return !accept || accept.includes("image") || accept.includes("*/*");
    });

    for (const input of fileInputs) {
      try {
        const transfer = new DataTransfer();

        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        await sleep(1800);

        if (
          hasActiveGenerationProgress() ||
          getNewGenerationTiles(previousTileIds).length
        ) {
          return previousTileIds;
        }
      } catch (err) {
        console.warn("[Flow Queue] File input reference upload failed:", err);
      }
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);

    let pasteEvent;

    try {
      pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
    } catch (_) {
      pasteEvent = new Event("paste", {
        bubbles: true,
        cancelable: true,
      });
    }

    if (!pasteEvent.clipboardData) {
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: transfer,
      });
    }

    editor.dispatchEvent(pasteEvent);
    await sleep(1800);

    if (
      hasActiveGenerationProgress() ||
      getNewGenerationTiles(previousTileIds).length
    ) {
      return previousTileIds;
    }

    setStatus("err", "Reference image upload did not start generation");
    return null;
  }

  async function injectPrompt(text) {
    const editor = findEl(SELECTORS.promptInput);

    if (!editor) {
      console.warn("[Flow Queue] Prompt editor not found");
      setStatus("err", "Prompt editor not found");
      return false;
    }

    const expected = text.slice(0, Math.min(30, text.length));

    const getEditorText = () =>
      (editor.innerText || editor.textContent || "").trim();

    const hasPrompt = () => getEditorText().includes(expected);

    if (referenceImage && referenceAssetSearchText) {
      await clearPromptEditor(editor);

      const promptAdded = await insertPromptTextIntoEditor(editor, text);

      if (!promptAdded) {
        setStatus("err", "Prompt was not inserted into the editor");
        return false;
      }

      await sleep(900);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));

      const assetAdded = await addGeneratedAssetToPrompt(
        null,
        referenceAssetSearchText,
      );

      if (!assetAdded) {
        return false;
      }

      return {
        ok: true,
        autoSubmitted: false,
        previousTileIds: null,
      };
    }

    if (referenceImage && !referenceAssetSearchText) {
      setStatus("err", "Reference image asset is not ready yet");
      return false;
    }

    async function focusEditor() {
      return focusSlateEditor(editor, "prompt editor");
    }

    async function clearEditorWithRealKeys() {
      await focusEditor();

      await clearTextWithDebugger();
      await sleep(500);

      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function insertPromptText() {
      return insertPromptTextIntoEditor(editor, text);
    }

    async function pasteReferenceImage() {
      if (!referenceImage) {
        return {
          ok: true,
          autoSubmitted: false,
          previousTileIds: null,
        };
      }

      const file = dataUrlToFile(
        referenceImage.dataUrl,
        referenceImage.name,
        referenceImage.type,
      );

      await focusEditor();
      setStatus("", `Adding reference image: ${referenceImage.name}`);

      const previousTileIds = getGeneratedTileIds();
      const fileInputs = Array.from(
        document.querySelectorAll("input[type='file']"),
      ).filter((input) => {
        const accept = (input.getAttribute("accept") || "").toLowerCase();
        return !accept || accept.includes("image") || accept.includes("*/*");
      });

      for (const input of fileInputs) {
        try {
          const transfer = new DataTransfer();

          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));

          await sleep(1800);

          if (
            hasActiveGenerationProgress() ||
            getNewGenerationTiles(previousTileIds).length
          ) {
            console.warn(
              "[Flow Queue] Reference file input triggered generation",
            );
            setStatus("", "Reference image triggered generation; tracking it");
            return {
              ok: true,
              autoSubmitted: true,
              previousTileIds,
            };
          }

          return {
            ok: true,
            autoSubmitted: false,
            previousTileIds: null,
          };
        } catch (err) {
          console.warn("[Flow Queue] File input reference attach failed:", err);
        }
      }

      const transfer = new DataTransfer();
      transfer.items.add(file);

      let pasteEvent;

      try {
        pasteEvent = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        });
      } catch (_) {
        pasteEvent = new Event("paste", {
          bubbles: true,
          cancelable: true,
        });
      }

      if (!pasteEvent.clipboardData) {
        Object.defineProperty(pasteEvent, "clipboardData", {
          value: transfer,
        });
      }

      editor.dispatchEvent(pasteEvent);
      await sleep(1800);

      if (
        hasActiveGenerationProgress() ||
        getNewGenerationTiles(previousTileIds).length
      ) {
        console.warn("[Flow Queue] Reference image paste triggered generation");
        setStatus("", "Reference image triggered generation; tracking it");
        return {
          ok: true,
          autoSubmitted: true,
          previousTileIds,
        };
      }

      return {
        ok: true,
        autoSubmitted: false,
        previousTileIds: null,
      };
    }

    await clearEditorWithRealKeys();

    const inserted = await insertPromptText();

    if (!inserted) {
      setStatus("err", "Debugger text insertion failed");
      return false;
    }

    await sleep(1200);

    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    await sleep(800);

    const referenceResult = await pasteReferenceImage();

    if (!referenceResult.ok) {
      setStatus("err", "Reference image could not be added");
      return false;
    }

    if (referenceResult.autoSubmitted) {
      console.log("[Flow Queue] Prompt auto-submitted with reference image");
      return referenceResult;
    }

    await focusEditor();
    await sleep(500);

    console.log("[Flow Queue] Prompt accepted:", getEditorText());

    return {
      ok: true,
      autoSubmitted: false,
      previousTileIds: null,
    };
  }

  // ─── WAIT FOR COMPLETION ──────────────────────────────────────
  async function waitForCompletion(previousTileIds) {
    const started = Date.now();

    let sawGenerationStart = false;
    let latestNewTile = null;
    let lastProgressValue = null;
    let stableCompletedChecks = 0;
    let settlingChecks = 0;

    while (Date.now() - started < MAX_WAIT_MS) {
      const newTiles = getNewGenerationTiles(previousTileIds);
      const progressVisible = hasActiveGenerationProgress();
      const progressValue = getLatestProgressValue();

      if (newTiles.length > 0) {
        sawGenerationStart = true;
        latestNewTile = newTiles[newTiles.length - 1];
      }

      if (progressVisible) {
        sawGenerationStart = true;
        stableCompletedChecks = 0;
        settlingChecks = 0;
        lastProgressValue = progressValue;

        setStatus(
          "",
          progressValue !== null
            ? `Generating… ${progressValue}%`
            : "Generating…",
        );

        await sleep(POLL_INTERVAL);
        continue;
      }

      if (latestNewTile && tileHasProgress(latestNewTile)) {
        sawGenerationStart = true;
        stableCompletedChecks = 0;
        settlingChecks = 0;

        const tileProgressText = Array.from(
          latestNewTile.querySelectorAll("div"),
        )
          .map((el) => el.textContent?.trim() || "")
          .find((text) => /^\d{1,3}%$/.test(text));

        setStatus(
          "",
          tileProgressText ? `Generating… ${tileProgressText}` : "Generating…",
        );

        await sleep(POLL_INTERVAL);
        continue;
      }

      if (latestNewTile && tileIsFailed(latestNewTile)) {
        console.warn("[Flow Queue] Generation failed:", {
          tileText: latestNewTile.textContent?.trim(),
        });

        setStatus("err", "Generation failed");

        return {
          status: "failed",
          tile: latestNewTile,
        };
      }

      if (
        sawGenerationStart &&
        latestNewTile &&
        tileLooksCompleted(latestNewTile)
      ) {
        stableCompletedChecks += 1;
        settlingChecks = 0;

        setStatus("", "Generation completed, confirming card is stable…");

        if (stableCompletedChecks >= 2) {
          return {
            status: "done",
            tile: latestNewTile,
          };
        }
      } else if (sawGenerationStart && latestNewTile) {
        settlingChecks += 1;
        stableCompletedChecks = 0;

        if (settlingChecks >= 6 && !tileHasProgress(latestNewTile)) {
          console.warn("[Flow Queue] Treating settled card as complete", {
            tileText: latestNewTile.textContent?.trim() || "",
          });

          return {
            status: "done",
            tile: latestNewTile,
          };
        }

        setStatus(
          "",
          `Generation finishing… waiting for card to settle (${settlingChecks}/6)`,
        );
      }

      await sleep(POLL_INTERVAL);
    }

    console.warn("[Flow Queue] Completion timeout", {
      previousTileIds: Array.from(normalizeIdSet(previousTileIds)),
      currentTileIds: Array.from(getGeneratedTileIds()),
      sawGenerationStart,
      lastProgressValue,
      latestNewTileText: latestNewTile?.textContent?.trim(),
    });

    return {
      status: "timeout",
      tile: latestNewTile,
    };
  }

  // ─── RUN QUEUE ────────────────────────────────────────────────
  async function runQueue() {
    if (running) return;

    const pending = queue.filter((q) => !q.done);

    if (!pending.length) {
      setStatus("warn", "No pending prompts");
      return;
    }

    running = true;
    stopFlag = false;
    titleDot.classList.add("running");
    runBtn.disabled = true;
    delayBetween = parseInt(delayInput.value, 10) || 5;
    downloadFolder = getDownloadFolder();

    let failed = false;
    let failureMessage = "";

    try {
      for (let i = 0; i < queue.length; i++) {
        if (stopFlag) break;

        const item = queue[i];
        const flowPrompt = item.flowText || item.text || "";
        const metaPrompt = item.metaText || "";

        if (item.done) continue;

        item.active = true;
        renderQueue();

        try {
          await activateFlowTab();
          await sleep(500);

          setStatus(
            "ok",
            `Running ${i + 1}/${queue.length}: "${flowPrompt.slice(0, 40)}…"`,
          );

          if (referenceImage && !referenceAssetSearchText) {
            referenceAssetSearchText = await findReferenceImageInAssets();

            if (referenceAssetSearchText) {
              setStatus(
                "",
                `Reference image already in assets: ${referenceAssetSearchText}`,
              );
            }
          }

          if (referenceImage && !referenceAssetSearchText) {
            const referencePreviousTileIds = await uploadReferenceImageForAsset();

            if (!referencePreviousTileIds) {
              throw new Error("Could not upload reference image");
            }

            setStatus("", "Reference image uploading. Waiting for asset...");

            const referenceResult = await waitForCompletion(
              referencePreviousTileIds,
            );

            if (referenceResult.status !== "done") {
              throw new Error(
                referenceResult.status === "failed"
                  ? "Reference image generation failed"
                  : "Reference image generation timed out",
              );
            }

            referenceAssetSearchText = getGeneratedAssetSearchText(
              referenceResult.tile,
            );

            if (!referenceAssetSearchText) {
              throw new Error("Could not identify reference asset");
            }

            setStatus("", `Reference asset ready: ${referenceAssetSearchText}`);
          }

          const injected = await injectPrompt(flowPrompt);

          if (!injected?.ok) {
            throw new Error("Prompt was not accepted by the editor");
          }

          let previousTileIds = injected.previousTileIds;

          if (!injected.autoSubmitted) {
            await sleep(2500);
            previousTileIds = getGeneratedTileIds();

            const submitted = await clickSubmit();

            if (!submitted) {
              throw new Error("Could not find or click the submit button");
            }
          }

          setStatus(
            "",
            injected.autoSubmitted
              ? `Reference image started generation. Waiting… (${i + 1}/${queue.length})`
              : `Submitted. Waiting for generation to finish… (${i + 1}/${queue.length})`,
          );

          let result = await waitForCompletion(previousTileIds);

          if (result.status !== "done") {
            throw new Error(
              result.status === "failed"
                ? `Prompt ${i + 1} failed during generation`
                : `Prompt ${i + 1} timed out`,
            );
          }

          if (injected.autoSubmitted) {
            setStatus(
              "",
              "Reference generation done. Adding generated image to prompt...",
            );

            const assetAdded = await addGeneratedAssetToPrompt(result.tile);

            if (!assetAdded) {
              throw new Error("Could not add generated image to prompt");
            }

            const promptAdded = await addPromptTextToCurrentPrompt(flowPrompt);

            if (!promptAdded) {
              throw new Error("Could not add prompt text after generated image");
            }

            await sleep(1500);
            previousTileIds = getGeneratedTileIds();

            const submitted = await clickSubmit();

            if (!submitted) {
              throw new Error("Could not submit prompt with generated image");
            }

            setStatus(
              "",
              `Submitted with generated image. Waiting... (${i + 1}/${queue.length})`,
            );

            result = await waitForCompletion(previousTileIds);

            if (result.status !== "done") {
              throw new Error(
                result.status === "failed"
                  ? `Prompt ${i + 1} failed during final generation`
                  : `Prompt ${i + 1} timed out during final generation`,
              );
            }
          }

          const baseFilename = makeFilenameFromPrompt(i, flowPrompt);
          const filename = buildDownloadFilename(downloadFolder, baseFilename);
          let metaQueued = false;

          const queueMetaFromGeneratedImage = async () => {
            const imagePayload = await extractTileImagePayload(result.tile);

            if (!imagePayload) {
              return false;
            }

            item.metaStatus = "queued";
            item.metaError = "";
            renderQueue();

            const metaExt = /png/i.test(imagePayload.mimeType)
              ? ".png"
              : /webp/i.test(imagePayload.mimeType)
                ? ".webp"
                : ".jpg";

            const metaEnqueued = await enqueueMetaJob({
              jobId: item.id,
              flowPrompt,
              metaPrompt,
              outputSubfolder: downloadFolder,
              imageName: `${baseFilename}${metaExt}`,
              imageDataUrl: imagePayload.dataUrl,
              imageType: imagePayload.mimeType,
              outName: `${baseFilename}-video.mp4`,
            });

            if (!metaEnqueued) {
              item.metaStatus = "failed";
              item.metaError = "Could not enqueue Meta job";
              renderQueue();
              return false;
            }

            return true;
          };

          try {
            metaQueued = await queueMetaFromGeneratedImage();
          } catch (err) {
            console.warn("[Flow Queue] Could not queue Meta job before download:", err);
          }

          setStatus("", `Generation done. Starting 2K download as ${filename}…`);

          await activateFlowTab();
          await sleep(500);

          const downloaded = await downloadTile(result.tile, filename);

          if (!downloaded) {
            console.warn(
              "[Flow Queue] Download step failed, continuing queue anyway",
            );
            setStatus(
              "warn",
              "Generation done, but download could not be confirmed",
            );
          }

          if (!metaQueued) {
            try {
              setStatus("", "Preparing generated image for Meta...");
              metaQueued = await queueMetaFromGeneratedImage();
            } catch (err) {
              console.warn("[Flow Queue] Could not queue Meta job after download:", err);
            }

            if (!metaQueued) {
              item.metaStatus = "failed";
              item.metaError = "Could not extract generated image for Meta";
              renderQueue();
            }
          }

          item.done = true;
          item.downloadFailed = !downloaded;
        } catch (err) {
          failed = true;
          failureMessage = err?.message || String(err);
          setStatus("err", failureMessage);
          break;
        } finally {
          item.active = false;
          renderQueue();
        }

        if (i < queue.length - 1 && !stopFlag) {
          setStatus(
            "",
            `Download step finished. Waiting ${delayBetween}s before next prompt…`,
          );
          await sleep(delayBetween * 1000);
        }
      }
    } finally {
      running = false;
      runBtn.disabled = false;
      titleDot.classList.remove("running");
    }

    if (stopFlag) {
      setStatus("warn", "Queue stopped by user");
      return;
    }

    if (failed) {
      setStatus("err", failureMessage || "Queue failed");
      return;
    }

    const allDone = queue.every((q) => q.done);
    const dlFailures = queue.filter((q) => q.downloadFailed).length;
    const metaPending = queue.some(
      (q) => q.metaStatus === "queued" || q.metaStatus === "running",
    );

    if (dlFailures > 0) {
      setStatus(
        "warn",
        `Generated all, but ${dlFailures} download(s) could not be confirmed`,
      );
    } else if (metaPending) {
      setStatus("ok", "Flow done. Meta videos are still processing in the background.");
    } else {
      setStatus("ok", allDone ? "✓ All prompts completed!" : "Finished");
    }
  }

  // ─── CONTROLS ─────────────────────────────────────────────────
  runBtn.addEventListener("click", runQueue);

  stopBtn.addEventListener("click", () => {
    if (running) {
      stopFlag = true;
      setStatus("warn", "Stopping after current prompt…");
    }
  });

  clearBtn.addEventListener("click", () => {
    if (running) return;

    queue = [];
    renderQueue();
    setStatus("", "Queue cleared");
  });

  // ─── INIT ─────────────────────────────────────────────────────
  renderQueue();
  registerFlowController();
  setStatus("", "Ready — add prompts and click Run All");
})();
