const MODEL_ID = "black-forest-labs/FLUX.2-klein-4B";
const DEFAULT_TIMEOUT_SECONDS = 180;

const promptEl = document.querySelector("#prompt");
const generateEl = document.querySelector("#generate");
const generateLabelEl = document.querySelector("#generate-label");
const generateAsideEl = document.querySelector("#generate-aside");
const shortcutHintEl = document.querySelector("#shortcut-hint");
const errorEl = document.querySelector("#error");
const stepsEl = document.querySelector("#steps");
const seedEl = document.querySelector("#seed");
const statusEl = document.querySelector("#status");
const statusLabelEl = document.querySelector("#status-label");
const statusDetailEl = document.querySelector("#status-detail");
const frameEl = document.querySelector("#frame");
const emptyCopyEl = document.querySelector("#empty-copy");
const exposingEl = document.querySelector("#exposing");
const elapsedEl = document.querySelector("#elapsed");
const printEl = document.querySelector("#print");
const printMetaEl = document.querySelector("#print-meta");
const printActionsEl = document.querySelector("#print-actions");
const downloadCurrentEl = document.querySelector("#download-current");
const stripEl = document.querySelector("#strip");
const galleryCountEl = document.querySelector("#gallery-count");

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = isMac ? "⌘↩" : "Ctrl+Enter";
const gallery = [];
let busy = false;
let timer = null;
let selectedId = null;
let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

shortcutHintEl.textContent = `${shortcut} generate`;
generateAsideEl.textContent = shortcut;

function selectedSize() {
  return document.querySelector('input[name="size"]:checked')?.value || "512x512";
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function setStatus(state, label, detail) {
  statusEl.dataset.state = state;
  statusLabelEl.textContent = label;
  statusDetailEl.textContent = detail;
}

function dataUrlFromB64(b64) {
  return `data:image/png;base64,${b64}`;
}

function formatClock(date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function resolveSeed() {
  const raw = seedEl.value.trim();
  if (raw === "") {
    return Math.floor(Math.random() * 2_147_483_647);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("Seed has to be a whole number, or leave it blank for auto.");
  }
  return value;
}

function resolveSteps() {
  const value = Number(stepsEl.value);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("Steps has to be a whole number between 1 and 50.");
  }
  return value;
}

function explainFailure(error, response, payload) {
  if (error?.name === "AbortError") {
    return `The image took too long. The studio waited ${timeoutSeconds} seconds and stopped.`;
  }
  if (error?.name === "TypeError") {
    return "The studio page could not reach its local proxy. Keep this tab on localhost and leave the studio server running.";
  }
  const message = payload?.error?.message || payload?.message;
  const code = payload?.error?.code;
  if (code === "backend_down" || response?.status === 502) {
    return message || "Rico 2 is not reachable. The image service at 192.168.4.246:1240 may be down.";
  }
  if (code === "timeout" || response?.status === 504) {
    return message || `The image took too long. The studio waited ${timeoutSeconds} seconds and stopped.`;
  }
  if (response?.status === 400) {
    return message || "The model rejected that prompt. Try a clearer description.";
  }
  if (response?.status === 413) {
    return "That prompt is too large for the image service.";
  }
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  if (!response) {
    return "Something went wrong before Rico 2 answered.";
  }
  return `Rico 2 returned ${response.status}. Try again, or use a smaller size.`;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 240) };
  }
}

function setBusy(nextBusy) {
  busy = nextBusy;
  generateEl.disabled = nextBusy;
  generateEl.dataset.busy = String(nextBusy);
  promptEl.disabled = nextBusy;
  if (nextBusy) {
    generateLabelEl.textContent = "Generating";
    emptyCopyEl.hidden = true;
    exposingEl.hidden = false;
    printEl.hidden = true;
    frameEl.dataset.state = "busy";
    const started = Date.now();
    elapsedEl.textContent = "0.0s";
    timer = setInterval(() => {
      elapsedEl.textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
      generateAsideEl.textContent = elapsedEl.textContent;
    }, 100);
  } else {
    generateLabelEl.textContent = "Generate";
    generateAsideEl.textContent = shortcut;
    exposingEl.hidden = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}

function showPrint(item) {
  selectedId = item.id;
  printEl.src = item.dataUrl;
  printEl.alt = item.prompt;
  printEl.hidden = false;
  emptyCopyEl.hidden = true;
  exposingEl.hidden = true;
  frameEl.dataset.state = "ready";
  printActionsEl.hidden = false;
  printMetaEl.textContent = `${item.size} · ${item.steps} steps · seed ${item.seed} · ${formatClock(item.created)}`;
  for (const card of stripEl.querySelectorAll(".frame-card")) {
    card.setAttribute("aria-current", card.dataset.id === item.id ? "true" : "false");
  }
}

function downloadItem(item) {
  const link = document.createElement("a");
  const stamp = item.created.toISOString().replace(/[:.]/g, "-");
  link.href = item.dataUrl;
  link.download = `rico2-${item.size}-${item.seed}-${stamp}.png`;
  document.body.append(link);
  link.click();
  link.remove();
}

function renderGallery() {
  galleryCountEl.textContent = gallery.length === 1 ? "1 frame" : `${gallery.length} frames`;
  stripEl.replaceChildren();
  for (const item of gallery) {
    const card = document.createElement("article");
    card.className = "frame-card";
    card.dataset.id = item.id;
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-current", item.id === selectedId ? "true" : "false");

    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "thumb";
    thumb.addEventListener("click", () => showPrint(item));

    const img = document.createElement("img");
    img.src = item.dataUrl;
    img.alt = item.prompt;

    const caption = document.createElement("span");
    caption.className = "caption";
    caption.textContent = `Seed ${item.seed}`;

    const download = document.createElement("button");
    download.type = "button";
    download.className = "dl";
    download.textContent = "Download";
    download.addEventListener("click", () => downloadItem(item));

    thumb.append(img, caption);
    card.append(thumb, download);
    stripEl.append(card);
  }
}

async function generate() {
  if (busy) {
    return;
  }

  const prompt = promptEl.value.trim();
  if (!prompt) {
    showError("Write a prompt first.");
    promptEl.focus();
    return;
  }

  let steps;
  let seed;
  try {
    steps = resolveSteps();
    seed = resolveSeed();
  } catch (error) {
    showError(error.message);
    return;
  }

  showError("");
  setBusy(true);

  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch("/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        model: MODEL_ID,
        n: 1,
        size: selectedSize(),
        response_format: "b64_json",
        steps,
        seed,
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw Object.assign(new Error("request-failed"), { response, payload });
    }
    const b64 = payload?.data?.[0]?.b64_json;
    if (!b64) {
      throw Object.assign(new Error("The service returned a response without an image."), {
        response,
        payload,
      });
    }

    const item = {
      id: crypto.randomUUID(),
      prompt,
      size: selectedSize(),
      steps,
      seed,
      created: new Date(),
      dataUrl: dataUrlFromB64(b64),
    };
    gallery.unshift(item);
    renderGallery();
    showPrint(item);
    seedEl.placeholder = String(seed);
  } catch (error) {
    frameEl.dataset.state = gallery.length ? "ready" : "empty";
    if (gallery.length) {
      printEl.hidden = false;
    } else {
      emptyCopyEl.hidden = false;
    }
    if (error.message === "The service returned a response without an image.") {
      showError(error.message);
    } else {
      showError(explainFailure(error, error.response, error.payload));
    }
  } finally {
    clearTimeout(watchdog);
    setBusy(false);
  }
}

async function refreshStatus() {
  try {
    const [healthRes, modelsRes, configRes] = await Promise.all([
      fetch("/health"),
      fetch("/v1/models"),
      fetch("/studio/config"),
    ]);
    const health = await readJson(healthRes);
    const models = await readJson(modelsRes);
    const config = configRes.ok ? await readJson(configRes) : null;
    if (config?.timeoutSeconds) {
      timeoutSeconds = config.timeoutSeconds;
    }

    const ids = (models?.data ?? models?.models ?? []).map((entry) => (
      typeof entry === "string" ? entry : entry?.id
    ));
    const hasModel = ids.includes(MODEL_ID);

    if (!healthRes.ok) {
      setStatus("down", "Offline", explainFailure(null, healthRes, health));
      return;
    }
    if (!modelsRes.ok) {
      setStatus("down", "Degraded", "Health answered, but the model list did not.");
      return;
    }
    if (!hasModel) {
      setStatus("error", "Model missing", "Health is up, but Flux.2 Klein 4B is not in the model list.");
      return;
    }
    setStatus("live", "Live", `Flux.2 Klein 4B · ${config?.backend || "192.168.4.246:1240"}`);
  } catch {
    setStatus("down", "Offline", "Rico 2 is not reachable. The image service may be down.");
  }
}

generateEl.addEventListener("click", generate);
downloadCurrentEl.addEventListener("click", () => {
  const item = gallery.find((entry) => entry.id === selectedId);
  if (item) {
    downloadItem(item);
  }
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    generate();
  }
});

refreshStatus();
setInterval(refreshStatus, 15_000);
