require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils");

const app = express();

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function isLoopbackHost(value) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(value).toLowerCase());
}

function isPlaceholderApiKey(value) {
  const normalized = String(value).toLowerCase();
  return normalized.includes("replace-this") || normalized.includes("change-me");
}

const config = {
  host: process.env.HOST || "127.0.0.1",
  port: parseInteger(process.env.PORT, 3030, 1, 65535),
  nodeEnv: process.env.NODE_ENV || "development",
  apiKey: process.env.API_KEY || "",
  authDataPath: process.env.AUTH_DATA_PATH || ".wwebjs_auth",
  headless: parseBool(process.env.PUPPETEER_HEADLESS, true),
  chromeNoSandbox: parseBool(process.env.CHROME_NO_SANDBOX, false),
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || "32kb",
  generalRateLimitMax: parseInteger(process.env.GENERAL_RATE_LIMIT_MAX, 120, 1, 10000),
  sendRateLimitMax: parseInteger(process.env.SEND_RATE_LIMIT_MAX, 20, 1, 1000),
  rateLimitWindowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, 1000, 3_600_000),
  messageMaxLength: parseInteger(process.env.MESSAGE_MAX_LENGTH, 4096, 1, 65_536),
  whatsappTimeoutMs: parseInteger(process.env.WHATSAPP_TIMEOUT_MS, 30_000, 1000, 300_000),
  readyTimeoutMs: parseInteger(process.env.READY_TIMEOUT_MS, 180_000, 30_000, 900_000),
  exitOnReadyTimeout: parseBool(process.env.EXIT_ON_READY_TIMEOUT, false),
  cleanChromeLocksOnStart: parseBool(process.env.CLEAN_CHROME_LOCKS_ON_START, true),
  debugDir: process.env.DEBUG_DIR || "/home/node/.cache/whatsapp-api-debug",
  debugScreenshotOnReadyTimeout: parseBool(process.env.DEBUG_SCREENSHOT_ON_READY_TIMEOUT, true),
  autoDismissPopups: parseBool(process.env.AUTO_DISMISS_POPUPS, true),
  popupDismissIntervalMs: parseInteger(process.env.POPUP_DISMISS_INTERVAL_MS, 15_000, 1000, 120_000),
  enableReadyFallback: parseBool(process.env.ENABLE_READY_FALLBACK, true),
  readyFallbackIntervalMs: parseInteger(process.env.READY_FALLBACK_INTERVAL_MS, 10_000, 1000, 120_000)
};

config.requireApiKey = parseBool(
  process.env.REQUIRE_API_KEY,
  config.nodeEnv === "production" || !isLoopbackHost(config.host)
);

if (config.requireApiKey && (config.apiKey.length < 32 || isPlaceholderApiKey(config.apiKey))) {
  console.error("API_KEY must be a real random secret of at least 32 characters when authentication is required.");
  process.exit(1);
}

if (!config.requireApiKey && !config.apiKey) {
  console.warn("API key authentication is disabled. Keep HOST bound to 127.0.0.1 for local-only use.");
}

let latestQr = null;
let latestQrDataUrl = null;
let whatsappReady = false;
let whatsappState = "starting";
let lastError = null;
let shuttingDown = false;
let lastStateChangeAt = new Date().toISOString();
let readyWatchdog = null;
let popupDismissInterval = null;
let readyFallbackInterval = null;

app.disable("x-powered-by");
app.set("trust proxy", false);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(
  rateLimit({
    windowMs: config.rateLimitWindowMs,
    max: config.generalRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      ok: false,
      error: "Too many requests"
    }
  })
);

app.use(express.json({ limit: config.requestBodyLimit, strict: true }));

const sendLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.sendRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "Too many send attempts"
  }
});

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeTokenEquals(provided, expected) {
  if (!provided || !expected) {
    return false;
  }

  return crypto.timingSafeEqual(hashToken(provided), hashToken(expected));
}

function extractBasicPassword(authorization) {
  if (!authorization.toLowerCase().startsWith("basic ")) {
    return "";
  }

  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    return separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
  } catch (_error) {
    return "";
  }
}

function requireApiKey(req, res, next) {
  if (!config.requireApiKey && !config.apiKey) {
    return next();
  }

  const authorization = req.get("authorization") || "";
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const basicPassword = extractBasicPassword(authorization);
  const headerToken = req.get("x-api-key") || "";

  if (
    safeTokenEquals(bearerToken, config.apiKey) ||
    safeTokenEquals(headerToken, config.apiKey) ||
    safeTokenEquals(basicPassword, config.apiKey)
  ) {
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="WhatsApp Local API"');
  return res.status(401).json({
    ok: false,
    error: "Missing or invalid API key"
  });
}

function normalizeChatId(to) {
  if (typeof to !== "string") {
    throw new Error("Field 'to' must be a string");
  }

  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Field 'to' is required");
  }

  if (/^[1-9]\d{6,14}@c\.us$/.test(trimmed)) {
    return trimmed;
  }

  if (/^[\d-]{7,40}@g\.us$/.test(trimmed)) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    throw new Error("Field 'to' must be an international phone number with 7 to 15 digits");
  }

  return `${digits}@c.us`;
}

function validateMessage(message) {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Field 'message' is required");
  }

  if (message.length > config.messageMaxLength) {
    throw new Error(`Field 'message' must be ${config.messageMaxLength} characters or fewer`);
  }

  return message;
}

async function withTimeout(promise, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), config.whatsappTimeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function setWhatsappState(state) {
  whatsappState = state;
  lastStateChangeAt = new Date().toISOString();
}

function clearReadyWatchdog() {
  if (readyWatchdog) {
    clearTimeout(readyWatchdog);
    readyWatchdog = null;
  }
}

function clearPopupDismissLoop() {
  if (popupDismissInterval) {
    clearInterval(popupDismissInterval);
    popupDismissInterval = null;
  }
}

function clearReadyFallbackLoop() {
  if (readyFallbackInterval) {
    clearInterval(readyFallbackInterval);
    readyFallbackInterval = null;
  }
}

function startReadyWatchdog(reason) {
  clearReadyWatchdog();

  readyWatchdog = setTimeout(async () => {
    if (whatsappReady || shuttingDown) {
      return;
    }

    const message = `WhatsApp did not become ready within ${config.readyTimeoutMs}ms after ${reason}.`;
    lastError = message;
    console.error(message);
    await captureDebugSnapshot("ready-timeout");

    if (config.exitOnReadyTimeout) {
      console.error("Exiting so Docker/Portainer can restart the container with the saved WhatsApp session.");
      process.exit(1);
    }
  }, config.readyTimeoutMs);
}

function startPopupDismissLoop() {
  if (!config.autoDismissPopups || popupDismissInterval) {
    return;
  }

  popupDismissInterval = setInterval(() => {
    dismissWhatsAppPopups("interval").catch((error) => {
      console.warn(`Could not dismiss WhatsApp popup: ${error.message}`);
    });
  }, config.popupDismissIntervalMs);
}

function startReadyFallbackLoop() {
  if (!config.enableReadyFallback || readyFallbackInterval) {
    return;
  }

  readyFallbackInterval = setInterval(() => {
    detectReadyFallback("interval").catch((error) => {
      console.warn(`Could not run WhatsApp ready fallback check: ${error.message}`);
    });
  }, config.readyFallbackIntervalMs);
}

function publicHealth() {
  return {
    ok: true,
    server: "online",
    whatsapp: {
      ready: whatsappReady,
      state: whatsappState
    }
  };
}

function detailedStatus() {
  return {
    ...publicHealth(),
    whatsapp: {
      ...publicHealth().whatsapp,
      hasQr: Boolean(latestQr),
      lastStateChangeAt,
      readyTimeoutMs: config.readyTimeoutMs
    },
    lastError
  };
}

function notReadyMessage() {
  if (whatsappState === "waiting_for_qr_scan") {
    return "WhatsApp is not ready yet. Scan the QR code and wait for ready state.";
  }

  if (whatsappState === "authenticated_waiting_for_ready" || whatsappState.startsWith("loading_")) {
    return "WhatsApp login succeeded, but WhatsApp Web is still loading. Wait for ready state, or restart the container if it stays stuck.";
  }

  return "WhatsApp is not ready yet.";
}

function cleanupStaleChromeLocks() {
  if (!config.cleanChromeLocksOnStart) {
    return;
  }

  const profileDir = path.resolve(config.authDataPath, "session");
  const lockNames = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

  for (const lockName of lockNames) {
    const lockPath = path.join(profileDir, lockName);

    try {
      fs.rmSync(lockPath, { force: true });
      console.log(`Removed stale Chromium profile lock: ${lockPath}`);
    } catch (error) {
      console.warn(`Could not remove Chromium profile lock ${lockPath}: ${error.message}`);
    }
  }
}

function ensureDebugDir() {
  try {
    fs.mkdirSync(config.debugDir, { recursive: true });
    console.log(`WhatsApp debug directory: ${config.debugDir}`);
  } catch (error) {
    console.warn(`Could not create WhatsApp debug directory ${config.debugDir}: ${error.message}`);
  }
}

async function captureDebugSnapshot(reason) {
  if (!config.debugScreenshotOnReadyTimeout) {
    return;
  }

  try {
    ensureDebugDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const basePath = path.join(config.debugDir, `${stamp}-${reason}`);
    const hasPage = Boolean(client.pupPage);
    const title = hasPage ? await client.pupPage.title().catch(() => null) : null;
    const url = hasPage && client.pupPage.url ? client.pupPage.url() : null;

    if (hasPage) {
      await client.pupPage.screenshot({
        path: `${basePath}.png`,
        fullPage: true
      });
    }

    fs.writeFileSync(
      `${basePath}.json`,
      JSON.stringify(
        {
          reason,
          hasPuppeteerPage: hasPage,
          title,
          url,
          whatsappState,
          lastStateChangeAt,
          capturedAt: new Date().toISOString()
        },
        null,
        2
      )
    );

    console.error(
      hasPage
        ? `Wrote WhatsApp debug snapshot to ${basePath}.png and ${basePath}.json`
        : `Wrote WhatsApp debug metadata to ${basePath}.json; Puppeteer page was not available`
    );
  } catch (error) {
    console.warn(`Could not capture WhatsApp debug snapshot: ${error.message}`);
  }
}

async function dismissWhatsAppPopups(reason) {
  if (!config.autoDismissPopups || whatsappReady || !client.pupPage) {
    return;
  }

  await client.pupPage.keyboard.press("Escape").catch(() => {});

  const result = await client.pupPage.evaluate(() => {
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const clicked = [];
    const closeLabels = new Set([
      "close",
      "dismiss",
      "not now",
      "ok",
      "got it",
      "continue"
    ]);
    const closeDataIcons = new Set([
      "x",
      "x-alt",
      "close",
      "delete",
      "dismiss"
    ]);

    const clickIfVisible = (element, label) => {
      if (!element || typeof element.click !== "function") {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";

      if (!visible) {
        return false;
      }

      element.click();
      clicked.push(label);
      return true;
    };

    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], [aria-label], [title], span[data-icon]")
    );

    for (const element of candidates) {
      const label = normalize(element.getAttribute("aria-label"));
      const title = normalize(element.getAttribute("title"));
      const text = normalize(element.textContent);
      const dataIcon = normalize(element.getAttribute("data-icon"));

      if (
        closeLabels.has(label) ||
        closeLabels.has(title) ||
        closeLabels.has(text) ||
        closeDataIcons.has(dataIcon)
      ) {
        clickIfVisible(element, label || title || text || dataIcon || element.tagName);
      }
    }

    const whatsNewHeading = Array.from(document.querySelectorAll("h1, h2, h3, div, span")).find((element) =>
      normalize(element.textContent).includes("what's new on whatsapp web")
    );

    if (whatsNewHeading) {
      const dialog = whatsNewHeading.closest("[role='dialog']") || whatsNewHeading.closest("div");
      const dialogButtons = dialog
        ? Array.from(dialog.querySelectorAll("button, [role='button'], [aria-label], span[data-icon]"))
        : [];

      for (const element of dialogButtons) {
        const label = normalize(element.getAttribute("aria-label"));
        const title = normalize(element.getAttribute("title"));
        const dataIcon = normalize(element.getAttribute("data-icon"));

        if (closeLabels.has(label) || closeLabels.has(title) || closeDataIcons.has(dataIcon)) {
          clickIfVisible(element, `whats-new:${label || title || dataIcon || element.tagName}`);
        }
      }
    }

    return clicked;
  });

  if (result.length > 0) {
    console.log(`Dismissed WhatsApp popup during ${reason}: ${result.join(", ")}`);
  }
}

async function detectReadyFallback(reason) {
  if (!config.enableReadyFallback || whatsappReady || !client.pupPage) {
    return false;
  }

  const snapshot = await client.pupPage.evaluate(() => {
    const socket = window.require ? window.require("WAWebSocketModel").Socket : null;
    const socketState = socket ? socket.state : null;
    const hasSynced = socket ? Boolean(socket.hasSynced) : false;
    const hasWWebJS = typeof window.WWebJS !== "undefined";
    const hasSendHelpers =
      hasWWebJS &&
      typeof window.WWebJS.sendMessage === "function" &&
      typeof window.WWebJS.getChat === "function";

    return {
      socketState,
      hasSynced,
      hasWWebJS,
      hasSendHelpers
    };
  });

  if (snapshot.socketState !== "CONNECTED" && !snapshot.hasSynced) {
    return false;
  }

  if (!snapshot.hasSendHelpers) {
    console.log(
      `WhatsApp fallback detected socket=${snapshot.socketState}, synced=${snapshot.hasSynced}; injecting send helpers.`
    );
    await client.pupPage.evaluate(LoadUtils);
  }

  const ready = await client.pupPage.evaluate(() => {
    return Boolean(
      window.WWebJS &&
        typeof window.WWebJS.sendMessage === "function" &&
        typeof window.WWebJS.getChat === "function" &&
        window.require("WAWebSocketModel").Socket.state === "CONNECTED"
    );
  });

  if (!ready) {
    return false;
  }

  clearReadyWatchdog();
  clearPopupDismissLoop();
  clearReadyFallbackLoop();
  latestQr = null;
  latestQrDataUrl = null;
  whatsappReady = true;
  setWhatsappState("ready");
  lastError = null;
  console.log(`WhatsApp client marked ready by fallback during ${reason}.`);
  return true;
}

function buildPuppeteerConfig() {
  const args = [
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-infobars",
    "--disable-notifications",
    "--disable-software-rasterizer",
    "--no-first-run",
    "--no-default-browser-check"
  ];

  if (config.chromeNoSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }

  return {
    headless: config.headless,
    executablePath: config.puppeteerExecutablePath,
    args
  };
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: config.authDataPath
  }),
  puppeteer: buildPuppeteerConfig()
});

client.on("qr", async (qr) => {
  clearReadyWatchdog();
  clearPopupDismissLoop();
  clearReadyFallbackLoop();
  latestQr = qr;
  latestQrDataUrl = await QRCode.toDataURL(qr);
  whatsappReady = false;
  setWhatsappState("waiting_for_qr_scan");

  console.log("\nScan this QR code with WhatsApp on your phone:\n");
  qrcodeTerminal.generate(qr, { small: true });
  console.log("\nYou can also open GET /qr.html in a browser while the server is running.\n");
});

client.on("loading_screen", (percent, message) => {
  if (!whatsappReady) {
    setWhatsappState(`loading_${percent}`);
  }

  console.log(`WhatsApp loading ${percent}%${message ? `: ${message}` : ""}`);

  if (Number(percent) >= 90) {
    startReadyFallbackLoop();
    dismissWhatsAppPopups("loading").catch((error) => {
      console.warn(`Could not dismiss WhatsApp popup during loading: ${error.message}`);
    });
    detectReadyFallback("loading").catch((error) => {
      console.warn(`Could not run WhatsApp ready fallback during loading: ${error.message}`);
    });
  }
});

client.on("ready", () => {
  clearReadyWatchdog();
  clearPopupDismissLoop();
  clearReadyFallbackLoop();
  latestQr = null;
  latestQrDataUrl = null;
  whatsappReady = true;
  setWhatsappState("ready");
  lastError = null;
  console.log("WhatsApp client is ready.");
});

client.on("authenticated", () => {
  whatsappReady = false;
  setWhatsappState("authenticated_waiting_for_ready");
  startReadyWatchdog("authentication");
  startPopupDismissLoop();
  startReadyFallbackLoop();
  setTimeout(() => {
    dismissWhatsAppPopups("authentication").catch((error) => {
      console.warn(`Could not dismiss WhatsApp popup after authentication: ${error.message}`);
    });
  }, 3000);
  console.log("WhatsApp authentication successful. Waiting for WhatsApp Web to become ready...");
});

client.on("auth_failure", (message) => {
  whatsappReady = false;
  setWhatsappState("auth_failure");
  lastError = message;
  console.error("WhatsApp authentication failed:", message);
});

client.on("disconnected", (reason) => {
  clearReadyWatchdog();
  clearPopupDismissLoop();
  clearReadyFallbackLoop();
  whatsappReady = false;
  setWhatsappState("disconnected");
  lastError = reason;
  console.warn("WhatsApp client disconnected:", reason);
});

app.get("/health", (_req, res) => {
  res.json(publicHealth());
});

app.get("/ready", (_req, res) => {
  if (!whatsappReady) {
    return res.status(503).json(publicHealth());
  }

  return res.json(publicHealth());
});

app.get("/status", requireApiKey, (_req, res) => {
  res.json(detailedStatus());
});

app.get("/qr", requireApiKey, (_req, res) => {
  if (!latestQrDataUrl) {
    return res.status(404).json({
      ok: false,
      error: whatsappReady
        ? "WhatsApp is already connected; no QR code is active"
        : "QR code is not available yet"
    });
  }

  return res.json({
    ok: true,
    dataUrl: latestQrDataUrl
  });
});

app.get("/qr.html", requireApiKey, (_req, res) => {
  res.type("html");

  if (!latestQrDataUrl) {
    const message = whatsappReady
      ? "WhatsApp is already connected; no QR code is active."
      : "QR code is not available yet. Refresh in a few seconds.";

    return res.status(404).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp QR</title>
  <style>
    body { align-items: center; display: flex; font-family: Arial, sans-serif; justify-content: center; margin: 0; min-height: 100vh; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
  </style>
</head>
<body>
  <main>
    <h1>WhatsApp QR</h1>
    <p>${message}</p>
  </main>
</body>
</html>`);
  }

  return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp QR</title>
  <style>
    body { align-items: center; display: flex; font-family: Arial, sans-serif; justify-content: center; margin: 0; min-height: 100vh; }
    main { max-width: 32rem; padding: 2rem; text-align: center; }
    img { height: min(82vw, 360px); image-rendering: pixelated; width: min(82vw, 360px); }
  </style>
</head>
<body>
  <main>
    <h1>Scan with WhatsApp</h1>
    <img src="${latestQrDataUrl}" alt="WhatsApp login QR code">
  </main>
</body>
</html>`);
});

app.post("/messages", requireApiKey, sendLimiter, async (req, res) => {
  try {
    if (shuttingDown) {
      return res.status(503).json({
        ok: false,
        error: "Server is shutting down"
      });
    }

    if (!whatsappReady) {
      return res.status(503).json({
        ok: false,
        error: notReadyMessage(),
        status: publicHealth().whatsapp
      });
    }

    const chatId = normalizeChatId(req.body.to);
    const message = validateMessage(req.body.message);

    if (chatId.endsWith("@c.us")) {
      const registered = await withTimeout(client.isRegisteredUser(chatId), "WhatsApp user lookup");
      if (!registered) {
        return res.status(404).json({
          ok: false,
          error: "That phone number is not registered on WhatsApp",
          chatId
        });
      }
    }

    const sent = await withTimeout(client.sendMessage(chatId, message), "WhatsApp send");

    return res.json({
      ok: true,
      chatId,
      messageId: sent.id && sent.id._serialized ? sent.id._serialized : null,
      timestamp: sent.timestamp || null
    });
  } catch (error) {
    lastError = error.message;
    return res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/logout", requireApiKey, async (_req, res) => {
  try {
    await withTimeout(client.logout(), "WhatsApp logout");
    whatsappReady = false;
    setWhatsappState("logged_out");
    latestQr = null;
    latestQrDataUrl = null;

    return res.json({
      ok: true
    });
  } catch (error) {
    lastError = error.message;
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.use((error, _req, res, next) => {
  if (!error) {
    return next();
  }

  if (error.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON request body"
    });
  }

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "Request body is too large"
    });
  }

  console.error(error);
  return res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not found"
  });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Local WhatsApp API listening at http://${config.host}:${config.port}`);
  console.log("Starting WhatsApp Web client...");
  ensureDebugDir();
  cleanupStaleChromeLocks();
  client.initialize().catch((error) => {
    whatsappReady = false;
    setWhatsappState("initialize_failed");
    lastError = error.message;
    console.error("Failed to initialize WhatsApp client:", error);
  });
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearPopupDismissLoop();
  clearReadyFallbackLoop();
  whatsappReady = false;
  setWhatsappState("shutting_down");
  console.log(`Received ${signal}; shutting down.`);

  server.close(async () => {
    try {
      await client.destroy();
    } catch (error) {
      console.warn("Error while destroying WhatsApp client:", error.message);
    } finally {
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  lastError = error && error.message ? error.message : String(error);
  console.error("Unhandled rejection:", error);
});
