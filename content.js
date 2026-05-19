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

  // ─── STATE ────────────────────────────────────────────────────
  let queue = [];
  let running = false;
  let stopFlag = false;
  let delayBetween = 5;
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
        <textarea id="fpq-textarea" placeholder="Type a prompt… one prompt per line" rows="3"></textarea>
        <div id="fpq-add-row">
          <span id="fpq-delay-label">delay after completion (s)</span>
          <input id="fpq-delay-input" type="number" min="1" max="300" value="5" />
          <button id="fpq-add-btn">+ Add to Queue</button>
        </div>
      </div>

      <div id="fpq-progress-bar-wrap"><div id="fpq-progress-bar"></div></div>

      <div id="fpq-queue-area">
        <div id="fpq-queue-empty">Queue is empty — add prompts above</div>
      </div>

      <div id="fpq-controls">
        <button class="fpq-ctrl-btn" id="fpq-run-btn">▶ Run All</button>
        <button class="fpq-ctrl-btn" id="fpq-stop-btn">■ Stop</button>
        <button class="fpq-ctrl-btn" id="fpq-clear-btn">Clear</button>
      </div>

      <div id="fpq-status-bar">Ready</div>
    </div>
  `;
  document.body.appendChild(root);

  // ─── ELEMENT REFS ─────────────────────────────────────────────
  const $ = (id) => root.querySelector("#" + id);

  const textarea = $("fpq-textarea");
  const delayInput = $("fpq-delay-input");
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
    const root = getGenerationRoot();

    return new Set(
      Array.from(root.querySelectorAll("[data-tile-id]"))
        .map((el) => el.getAttribute("data-tile-id"))
        .filter(Boolean),
    );
  }

  function getGenerationTiles() {
    const root = getGenerationRoot();

    return Array.from(root.querySelectorAll("[data-tile-id]")).filter(
      isVisible,
    );
  }

  function getNewGenerationTiles(previousTileIds) {
    const safePreviousIds = normalizeIdSet(previousTileIds);

    return getGenerationTiles().filter((tile) => {
      const id = tile.getAttribute("data-tile-id");
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
      return /^\d{1,3}%$/.test(text) && isVisible(el);
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

  async function moveMouseToElement(el, label = "element") {
    if (!el || !isVisible(el)) return false;

    const rect = el.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);

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

  function findTileMoreButton(tile) {
    if (!tile) return null;

    const candidates = Array.from(
      tile.querySelectorAll("button, [role='button']"),
    );

    const byIcon = candidates.find((btn) => {
      const iconText = btn.querySelector("i")?.textContent?.trim();

      return (
        iconText === "more_vert" ||
        iconText === "more_horiz" ||
        iconText === "more"
      );
    });

    if (byIcon) return byIcon;

    const byLabel = candidates.find((btn) => {
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
        label.includes("menu")
      );
    });

    if (byLabel) return byLabel;

    /**
     * Last-resort fallback:
     * after hover, the more button is often one of the last visible buttons
     * inside the completed card.
     */
    const visibleButtons = candidates.filter(isVisible);

    return visibleButtons[visibleButtons.length - 1] || null;
  }

  async function waitForMenuOpen(timeout = 5000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find(
        isVisible,
      );

      if (menu) return menu;

      await sleep(250);
    }

    return null;
  }

  async function clickDownloadMenuItem() {
    const menuItems = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).filter(isVisible);

    const downloadItem = menuItems.find((item) => {
      const text = getVisibleText(item).toLowerCase();

      const hasDownloadIcon = Array.from(item.querySelectorAll("i")).some(
        (icon) => icon.textContent?.trim() === "download",
      );

      const hasSubmenu = item.getAttribute("aria-haspopup") === "menu";

      return hasDownloadIcon && hasSubmenu && text.includes("download");
    });

    if (!downloadItem) {
      console.warn("[Flow Queue] Download menu item not found");
      return false;
    }

    downloadItem.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );

    downloadItem.dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );

    await sleep(400);

    return realClickElement(downloadItem, "Download menu item");
  }

  async function clickDownloadSubmenuOption() {
    const started = Date.now();
    const timeout = 7000;

    while (Date.now() - started < timeout) {
      const menuItems = Array.from(
        document.querySelectorAll('[role="menuitem"]'),
      ).filter(isVisible);

      const twoKItem = menuItems.find((item) => {
        const text = getVisibleText(item).toLowerCase();
        const ariaDisabled = item.getAttribute("aria-disabled") === "true";

        return (
          !ariaDisabled && text.includes("2k") && text.includes("upscaled")
        );
      });

      if (twoKItem) {
        return realClickElement(twoKItem, "2K download option");
      }

      await sleep(250);
    }

    console.warn("[Flow Queue] 2K download option not found");
    return false;
  }

  async function downloadTile(tile) {
    if (!tile || !isVisible(tile)) {
      console.warn("[Flow Queue] Cannot download: completed tile not found");
      return false;
    }

    setStatus("", "Hovering completed card…");

    await hoverElement(tile, "completed tile");

    /**
     * Real mouse move helps because Flow only reveals the card controls
     * when the actual pointer is over the card, not just synthetic hover events.
     */
    await moveMouseToElement(tile, "completed tile");

    await sleep(1500);

    setStatus("", "Opening card menu to download…");

    let moreButton = findTileMoreButton(tile);

    if (!moreButton) {
      console.warn("[Flow Queue] More/options button not found after hover", {
        tileText: tile.textContent?.trim(),
        buttons: Array.from(
          tile.querySelectorAll("button, [role='button']"),
        ).map((btn) => ({
          text: btn.textContent?.trim(),
          ariaLabel: btn.getAttribute("aria-label"),
          title: btn.getAttribute("title"),
          visible: isVisible(btn),
          icon: btn.querySelector("i")?.textContent?.trim(),
        })),
      });

      setStatus("warn", "Could not find card menu button after hover");
      return false;
    }

    /**
     * Hover the button itself too, because some menus/buttons only become
     * clickable after the pointer enters the control area.
     */
    await hoverElement(moreButton, "more/options button");
    await moveMouseToElement(moreButton, "more/options button");

    const opened = await realClickElement(
      moreButton,
      "tile more/options button",
    );

    if (!opened) {
      setStatus("warn", "Could not open card menu");
      return false;
    }

    const menu = await waitForMenuOpen();

    if (!menu) {
      setStatus("warn", "Card menu did not open");
      return false;
    }

    setStatus("", "Opening Download submenu…");

    const clickedDownload = await clickDownloadMenuItem();

    if (!clickedDownload) {
      setStatus("warn", "Could not click Download");
      return false;
    }

    await sleep(800);

    setStatus("", "Selecting 2K download option…");

    const clicked2K = await clickDownloadSubmenuOption();

    if (!clicked2K) {
      setStatus("warn", "Could not select 2K download option");
      return false;
    }

    setStatus("ok", "2K download triggered");

    await sleep(2000);

    return true;
  }

  // ─── DRAGGING ─────────────────────────────────────────────────
  let dragging = false;
  let dragOffX = 0;
  let dragOffY = 0;

  $("fpq-header").addEventListener("mousedown", (e) => {
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

    collapseBtn.textContent = root.classList.contains("fpq-collapsed")
      ? "▼"
      : "▲";
  });

  closeBtn.addEventListener("click", () => {
    root.remove();
  });

  // ─── ADD PROMPTS ──────────────────────────────────────────────
  function addPrompts() {
    const raw = textarea.value.trim();

    if (!raw) return;

    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    lines.forEach((text) => {
      queue.push({
        text,
        done: false,
        active: false,
        id: ++idCounter,
      });
    });

    textarea.value = "";
    delayBetween = parseInt(delayInput.value, 10) || 5;

    renderQueue();
    setStatus("", `${lines.length} prompt(s) added`);
  }

  addBtn.addEventListener("click", addPrompts);

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      addPrompts();
    }
  });

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

      const statusIcon = item.done ? "✓" : item.active ? "⟳" : "·";

      el.innerHTML = `
        <span class="fpq-item-index">${i + 1}</span>
        <span class="fpq-item-text">${escHtml(item.text)}</span>
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
  function findSubmitBtn() {
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
      console.warn("[Flow Queue] Model selector button not found");
      return null;
    }

    const parent = modelButton.parentElement;

    if (!parent) {
      console.warn("[Flow Queue] Model selector parent not found");
      return null;
    }

    const siblingButtons = Array.from(
      parent.querySelectorAll(":scope > button"),
    );

    const submitButton = siblingButtons.find((btn) => {
      if (btn === modelButton) return false;
      if (!isVisible(btn)) return false;
      if (btn.disabled) return false;
      if (btn.getAttribute("aria-disabled") === "true") return false;

      const iconText = btn.querySelector("i")?.textContent?.trim();

      return iconText === "arrow_forward";
    });

    if (!submitButton) {
      console.warn("[Flow Queue] Submit button not found near model selector");
      return null;
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

      await sleep(300);
    }

    return null;
  }

  // ─── CLICK SUBMIT ─────────────────────────────────────────────
  async function clickSubmit() {
    const btn = await waitForSubmitButton(15000);

    if (!btn) {
      console.warn("[Flow Queue] Submit button not found or still disabled");
      setStatus("err", "Submit button not found or disabled");
      return false;
    }

    btn.scrollIntoView({
      block: "center",
      inline: "center",
    });

    await sleep(700);

    const rect = btn.getBoundingClientRect();

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

      const pressedEnter = await new Promise((resolve) => {
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

      if (!pressedEnter) {
        setStatus("err", "Could not submit prompt");
        return false;
      }
    }

    await sleep(1200);

    return true;
  }

  // ─── INJECT PROMPT ────────────────────────────────────────────
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

    async function focusEditor() {
      editor.scrollIntoView({
        block: "center",
        inline: "center",
      });

      await sleep(300);

      editor.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );

      editor.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window,
        }),
      );

      editor.focus();
      editor.click();

      await sleep(500);
    }

    async function clearEditorWithRealKeys() {
      await focusEditor();

      document.execCommand("selectAll", false, null);
      await sleep(200);

      document.execCommand("delete", false, null);
      await sleep(500);

      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function insertTextWithDebugger() {
      await focusEditor();

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

    await clearEditorWithRealKeys();

    const inserted = await insertTextWithDebugger();

    if (!inserted) {
      setStatus("err", "Debugger text insertion failed");
      return false;
    }

    await sleep(1200);

    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    await sleep(800);

    if (!hasPrompt()) {
      console.warn(
        "[Flow Queue] Editor text after debugger insert:",
        getEditorText(),
      );
      setStatus("err", "Prompt was not inserted into the editor");
      return false;
    }

    const submitBtn = await waitForSubmitButton(7000);

    if (!submitBtn) {
      setStatus("err", "Prompt inserted, but submit button did not enable");
      return false;
    }

    console.log("[Flow Queue] Prompt accepted:", getEditorText());

    return true;
  }

  // ─── WAIT FOR COMPLETION ──────────────────────────────────────
  async function waitForCompletion(previousTileIds) {
    const started = Date.now();

    let sawGenerationStart = false;
    let latestNewTile = null;
    let lastProgressValue = null;
    let stableCompletedChecks = 0;

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

        setStatus("", "Generation completed, confirming card is stable…");

        if (stableCompletedChecks >= 2) {
          return {
            status: "done",
            tile: latestNewTile,
          };
        }
      } else if (sawGenerationStart && latestNewTile) {
        stableCompletedChecks = 0;
        setStatus("", "Generation finishing… waiting for card to settle");
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

    let failed = false;
    let failureMessage = "";

    for (let i = 0; i < queue.length; i++) {
      if (stopFlag) break;

      const item = queue[i];

      if (item.done) continue;

      item.active = true;
      renderQueue();

      setStatus(
        "ok",
        `Running ${i + 1}/${queue.length}: "${item.text.slice(0, 40)}…"`,
      );

      const injected = await injectPrompt(item.text);

      if (!injected) {
        failed = true;
        failureMessage = "Prompt was not accepted by the editor";
        setStatus("err", failureMessage);
        item.active = false;
        renderQueue();
        break;
      }

      await sleep(2500);

      const previousTileIds = getGeneratedTileIds();

      const submitted = await clickSubmit();

      if (!submitted) {
        failed = true;
        failureMessage = "Could not find or click the submit button";
        setStatus("err", failureMessage);
        item.active = false;
        renderQueue();
        break;
      }

      setStatus(
        "",
        `Submitted. Waiting for generation to finish… (${i + 1}/${queue.length})`,
      );

      const result = await waitForCompletion(previousTileIds);

      if (result.status !== "done") {
        failed = true;

        failureMessage =
          result.status === "failed"
            ? `Prompt ${i + 1} failed during generation`
            : `Prompt ${i + 1} timed out`;

        setStatus(result.status === "failed" ? "err" : "warn", failureMessage);

        item.active = false;
        renderQueue();
        break;
      }

      setStatus("", "Generation done. Starting 2K download…");

      const downloaded = await downloadTile(result.tile);

      if (!downloaded) {
        console.warn(
          "[Flow Queue] Download step failed, continuing queue anyway",
        );
        setStatus(
          "warn",
          "Generation done, but download could not be confirmed",
        );
      }

      item.done = true;
      item.active = false;
      renderQueue();

      if (i < queue.length - 1 && !stopFlag) {
        setStatus(
          "",
          `Download step finished. Waiting ${delayBetween}s before next prompt…`,
        );
        await sleep(delayBetween * 1000);
      }
    }

    running = false;
    runBtn.disabled = false;
    titleDot.classList.remove("running");

    if (stopFlag) {
      setStatus("warn", "Queue stopped by user");
      return;
    }

    if (failed) {
      setStatus("err", failureMessage || "Queue failed");
      return;
    }

    const allDone = queue.every((q) => q.done);
    setStatus("ok", allDone ? "✓ All prompts completed!" : "Finished");
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
  setStatus("", "Ready — add prompts and click Run All");
})();
