// Meta AI Animation Queue (MAQ)
// Injected into https://www.meta.ai/*
// Sibling to the Flow Prompt Queue (content.js). Shares background.js CDP handlers.
//
// WORKFLOW (v2):
//   1. Click "Choose project folder" → pick a folder of numbered images
//      (01.jpg, 02.png, 03.jpeg …).
//   2. Paste one animation prompt PER LINE. Prompt line 1 → image 01,
//      line 2 → image 02, and so on (matched by the leading number in the
//      filename, falling back to sorted order).
//   3. Run All. For EACH pair the extension:
//        • starts a fresh Meta AI conversation (isolates the reference image),
//        • attaches that one image (as a real File object — no path needed),
//        • verifies the attachment preview actually appeared,
//        • types the prompt, sends, waits for the new video,
//        • downloads the clean (no-watermark) video as NN.mp4.
//   This guarantees video NN comes from image NN (fixes the cross-contamination
//   bug where one image fed several videos).
(() => {
  "use strict";

  // Avoid double-injection in the same document.
  if (document.__MAQ_LOADED__) return;
  document.__MAQ_LOADED__ = true;

  // ─── STATE ────────────────────────────────────────────────────
  let images = []; // [{ num, name, file }] sorted by num
  let prompts = []; // string[]
  let running = false;
  let stopFlag = false;
  let delayBetween = 8;
  const seenVideoUrls = new Set(); // every video URL we've already handled
  let outputSubfolder = "agua-viva"; // subfolder inside Downloads where videos are saved

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"
    );
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

  chrome.runtime.sendMessage({ type: "MAQ_REGISTER_META_WORKER" }, () => {
    void chrome.runtime.lastError;
  });

  // ─── BACKGROUND (CDP) BRIDGES (typing + send only) ────────────
  function insertTextCDP(text) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "FPQ_INSERT_TEXT", text }, (r) =>
        resolve(Boolean(r?.ok)),
      );
    });
  }
  function pressEnterCDP() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "FPQ_PRESS_ENTER" }, (r) =>
        resolve(Boolean(r?.ok)),
      );
    });
  }

  function activateFlowTab() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MAQ_ACTIVATE_FLOW_TAB" }, (r) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        resolve(Boolean(r?.ok));
      });
    });
  }

  // ─── UI HELPERS ───────────────────────────────────────────────
  const getTextarea = () => document.querySelector("textarea");

  function queryAllDeep(selector, root = document) {
    const matches = [];
    const stack = [root];

    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;

      if (typeof node.querySelectorAll === "function") {
        matches.push(...node.querySelectorAll(selector));
      }

      const children = node.children ? Array.from(node.children) : [];
      for (const child of children) {
        if (child.shadowRoot) {
          stack.push(child.shadowRoot);
        }
        stack.push(child);
      }
    }

    return matches;
  }

  const getFileInput = () =>
    queryAllDeep('input[type="file"]').find((input) => !input.disabled) || null;

  function getSendButton() {
    const labels = ["send", "enviar"];
    return (
      Array.from(document.querySelectorAll("button")).find((b) => {
        const al = (b.getAttribute("aria-label") || "").toLowerCase();
        return labels.includes(al) && isVisible(b);
      }) || null
    );
  }

  function getNewChatButton() {
    return (
      Array.from(document.querySelectorAll("a,button")).find((e) =>
        /nova conversa|new chat|new conversation/i.test(
          (e.textContent || "") + (e.getAttribute("aria-label") || ""),
        ),
      ) || null
    );
  }

  function getAttachButton() {
    const nodes = queryAllDeep("button,[role='button'],label");
    return (
      nodes.find((el) => {
        if (!isVisible(el)) return false;

        const text = ((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""))
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

        if (!text) return false;

        return /attach|anex|upload|image|imagem|photo|foto|media|file|arquivo/.test(
          text,
        );
      }) || null
    );
  }

  async function ensureFileInputReady(timeout = 8000) {
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const input = getFileInput();
      if (input) return input;

      const attachButton = getAttachButton();
      if (attachButton) {
        await clickViaEvents(attachButton);
        await sleep(500);
      } else {
        await sleep(300);
      }
    }

    return null;
  }

  // Attach image via CDP DOM.setFileInputFiles — works with disk paths,
  // no File object or user gesture needed.
  function attachFileViaCDP(path) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "FPQ_SET_FILE_INPUT", selector: 'input[type="file"]', files: [path] },
        (r) => resolve(Boolean(r?.ok)),
      );
    });
  }

  // Attach a File object directly to the page's file input via DataTransfer.
  async function attachFileObject(file) {
    const input = await ensureFileInputReady();
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Wait until an image attachment preview shows in the composer (proves the
  // image was accepted before we send the prompt).
  async function waitForAttachmentPreview(timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const blobImg = queryAllDeep("img").some(
        (i) =>
          (i.src || "").startsWith("blob:") ||
          /attach|anexada|preview/i.test(i.getAttribute("alt") || ""),
      );
      const removeBtn = queryAllDeep("button,[role='button']").some(
        (b) =>
          /remove|remover|delete|excluir/i.test(
            (b.getAttribute("aria-label") || "") + " " + (b.textContent || ""),
          ),
      );
      if (blobImg || removeBtn) return true;
      await sleep(400);
    }
    return false;
  }

  // Wait for a video whose source URL has NOT been seen/downloaded before.
  // Relying on a fresh source URL (not on the <video> count) prevents
  // re-grabbing a leftover video from a previous pair.
  async function waitForFreshVideo(seenUrls, timeout = 240000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (stopFlag) return { status: "stopped" };
      const fresh = Array.from(document.querySelectorAll("video"))
        .map((v) => ({ v, url: v.currentSrc || v.src }))
        .filter(({ url }) => url && !seenUrls.has(url));
      if (fresh.length) {
        const pick = fresh[fresh.length - 1];
        return { status: "done", video: pick.v, url: pick.url };
      }
      await sleep(2000);
    }
    return { status: "timeout" };
  }

  async function startNewConversation() {
    const nc = getNewChatButton();
    if (nc) {
      nc.click();
      await sleep(2800);
    }
    // Wait for the composer of the fresh conversation.
    const started = Date.now();
    while (Date.now() - started < 8000) {
      if (getTextarea() && document.querySelectorAll("video").length === 0)
        return true;
      await sleep(400);
    }
    return Boolean(getTextarea());
  }

  // Download via background.js chrome.downloads so we can specify the subfolder.
  function downloadViaBackground(url, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "MAQ_DOWNLOAD_VIDEO", url, filename },
        (r) => resolve(Boolean(r?.ok)),
      );
    });
  }

  // Download the clean (no-watermark) video straight from the player URL.
  // Fetches blob first so the filename is always exactly what we specify.
  async function downloadClean(video, filename) {
    try {
      const url = video.currentSrc || video.src;
      if (!url) return false;

      // Fetch bytes — works for both blob: and https: URLs.
      const resp = await fetch(url);
      if (!resp.ok) return false;
      const blob = await resp.blob();
      if (!blob.size) return false;

      // Trigger download with exact filename — no garbage from URL params.
      const localUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = localUrl;
      a.download = `${outputSubfolder}/${filename}`;
      document.body.appendChild(a);
      a.click();
      await sleep(800);
      URL.revokeObjectURL(localUrl);
      a.remove();
      return true;
    } catch (err) {
      console.warn("[MAQ] downloadClean fetch failed, trying background:", err);
      // Fallback via chrome.downloads
      return await downloadViaBackground(
        video.currentSrc || video.src,
        `${outputSubfolder}/${filename}`,
      );
    }
  }

  // ─── RUN ONE PAIR (image NN + prompt N) ───────────────────────
  async function runPair(image, prompt, outName, options = {}) {
    if (!options.allowHidden && document.visibilityState !== "visible") {
      setStatus("warn", "Bring the Meta AI tab to the foreground, then retry");
      return false;
    }

    // 1) Fresh conversation → isolates this reference image.
    setStatus("", `[${outName}] new conversation…`);
    await startNewConversation();
    if (stopFlag) return false;

    // 2) Attach the exact image via CDP (disk path → no user gesture needed).
    setStatus("", `[${outName}] attaching ${image.name}…`);
    const filePath = AGUA_VIVA_FILES.find((p) => p.endsWith(image.name));
    let attached = false;
    if (filePath) {
      // CDP DOM.setFileInputFiles — the most reliable path
      const cdpOk = await attachFileViaCDP(filePath);
      if (cdpOk) attached = await waitForAttachmentPreview();
    }
    if (!attached) {
      // Fallback: DataTransfer File object
      if (!(await attachFileObject(image.file))) {
        setStatus("warn", "File input not found");
        return false;
      }
      attached = await waitForAttachmentPreview();
    }
    if (!attached) {
      setStatus("warn", `[${outName}] attachment did not register`);
      return false;
    }
    await sleep(1200);

    // 3) Type the prompt (CDP keystrokes — React-safe).
    setStatus("", `[${outName}] writing prompt…`);
    const ta = getTextarea();
    if (!ta) {
      setStatus("warn", "Prompt textarea not found");
      return false;
    }
    ta.focus();
    ta.click();
    await sleep(400);
    const fullPrompt = `Animate this image into a short video: ${prompt}`;
    await insertTextCDP(fullPrompt);
    await sleep(800);

    // 4) Send via Enter (CDP) — immune to zoom/DPR.
    setStatus("", `[${outName}] sending…`);
    let send = getSendButton();
    const t0 = Date.now();
    while ((!send || send.disabled) && Date.now() - t0 < 6000) {
      await sleep(400);
      send = getSendButton();
    }
    ta.focus();
    ta.click();
    await sleep(200);
    await pressEnterCDP();
    await sleep(1500);
    if (ta.value && ta.value.trim()) {
      // Enter didn't submit — fall back to clicking Send.
      const s = getSendButton();
      if (s && !s.disabled) await clickViaEvents(s);
      await sleep(1200);
    }

    if (options.jobId) {
      chrome.runtime.sendMessage(
        {
          type: "MAQ_META_JOB_STARTED",
          jobId: options.jobId,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }

    await sleep(300);
    await activateFlowTab();

    // 5) Wait for a FRESH video (new source URL, not any previously seen).
    setStatus("", `[${outName}] waiting for animation…`);
    // Mark everything currently on screen as already-seen, so only a brand
    // new generation counts.
    Array.from(document.querySelectorAll("video")).forEach((v) => {
      const u = v.currentSrc || v.src;
      if (u) seenVideoUrls.add(u);
    });
    const result = await waitForFreshVideo(seenVideoUrls);
    if (result.status === "stopped") return false;
    if (result.status !== "done") {
      setStatus("warn", `[${outName}] animation timed out`);
      return false;
    }

    if (options.jobId) {
      chrome.runtime.sendMessage(
        {
          type: "MAQ_META_JOB_VIDEO_STARTED",
          jobId: options.jobId,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    }

    seenVideoUrls.add(result.url); // never reuse this one

    // 6) Download clean video as NN.mp4.
    await sleep(1000);
    setStatus("", `[${outName}] downloading…`);
    const ok = await downloadClean(result.video, outName);
    const restoreFlowFocus = async () => {
      await sleep(300);
      await activateFlowTab();
    };
    if (ok) {
      await restoreFlowFocus();
      setStatus("ok", `✓ ${outName}`);
      return true;
    }
    await restoreFlowFocus();
    setStatus("warn", `[${outName}] download failed`);
    return false;
  }

  async function processIncomingMetaJob(job) {
    if (job.outputSubfolder) {
      outputSubfolder = job.outputSubfolder;
    }

    const imageName = job.imageName || `flow-image-${job.jobId || "job"}.png`;
    const image = {
      name: imageName,
      file: dataUrlToFile(job.imageDataUrl, imageName, job.imageType),
    };
    const prompt = job.metaPrompt || job.prompt || "";
    const outName = job.outName || `${imageName.replace(/\.[^.]+$/, "")}-video.mp4`;
    let ok = false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      ok = await runPair(image, prompt, outName, {
        allowHidden: true,
        jobId: job.jobId,
      });

      if (ok) break;

      if (attempt < 2 && !stopFlag) {
        setStatus("", `[${outName}] retrying Meta AI job...`);
        await sleep(2000);
      }
    }

    chrome.runtime.sendMessage(
      {
        type: ok ? "MAQ_META_JOB_DONE" : "MAQ_META_JOB_FAILED",
        jobId: job.jobId,
        error: ok ? undefined : `Meta job failed for ${outName}`,
      },
      () => {
        void chrome.runtime.lastError;
      },
    );

    return ok;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "MAQ_RUN_META_JOB") {
      return;
    }

    (async () => {
      try {
        sendResponse({ ok: true });
        await processIncomingMetaJob(message.job || {});
      } catch (err) {
        chrome.runtime.sendMessage(
          {
            type: "MAQ_META_JOB_FAILED",
            jobId: message.job?.jobId,
            error: err?.message || String(err),
          },
          () => {
            void chrome.runtime.lastError;
          },
        );
      }
    })();

    return true;
  });

  async function clickViaEvents(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2,
      y = r.top + r.height / 2;
    for (const ev of [
      "pointerover",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ]) {
      const C = ev.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(
        new C(ev, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    }
  }

  // ─── RUN ALL ──────────────────────────────────────────────────
  async function runAll() {
    if (running) return;
    if (!images.length) {
      setStatus("warn", "Choose a project folder first");
      return;
    }
    if (!prompts.length) {
      setStatus("warn", "Paste one prompt per line");
      return;
    }
    const n = Math.min(images.length, prompts.length);
    if (images.length !== prompts.length) {
      setStatus(
        "warn",
        `${images.length} images vs ${prompts.length} prompts — running ${n} pairs`,
      );
      await sleep(1500);
    }

    running = true;
    stopFlag = false;
    runBtn.disabled = true;
    titleDot.classList.add("running");

    let done = 0,
      failed = 0;
    for (let i = 0; i < n; i++) {
      if (stopFlag) break;
      const image = images[i];
      const prompt = prompts[i];
      // e.g. "01-hook.jpg" → "01-hook-video.mp4"
      const outName = image.name.replace(/\.[^.]+$/, "") + "-video.mp4";
      renderState(i);
      setStatus("", `Pair ${i + 1}/${n} → ${outName}`);
      const ok = await runPair(image, prompt, outName);
      ok ? done++ : failed++;
      results[i] = ok ? "✓" : "✗";
      renderState(i);
      if (i < n - 1 && !stopFlag) {
        setStatus("", `Waiting ${delayBetween}s…`);
        await sleep(delayBetween * 1000);
      }
    }

    running = false;
    runBtn.disabled = false;
    titleDot.classList.remove("running");
    if (stopFlag) setStatus("warn", `Stopped — ${done} done, ${failed} failed`);
    else if (failed)
      setStatus("warn", `Done: ${done} ok, ${failed} failed`);
    else setStatus("ok", `✓ All ${done} animations completed!`);
  }

  // ─── PANEL ────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "fpq-root";
  root.innerHTML = `
    <div id="fpq-header">
      <div id="fpq-title">
        <div id="fpq-title-dot"></div>
        <span>Meta AI Queue</span>
      </div>
      <button id="fpq-collapse" class="fpq-icon-btn" title="Collapse">▲</button>
    </div>
    <div id="fpq-body">
      <div id="fpq-input-area">
        <div id="fpq-folder-row">
          <button id="maq-folder-btn" type="button" class="fpq-ctrl-btn" style="flex:1;padding:7px 10px;background:rgba(124,109,250,0.12);color:var(--fpq-accent);border:1px solid rgba(124,109,250,0.3);">📁 Choose folder…</button>
          <span id="maq-folder-info" style="font-family:var(--fpq-font-mono);font-size:10.5px;color:var(--fpq-muted);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">no folder</span>
          <input id="maq-folder-input" type="file" webkitdirectory directory multiple style="display:none" />
        </div>
        <textarea id="fpq-textarea" placeholder="Paste prompt blocks separated by blank lines — block 1 → image 01, block 2 → image 02…" rows="5"></textarea>
        <button id="maq-load-prompts-btn" type="button" class="fpq-ctrl-btn" style="background:rgba(250,109,194,0.12);color:var(--fpq-accent2);border:1px solid rgba(250,109,194,0.25);">⚡ Load prompts</button>
        <input id="maq-prompts-input" type="file" accept=".txt,.md,text/plain" style="display:none" />
        <div id="fpq-add-row">
          <span id="fpq-delay-label">delay (s)</span>
          <input id="fpq-delay-input" type="number" min="1" max="300" value="8" />
        </div>
      </div>
      <div id="fpq-progress-bar-wrap"><div id="fpq-progress-bar"></div></div>
      <div id="fpq-queue-area"><div id="fpq-queue-empty">Choose a folder + load prompts</div></div>
      <div id="fpq-controls">
        <button id="maq-run-btn" class="fpq-ctrl-btn" type="button">▶ Run All</button>
        <button id="maq-stop-btn" class="fpq-ctrl-btn" type="button">■ Stop</button>
        <button id="maq-clear-btn" class="fpq-ctrl-btn" type="button">Clear</button>
      </div>
      <div id="fpq-status-bar">Ready</div>
    </div>`;
  document.documentElement.style.setProperty("--fpq-dock-width", "360px");
  document.documentElement.classList.add("fpq-docked");
  document.body.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const titleDot = $("fpq-title-dot");
  const runBtn = $("maq-run-btn");
  // Apply run button gradient style (same as Flow panel's #fpq-run-btn)
  runBtn.style.cssText = "background:linear-gradient(135deg,#7c6dfa,#fa6dc2);color:#fff;";
  const statusBar = $("fpq-status-bar");
  const queueArea = $("fpq-queue-area");
  const textarea = $("fpq-textarea");
  const delayInput = $("fpq-delay-input");
  const promptsInput = $("maq-prompts-input");
  let results = [];

  function setStatus(kind, msg) {
    statusBar.textContent = msg;
    statusBar.className = kind || "";
    console.log(`[MAQ] ${msg}`);
  }

  // Extract leading number from a filename ("03-sumiram.jpg" → 3).
  function numFromName(name) {
    const m = String(name).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function splitPromptBlocks(raw) {
    return String(raw || "")
      .trim()
      .split(/\n\s*\n+/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  function readPrompts() {
    prompts = splitPromptBlocks(textarea.value);
    delayBetween = parseInt($("fpq-delay-input").value, 10) || 8;
  }

  function renderState(activeIdx = -1) {
    readPrompts();
    const n = Math.max(images.length, prompts.length);
    if (!n) {
      queueArea.innerHTML =
        '<div id="fpq-queue-empty">Choose a folder + load prompts</div>';
      return;
    }
    queueArea.innerHTML = "";
    // Progress bar
    const done = results.filter(Boolean).length;
    $("fpq-progress-bar").style.width = n ? `${(done / n) * 100}%` : "0%";

    for (let i = 0; i < n; i++) {
      const img = images[i];
      const pr = prompts[i];
      const row = document.createElement("div");
      row.className = "fpq-item" +
        (i === activeIdx ? " fpq-active" : "") +
        (results[i] === "✓" ? " fpq-done" : "");
      const mark = results[i] || (i === activeIdx ? "⟳" : img && pr ? "" : "⚠");
      const label = img ? img.name : "(no image)";
      const ptxt = pr ? pr.slice(0, 38) : "(no prompt)";
      row.innerHTML = `
        <span class="fpq-item-index">${String(img?.num ?? i + 1).padStart(2, "0")}</span>
        <span class="fpq-item-text">${label}<br><span style="opacity:.55;font-size:10px">${ptxt}</span></span>
        <span class="fpq-item-status">${mark}</span>`;
      queueArea.appendChild(row);
    }
  }

  // ─── CONTROLS ─────────────────────────────────────────────────
  $("maq-folder-btn").addEventListener("click", () => $("maq-folder-input").click());

  $("maq-prompts-input").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];

    if (!file) return;

    try {
      const text = await file.text();
      textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      setStatus("", `Loaded prompts from ${file.name}`);
    } catch (err) {
      setStatus("warn", `Could not read prompt file: ${err?.message || err}`);
    } finally {
      e.target.value = "";
    }
  });

  $("maq-folder-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      /\.(jpe?g|png|webp|gif)$/i.test(f.name),
    );
    images = files
      .map((f) => ({ num: numFromName(f.name), name: f.name, file: f }))
      .sort((a, b) => {
        if (a.num != null && b.num != null) return a.num - b.num;
        return a.name.localeCompare(b.name);
      });
    results = [];
    const folder = files[0]?.webkitRelativePath?.split("/")[0] || "folder";
    outputSubfolder = folder;
    $("maq-folder-info").textContent = `${folder} — ${images.length} images`;
    setStatus("", `✓ ${images.length} images — videos → Downloads/${outputSubfolder}/`);
    renderState();
  });

  textarea.addEventListener("input", () => renderState());

  runBtn.addEventListener("click", runAll);
  $("maq-stop-btn").addEventListener("click", () => {
    if (running) {
      stopFlag = true;
      setStatus("warn", "Stopping after current pair…");
    }
  });
  $("maq-clear-btn").addEventListener("click", () => {
    if (running) return;
    images = [];
    prompts = [];
    results = [];
    textarea.value = "";
    $("maq-folder-info").textContent = "no folder";
    renderState();
    setStatus("", "Cleared");
  });
  $("fpq-collapse").addEventListener("click", () => {
    root.classList.toggle("fpq-collapsed");
  });

  // ─── STOP BTN style (matches panel.css #fpq-stop-btn) ────────
  $("maq-stop-btn").style.cssText =
    "background:rgba(255,92,110,0.12);color:#ff5c6e;border:1px solid rgba(255,92,110,0.25);";
  $("maq-clear-btn").style.cssText =
    "background:var(--fpq-surface,#16161c);color:var(--fpq-muted,#5a5a72);border:1px solid var(--fpq-border,#2a2a38);";

  // Auto-load images from the agua-viva folder via CDP (no picker needed)
  const AGUA_VIVA_FILES = [
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\01-hook.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\01-hook-alt.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\02-aquario.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\03-sumiram.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\03-cientista.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\04-reset.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\05-celulas.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\05-bolinha.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\06-borboleta.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\07-ciclo.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\08-idade.jpg",
    "C:\\00Claude\\remotion-app\\public\\agua-viva\\09-close.jpg",
  ];

  function readFileFromDisk(path) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "MAQ_READ_FILE", path }, (r) => {
        if (!r?.ok) { resolve(null); return; }
        const binary = atob(r.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: r.type || "image/jpeg" });
        const name = path.split("\\").pop();
        resolve(new File([blob], name, { type: r.type || "image/jpeg" }));
      });
    });
  }

  async function autoLoadImages() {
    setStatus("", "Loading água-viva images…");
    const loaded = [];
    for (const path of AGUA_VIVA_FILES) {
      const file = await readFileFromDisk(path);
      if (file) {
        loaded.push({ num: numFromName(file.name), name: file.name, file });
      } else {
        setStatus("warn", `Could not read: ${path.split("\\").pop()}`);
      }
    }
    loaded.sort((a, b) => {
      if (a.num != null && b.num != null) return a.num - b.num;
      return a.name.localeCompare(b.name);
    });
    images = loaded;
    results = [];
    outputSubfolder = "agua-viva";
    $("maq-folder-info").textContent = `agua-viva — ${images.length} images (auto)`;
    if (images.length === 0) {
      setStatus("warn", "No images loaded — check file paths and extension file access");
      return;
    }
    setStatus("", `✓ ${images.length} images ready — starting automatically…`);
    renderState();
    await sleep(1000);
    runAll();
  }


  // ─── INIT ─────────────────────────────────────────────────────
  renderState();
  setStatus("", "Ready — choose folder + Run All");
  console.log("[MAQ] Meta AI Animation Queue v2 loaded");
})();
