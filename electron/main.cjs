const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  screen,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VALID_STATES = new Set(["working", "done", "waiting", "idle", "quit"]);
const APP_ID = "com.codex.traffic-light";
const APP_TITLE = "Codex 红绿灯";
const DONE_AUTO_IDLE_MS = 10 * 60 * 1000;
const DESKTOP_MONITOR_POLL_MS = 800;
const DESKTOP_MONITOR_START_GRACE_MS = 5 * 60 * 1000;
const WINDOW_SAFE_MARGIN = 14;
const CARD_SIZES = {
  single: { width: 236, height: 304 },
  triple: { width: 260, height: 414 },
};

const userProfile = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(userProfile, ".codex");
const codexBin = path.join(codexHome, "bin");
const hooksPath = path.join(codexHome, "hooks.json");
const sessionsRoot = path.join(codexHome, "sessions");
const commandScriptPath = path.join(codexBin, "codex-light.ps1");
const commandShimPath = path.join(codexBin, "codex-light.cmd");
const hookScriptPath = path.join(codexBin, "codex-light-hook.ps1");
const appDataRoot =
  process.env.APPDATA || path.join(userProfile, "AppData", "Roaming");
const runtimeDir = path.join(appDataRoot, "CodexTrafficLight");
const statePath = path.join(runtimeDir, "state.json");
const preferencesPath = path.join(runtimeDir, "preferences.json");
const positionPath = path.join(runtimeDir, "window-position.json");
const rendererDiagnosticsPath = path.join(runtimeDir, "renderer-diagnostics.json");
const distPath = path.join(__dirname, "../dist/index.html");
const appIconPath = path.join(__dirname, "assets", "app-icon.ico");

let mainWindow = null;
let tray = null;
let pollTimer = null;
let doneIdleTimer = null;
let lastState = "";
let lastStateUpdatedAt = 0;
let desktopMonitorTimer = null;
let desktopMonitorLastKey = "";
let desktopMonitorStartedAtMs = Date.now();

const defaultPreferences = {
  muted: false,
  theme: "light",
  style: "triple",
  startWithWindows: false,
};

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeState(state) {
  return VALID_STATES.has(state) ? state : "idle";
}

function readStatePayload() {
  const payload = readJson(statePath, null);
  const updatedAt = Number(payload && payload.updated_at);
  return {
    state: normalizeState(payload && payload.state),
    event: typeof (payload && payload.event) === "string" ? payload.event : "",
    updated_at: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function readState() {
  return readStatePayload().state;
}

function writeState(state, event = "manual") {
  const normalized = normalizeState(state);
  writeJson(statePath, {
    state: normalized,
    event,
    updated_at: nowSeconds(),
  });
  return normalized;
}

function isWaitingMessage(message) {
  if (!message || typeof message !== "string") return false;
  return [
    /请确认/,
    /需要你确认/,
    /请选择/,
    /请回复/,
    /是否继续/,
    /要不要/,
    /please\s+confirm/i,
    /please\s+choose/i,
    /reply\s+with/i,
    /do\s+you\s+want/i,
    /would\s+you\s+like/i,
  ].some((pattern) => pattern.test(message));
}

function findLatestSessionFile() {
  if (!fs.existsSync(sessionsRoot)) return null;

  const stack = [sessionsRoot];
  let latest = null;

  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { filePath: fullPath, mtimeMs: stat.mtimeMs };
      }
    }
  }

  return latest;
}

function readSessionTail(filePath, maxBytes = 8 * 1024 * 1024) {
  let handle = null;
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(filePath, "r");
    fs.readSync(handle, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/).filter(Boolean);
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // Ignore close errors while monitoring best-effort session state.
      }
    }
  }
}

function parseSessionTimestampMs(entry) {
  const parsed = Date.parse(entry && entry.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromMessagePayload(payload) {
  if (!payload || !Array.isArray(payload.content)) return "";
  return payload.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("\n");
}

function latestDesktopSessionSignal() {
  const latest = findLatestSessionFile();
  if (!latest) return null;

  let signal = null;
  let openTurnId = "";
  let planTurnId = "";
  const pendingInputCallIds = new Set();
  const abortedTurnIds = new Set();
  for (const line of readSessionTail(latest.filePath)) {
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry && entry.payload;
    const eventType = payload && payload.type;
    if (!eventType) continue;

    const timestampMs = parseSessionTimestampMs(entry) || latest.mtimeMs;
    const turnId = payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id || "";
    const callName = typeof payload.name === "string" ? payload.name : "";
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    const base = `${latest.filePath}:${turnId}:${eventType}:${callName}:${callId}:${entry.timestamp || timestampMs}`;

    if (eventType === "task_started") {
      if (turnId) abortedTurnIds.delete(turnId);
      openTurnId = turnId;
      planTurnId = "";
      pendingInputCallIds.clear();
      signal = {
        key: base,
        state: "working",
        event: "desktop-task-started",
        timestampMs,
      };
      continue;
    }

    if (eventType === "turn_aborted") {
      const abortedTurnId = turnId || openTurnId;
      if (abortedTurnId) abortedTurnIds.add(abortedTurnId);
      openTurnId = "";
      planTurnId = "";
      pendingInputCallIds.clear();
      signal = {
        key: base,
        state: "idle",
        event: "desktop-turn-aborted",
        timestampMs,
      };
      continue;
    }

    if (turnId && abortedTurnIds.has(turnId)) {
      continue;
    }

    const isPlanItemCompleted =
      eventType === "item_completed" &&
      payload.item &&
      payload.item.type === "Plan";
    const isProposedPlanMessage =
      eventType === "message" &&
      payload.role === "assistant" &&
      textFromMessagePayload(payload).includes("<proposed_plan>");

    if (isPlanItemCompleted || isProposedPlanMessage) {
      planTurnId = turnId || openTurnId || planTurnId;
      signal = {
        key: base,
        state: "waiting",
        event: "desktop-plan-awaiting-approval",
        timestampMs,
      };
      continue;
    }

    if (/permission|approval/i.test(eventType) && /request/i.test(eventType)) {
      signal = {
        key: base,
        state: "waiting",
        event: "desktop-permission-request",
        timestampMs,
      };
      continue;
    }

    if (eventType === "function_call" && callName === "request_user_input") {
      pendingInputCallIds.add(callId || base);
      signal = {
        key: base,
        state: "waiting",
        event: "desktop-user-input-request",
        timestampMs,
      };
      continue;
    }

    if (eventType === "function_call_output" && callId && pendingInputCallIds.has(callId)) {
      pendingInputCallIds.delete(callId);
      continue;
    }

    if (eventType === "task_complete") {
      openTurnId = "";
      pendingInputCallIds.clear();
      const lastMessage =
        typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
      const isPlanAwaitingApproval = Boolean(planTurnId && (!turnId || turnId === planTurnId));
      signal = {
        key: base,
        state: isPlanAwaitingApproval || isWaitingMessage(lastMessage) ? "waiting" : "done",
        event: isPlanAwaitingApproval ? "desktop-plan-awaiting-approval" : "desktop-task-complete",
        timestampMs,
      };
      if (!isPlanAwaitingApproval) {
        planTurnId = "";
      }
    }

    if (openTurnId && eventType !== "task_complete" && (!turnId || turnId === openTurnId)) {
      if (planTurnId && (!turnId || turnId === planTurnId)) {
        signal = {
          key: base,
          state: "waiting",
          event: "desktop-plan-awaiting-approval",
          timestampMs,
        };
        continue;
      }

      if (pendingInputCallIds.size > 0) {
        signal = {
          key: base,
          state: "waiting",
          event: "desktop-user-input-pending",
          timestampMs,
        };
        continue;
      }

      signal = {
        key: base,
        state: "working",
        event: "desktop-task-active",
        timestampMs,
      };
    }
  }

  return signal;
}

function readPreferences() {
  const saved = readJson(preferencesPath, {});
  const preferences = { ...defaultPreferences, ...saved };
  preferences.theme = preferences.theme === "light" ? "light" : "dark";
  preferences.style = preferences.style === "single" ? "single" : "triple";
  preferences.muted = Boolean(preferences.muted);
  preferences.startWithWindows = Boolean(preferences.startWithWindows);
  return preferences;
}

function savePreferences(patch) {
  const next = { ...readPreferences(), ...patch };
  writeJson(preferencesPath, next);
  applyLoginItemPreference(next.startWithWindows);
  sendPreferences(next);
  rebuildMenus();
  return next;
}

function applyLoginItemPreference(enabled) {
  if (process.platform !== "win32") return;
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
    });
  } catch {
    // Login item support can fail in dev shells; the preference is still saved.
  }
}

function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function hookCommandFor(eventName) {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${hookScriptPath}" -EventName "${eventName}"`;
}

function commandStatusMessageFor(state) {
  const label = {
    working: "working",
    waiting: "waiting",
    done: "done",
  }[state];
  return `Codex Traffic Light: ${label}`;
}

function commandScriptSource() {
  return String.raw`param(
    [Parameter(Position = 0, Mandatory = $false)]
    [ValidateSet('working', 'done', 'waiting', 'idle', 'quit', 'status')]
    [string]$Command = 'status',

    [Parameter(Mandatory = $false)]
    [string]$EventName = 'manual'
)

$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $env:APPDATA 'CodexTrafficLight'
$statePath = Join-Path $runtimeDir 'state.json'

function Ensure-Runtime {
    if (-not (Test-Path -LiteralPath $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) {
        return 'idle'
    }

    try {
        $payload = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ($payload.state -in @('working', 'done', 'waiting', 'idle', 'quit')) {
            return [string]$payload.state
        }
    } catch {
    }

    return 'idle'
}

function Write-State([string]$State, [string]$Event) {
    Ensure-Runtime
    $payload = [ordered]@{
        state = $State
        event = $Event
        updated_at = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    } | ConvertTo-Json -Compress

    $tempPath = Join-Path $runtimeDir ('state.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    Set-Content -LiteralPath $tempPath -Value $payload -Encoding UTF8

    if (Test-Path -LiteralPath $statePath) {
        $backupPath = Join-Path $runtimeDir ('state.' + [Guid]::NewGuid().ToString('N') + '.bak')
        [System.IO.File]::Replace($tempPath, $statePath, $backupPath)
        if (Test-Path -LiteralPath $backupPath) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    } else {
        Move-Item -LiteralPath $tempPath -Destination $statePath -Force
    }
}

if ($Command -eq 'status') {
    Read-State
    exit 0
}

Write-State -State $Command -Event $EventName
$Command
`;
}

function commandShimSource() {
  return `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codex-light.ps1" %*\r\n`;
}

function fileSourceForWrite(filePath, source) {
  return filePath.toLowerCase().endsWith(".ps1") ? `\ufeff${source}` : source;
}

function hookScriptSource() {
  const commandPathLiteral = psSingleQuoted(commandScriptPath);
  return String.raw`param(
    [Parameter(Mandatory = $false)]
    [string]$EventName = ''
)

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
} catch {
}

function Read-StdInUtf8 {
    if (-not [Console]::IsInputRedirected) {
        return ''
    }

    $stream = [Console]::OpenStandardInput()
    $buffer = New-Object byte[] 4096
    $memory = New-Object System.IO.MemoryStream

    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $memory.Write($buffer, 0, $read)
        }

        return [Text.Encoding]::UTF8.GetString($memory.ToArray()).TrimStart([char]0xFEFF)
    } finally {
        $memory.Dispose()
    }
}

$rawHookInput = ''
try {
    $rawHookInput = Read-StdInUtf8
} catch {
    $rawHookInput = ''
}

$hookInput = $null
if (-not [string]::IsNullOrWhiteSpace($rawHookInput)) {
    try {
        $hookInput = $rawHookInput | ConvertFrom-Json -ErrorAction Stop
    } catch {
        $hookInput = $null
    }
}

function Test-WaitingMessage([string]$Message) {
    if ([string]::IsNullOrWhiteSpace($Message)) {
        return $false
    }

    $patterns = @(
        '请确认',
        '需要你确认',
        '请选择',
        '请回复',
        '是否继续',
        '要不要',
        'please\s+confirm',
        'please\s+choose',
        'reply\s+with',
        'do\s+you\s+want',
        'would\s+you\s+like'
    )

    foreach ($pattern in $patterns) {
        if ($Message -match $pattern) {
            return $true
        }
    }

    return $false
}

$name = $EventName
if ($hookInput -and $hookInput.hook_event_name) {
    $name = [string]$hookInput.hook_event_name
}

$state = $null
switch ($name) {
    'UserPromptSubmit' { $state = 'working' }
    'PreToolUse' { $state = 'working' }
    'PermissionRequest' { $state = 'waiting' }
    'Stop' {
        $state = 'done'
        $lastAssistantMessage = ''
        if ($hookInput) {
            $propertyNames = @($hookInput.PSObject.Properties | ForEach-Object { $_.Name })
            if (($propertyNames -contains 'last_assistant_message') -and $null -ne $hookInput.last_assistant_message) {
                $lastAssistantMessage = [string]$hookInput.last_assistant_message
            }
        }
        if (Test-WaitingMessage -Message $lastAssistantMessage) {
            $state = 'waiting'
        }
    }
    'SubagentStop' { $state = 'done' }
}

if ($state) {
    & ${commandPathLiteral} $state -EventName $name | Out-Null
}

Write-Output '{}'
`;
}

function ensureCommandLayer() {
  ensureDirectory(codexBin);
  ensureDirectory(runtimeDir);

  const files = [
    [commandScriptPath, commandScriptSource()],
    [commandShimPath, commandShimSource()],
    [hookScriptPath, hookScriptSource()],
  ];

  for (const [filePath, source] of files) {
    const fileSource = fileSourceForWrite(filePath, source);
    if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== fileSource) {
      fs.writeFileSync(filePath, fileSource, "utf8");
    }
  }

  if (!fs.existsSync(statePath)) {
    writeState("idle", "app-start");
  }
}

function loadHooksRoot() {
  if (!fs.existsSync(hooksPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    const backupPath =
      hooksPath + `.invalid-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}.bak`;
    try {
      fs.copyFileSync(hooksPath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch {
      // If backup fails, continue with a clean object rather than crashing startup.
    }
    return {};
  }
}

function containsOwnedCommand(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
    return false;
  }

  const markers = [
    "codex-light-hook.ps1",
    "codex-light.ps1",
    "codex_traffic_light_state",
    "cc_traffic_light_state",
  ];

  return entry.hooks.some((handler) => {
    const command = handler && typeof handler.command === "string" ? handler.command : "";
    return markers.some((marker) => command.toLowerCase().includes(marker.toLowerCase()));
  });
}

function createHookEntry(eventName, state) {
  const entry = {
    hooks: [
      {
        type: "command",
        command: hookCommandFor(eventName),
        timeout: 5,
        statusMessage: commandStatusMessageFor(state),
      },
    ],
  };

  if (eventName === "PreToolUse" || eventName === "PermissionRequest" || eventName === "SubagentStop") {
    entry.matcher = ".*";
  }

  return entry;
}

function installCodexHooks() {
  ensureCommandLayer();
  ensureDirectory(codexHome);

  const root = loadHooksRoot();
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks : {};
  root.hooks = hooks;

  const mappings = [
    ["UserPromptSubmit", "working"],
    ["PreToolUse", "working"],
    ["PermissionRequest", "waiting"],
    ["Stop", "done"],
    ["SubagentStop", "done"],
  ];

  for (const [eventName, state] of mappings) {
    const existing = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
    hooks[eventName] = existing.filter((entry) => !containsOwnedCommand(entry));
    hooks[eventName].push(createHookEntry(eventName, state));
  }

  const json = JSON.stringify(root, null, 2);
  if (!fs.existsSync(hooksPath) || fs.readFileSync(hooksPath, "utf8") !== json) {
    fs.writeFileSync(hooksPath, json, "utf8");
  }

  return hooksPath;
}

function manualHooksSnippet() {
  const hooks = {};
  for (const [eventName, state] of [
    ["UserPromptSubmit", "working"],
    ["PreToolUse", "working"],
    ["PermissionRequest", "waiting"],
    ["Stop", "done"],
    ["SubagentStop", "done"],
  ]) {
    hooks[eventName] = [createHookEntry(eventName, state)];
  }
  return JSON.stringify({ hooks }, null, 2);
}

function readWindowPosition() {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const size = getWindowSize();
  return {
    x: Math.max(0, Math.round((display.width - size.width) / 2)),
    y: Math.max(0, Math.round((display.height - size.height) / 2)),
  };
}

function getWindowSize(preferences = readPreferences()) {
  const cardSize = preferences.style === "single" ? CARD_SIZES.single : CARD_SIZES.triple;
  return {
    width: cardSize.width + WINDOW_SAFE_MARGIN * 2,
    height: cardSize.height + WINDOW_SAFE_MARGIN * 2,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resizeWindowForPreferences(preferences) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const target = getWindowSize(preferences);
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current).workArea;
  const nextBounds = {
    x: clamp(
      current.x + Math.round((current.width - target.width) / 2),
      display.x,
      display.x + Math.max(0, display.width - target.width),
    ),
    y: clamp(
      current.y + Math.round((current.height - target.height) / 2),
      display.y,
      display.y + Math.max(0, display.height - target.height),
    ),
    width: target.width,
    height: target.height,
  };

  mainWindow.setContentSize(target.width, target.height, false);
  mainWindow.setBounds(nextBounds, false);
}

function createWindow() {
  const position = readWindowPosition();
  const size = getWindowSize();
  mainWindow = new BrowserWindow({
    ...size,
    x: position.x,
    y: position.y,
    title: APP_TITLE,
    icon: appIconPath,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    show: true,
    resizable: false,
    minimizable: false,
    skipTaskbar: false,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.center();
  mainWindow.once("ready-to-show", () => {
    showMainWindow();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    showMainWindow();
    writeRendererDiagnostics("did-finish-load");
  });
  mainWindow.webContents.on("did-fail-load", (_, errorCode, errorDescription, validatedURL) => {
    writeJson(rendererDiagnosticsPath, {
      event: "did-fail-load",
      errorCode,
      errorDescription,
      validatedURL,
      updated_at: new Date().toISOString(),
    });
  });
  mainWindow.webContents.on("console-message", (_, level, message, line, sourceId) => {
    const previous = readJson(rendererDiagnosticsPath, {});
    writeJson(rendererDiagnosticsPath, {
      ...previous,
      lastConsole: { level, message, line, sourceId },
      updated_at: new Date().toISOString(),
    });
  });
  setTimeout(() => {
    showMainWindow();
  }, 1200);

  if (!app.isPackaged && !fs.existsSync(distPath)) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(distPath);
  }

  mainWindow.on("moved", () => {
    if (!mainWindow) return;
    const [x, y] = mainWindow.getPosition();
    writeJson(positionPath, { x, y });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  startPollingState();
  startDesktopSessionMonitor();
}

function writeRendererDiagnostics(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => ({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyText: document.body ? document.body.innerText : null,
        bodyHtml: document.body ? document.body.innerHTML.slice(0, 1000) : null,
        rootHtml: document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 1000) : null,
        hasApi: Boolean(window.codexTrafficLight),
        scripts: Array.from(document.scripts).map(s => s.src),
        styles: Array.from(document.styleSheets).map(s => s.href)
      }))()`,
    )
    .then((payload) => {
      writeJson(rendererDiagnosticsPath, {
        event,
        payload,
        updated_at: new Date().toISOString(),
      });
    })
    .catch((error) => {
      writeJson(rendererDiagnosticsPath, {
        event,
        error: String(error && error.stack ? error.stack : error),
        updated_at: new Date().toISOString(),
      });
    });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  const { width, height } = mainWindow.getBounds();
  const work = screen.getPrimaryDisplay().workArea;
  mainWindow.setBounds({
    x: work.x + Math.max(0, Math.round((work.width - width) / 2)),
    y: work.y + Math.max(0, Math.round((work.height - height) / 2)),
    width,
    height,
  });
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.moveTop();
  mainWindow.focus();
}

function startPollingState() {
  if (pollTimer) clearInterval(pollTimer);
  const payload = readStatePayload();
  lastState = payload.state;
  lastStateUpdatedAt = payload.updated_at;
  scheduleDoneAutoIdle(lastState);

  pollTimer = setInterval(() => {
    const payload = readStatePayload();
    const state = payload.state;
    if (state === lastState && payload.updated_at === lastStateUpdatedAt) return;
    lastState = state;
    lastStateUpdatedAt = payload.updated_at;
    if (state === "quit") {
      app.quit();
      return;
    }
    scheduleDoneAutoIdle(state);
    sendState(state);
  }, 300);
}

function applyState(state, event) {
  const normalized = writeState(state, event);
  const payload = readStatePayload();
  lastState = payload.state;
  lastStateUpdatedAt = payload.updated_at;
  if (normalized === "quit") {
    app.quit();
    return normalized;
  }
  scheduleDoneAutoIdle(payload.state);
  sendState(payload.state);
  return payload.state;
}

function handleDesktopSessionSignal(signal) {
  if (!signal || signal.key === desktopMonitorLastKey) return;

  const isNew = signal.timestampMs >= desktopMonitorStartedAtMs - 1000;
  const isRecentWorking =
    signal.state === "working" &&
    signal.timestampMs >= desktopMonitorStartedAtMs - DESKTOP_MONITOR_START_GRACE_MS;

  desktopMonitorLastKey = signal.key;
  if (!isNew && !isRecentWorking) return;

  applyState(signal.state, signal.event);
}

function startDesktopSessionMonitor() {
  if (desktopMonitorTimer) clearInterval(desktopMonitorTimer);
  desktopMonitorStartedAtMs = Date.now();
  desktopMonitorLastKey = "";

  handleDesktopSessionSignal(latestDesktopSessionSignal());
  desktopMonitorTimer = setInterval(() => {
    handleDesktopSessionSignal(latestDesktopSessionSignal());
  }, DESKTOP_MONITOR_POLL_MS);
}

function scheduleDoneAutoIdle(state) {
  if (doneIdleTimer) {
    clearTimeout(doneIdleTimer);
    doneIdleTimer = null;
  }

  if (state === "done") {
    const payload = readStatePayload();
    const doneUpdatedAt = payload.state === "done" ? payload.updated_at : 0;
    const elapsedMs = doneUpdatedAt > 0 ? Date.now() - doneUpdatedAt * 1000 : 0;
    const remainingMs = Math.max(0, DONE_AUTO_IDLE_MS - elapsedMs);

    if (remainingMs === 0) {
      writeState("idle", "auto-idle");
      const next = readStatePayload();
      lastState = next.state;
      lastStateUpdatedAt = next.updated_at;
      sendState(next.state);
      return;
    }

    doneIdleTimer = setTimeout(() => {
      const current = readStatePayload();
      if (current.state === "done" && (!doneUpdatedAt || current.updated_at === doneUpdatedAt)) {
        writeState("idle", "auto-idle");
        const next = readStatePayload();
        lastState = next.state;
        lastStateUpdatedAt = next.updated_at;
        sendState(next.state);
      }
    }, remainingMs);
  }
}

function sendState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state-change", state);
    setTimeout(() => {
      writeRendererDiagnostics("state-change");
    }, 120);
  }
}

function sendPreferences(preferences = readPreferences()) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("preferences-change", preferences);
    resizeWindowForPreferences(preferences);
  }
}

function setManualState(state) {
  applyState(state, "manual");
}

function rebuildMenus() {
  if (!tray) return;
  const preferences = readPreferences();
  tray.setContextMenu(buildTrayMenu(preferences));
  Menu.setApplicationMenu(buildAppMenu(preferences));
}

function buildTrayMenu(preferences) {
  return Menu.buildFromTemplate([
    {
      label: "测试灯光",
      submenu: [
        { label: "黄灯：正在干活", click: () => setManualState("working") },
        { label: "绿灯：可以验收", click: () => setManualState("done") },
        { label: "红灯：等你确认", click: () => setManualState("waiting") },
        { label: "空闲：全暗", click: () => setManualState("idle") },
      ],
    },
    { type: "separator" },
    {
      label: preferences.style === "single" ? "切换到三灯样式" : "切换到单灯样式",
      click: () => savePreferences({ style: preferences.style === "single" ? "triple" : "single" }),
    },
    {
      label: preferences.theme === "dark" ? "切换浅色模式" : "切换深色模式",
      click: () => savePreferences({ theme: preferences.theme === "dark" ? "light" : "dark" }),
    },
    {
      label: preferences.muted ? "取消静音" : "静音",
      click: () => savePreferences({ muted: !preferences.muted }),
    },
    {
      label: preferences.startWithWindows ? "关闭开机自动启动" : "开启开机自动启动",
      click: () => savePreferences({ startWithWindows: !preferences.startWithWindows }),
    },
    { type: "separator" },
    { label: "显示悬浮窗", click: () => showMainWindow() },
    {
      label: "查看配置路径",
      click: () => {
        dialog
          .showMessageBox({
            type: "info",
            title: APP_TITLE,
            message: "Codex hooks 配置路径",
            detail: `${hooksPath}\n\n命令目录：${codexBin}\n状态文件：${statePath}`,
            buttons: ["打开 hooks.json", "打开状态目录", "关闭"],
            defaultId: 2,
          })
          .then(({ response }) => {
            if (response === 0) shell.openPath(hooksPath);
            if (response === 1) shell.openPath(runtimeDir);
          });
      },
    },
    {
      label: "重新写入 Codex hooks",
      click: () => {
        const installedPath = installCodexHooks();
        dialog.showMessageBox({
          type: "info",
          title: APP_TITLE,
          message: "Codex hooks 已重新写入",
          detail: `${installedPath}\n\n请在 Codex 中运行 /hooks 并信任这些命令 hook。`,
          buttons: ["好的"],
        });
      },
    },
    {
      label: "复制手动配置",
      click: () => {
        clipboard.writeText(manualHooksSnippet());
        dialog.showMessageBox({
          type: "info",
          title: APP_TITLE,
          message: "已复制 Codex hooks JSON",
          detail: "可把这段内容合并到 ~/.codex/hooks.json。通常使用“重新写入 Codex hooks”即可。",
          buttons: ["好的"],
        });
      },
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

function buildAppMenu(preferences) {
  return Menu.buildFromTemplate([
    {
      label: APP_TITLE,
      submenu: [
        { label: "关于 Codex 红绿灯", role: "about" },
        { type: "separator" },
        {
          label: preferences.theme === "dark" ? "切换浅色模式" : "切换深色模式",
          click: () => savePreferences({ theme: preferences.theme === "dark" ? "light" : "dark" }),
        },
        { type: "separator" },
        { label: "退出", click: () => app.quit() },
      ],
    },
  ]);
}

ipcMain.handle("get-state", () => readState());
ipcMain.handle("get-preferences", () => readPreferences());
ipcMain.handle("install-hooks", () => installCodexHooks());
ipcMain.handle("get-paths", () => ({
  codexHome,
  hooksPath,
  commandScriptPath,
  hookScriptPath,
  statePath,
  preferencesPath,
}));
ipcMain.on("set-state", (_, state) => setManualState(state));
ipcMain.on("set-preferences", (_, patch) => savePreferences(patch || {}));
ipcMain.on("quit", () => app.quit());

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_ID);
  }

  ensureCommandLayer();
  const installedPath = installCodexHooks();
  const preferences = readPreferences();
  applyLoginItemPreference(preferences.startWithWindows);
  writeState("idle", "app-start");

  const trayIcon = nativeImage.createFromPath(appIconPath);
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_TITLE);
  tray.on("click", () => {
    showMainWindow();
  });

  createWindow();
  rebuildMenus();

  if (!readJson(preferencesPath, {}).hookTrustReminderShown) {
    const next = { ...readPreferences(), hookTrustReminderShown: true };
    writeJson(preferencesPath, next);
    setTimeout(() => {
      dialog.showMessageBox({
        type: "info",
        title: APP_TITLE,
        message: "Codex hooks 已写入",
        detail: `${installedPath}\n\n请在 Codex 中运行 /hooks，并信任 Codex 红绿灯 hooks。未信任前，Codex 会跳过这些命令 hook。`,
        buttons: ["好的"],
      });
    }, 600);
  }
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (desktopMonitorTimer) clearInterval(desktopMonitorTimer);
  if (doneIdleTimer) clearTimeout(doneIdleTimer);
});

app.on("window-all-closed", () => {
  app.quit();
});
