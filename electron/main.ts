import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron, { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from "electron";
import type { IpcMainInvokeEvent, IpcMainEvent } from "electron";

const { Notification } = electron;
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import {
  AppState,
  ProfileActionInput,
  ProfileCreateInput,
  ProfileSummary,
  QuotaPool,
  ServiceStateInput,
  SettingsUpdateInput
} from "../src/shared/types.js";
import { ActiveProfileSyncer } from "./services/activeProfileSyncer.js";
import { CodexLoginCaptureService } from "./services/codexLoginCaptureService.js";
import { NotificationService } from "./services/notifications.js";
import { getEnvPaths } from "./services/paths.js";
import { CrossPlatformProcessManager } from "./services/processManager.js";
import { ProfileStore } from "./services/profileStore.js";
import { UsagePoller } from "./services/usagePoller.js";
import { UsageService } from "./services/usageService.js";
import { isEncryptionAvailable } from "./services/authStorage.js";
import { hasSessionPassphrase, setSessionPassphrase } from "./services/sessionKey.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPaths = getEnvPaths();
const storageRoot = path.join(envPaths.localAppData, "Relay");

function getAppIconPath(): string {
  const assetsDir = path.join(__dirname, "..", "assets");
  const buildDir = path.join(__dirname, "..", "build");

  if (process.platform === "win32") {
    const icoAsset = path.join(assetsDir, "app-icon.ico");
    if (fs.existsSync(icoAsset)) return icoAsset;
    const icoBuild = path.join(buildDir, "icon.ico");
    if (fs.existsSync(icoBuild)) return icoBuild;
  } else if (process.platform === "darwin") {
    const icnsAsset = path.join(assetsDir, "app-icon.icns");
    if (fs.existsSync(icnsAsset)) return icnsAsset;
    const icnsBuild = path.join(buildDir, "icon.icns");
    if (fs.existsSync(icnsBuild)) return icnsBuild;
  }

  // Linux / general fallback
  const tray32 = path.join(assetsDir, "tray-icon-32.png");
  if (fs.existsSync(tray32)) return tray32;
  const png512 = path.join(assetsDir, "icon.png");
  if (fs.existsSync(png512)) return png512;

  return path.join(assetsDir, "tray-icon.png");
}

function getTrayIcon(): Electron.NativeImage {
  const assetsDir = path.join(__dirname, "..", "assets");
  const candidates = [
    path.join(assetsDir, "tray-icon-32x32.png"),
    path.join(assetsDir, "tray-icon-32.png"),
    path.join(assetsDir, "tray-icon-16x16.png"),
    path.join(assetsDir, "tray-icon-16.png"),
    path.join(assetsDir, "tray-icon.png")
  ];

  for (const iconPath of candidates) {
    if (fs.existsSync(iconPath)) {
      return nativeImage.createFromPath(iconPath);
    }
  }
  return nativeImage.createFromPath(path.join(assetsDir, "tray-icon.png"));
}

const appIconPath = getAppIconPath();

let mainWindow: BrowserWindow | undefined;
let profileStore: ProfileStore;
let usagePoller: UsagePoller;
let activeProfileSyncer: ActiveProfileSyncer;
let tray: Tray | undefined;
let quitting = false;

app.setName("Relay");
if (process.platform === "win32") {
  app.setAppUserModelId("Relay");
}
Menu.setApplicationMenu(null);

/**
 * SECURITY: validate the origin of every IPC message.
 *
 * Legitimate messages come only from the app's own renderer, which is served
 * either from a file:// URL (packaged) or the Vite dev server (development).
 * Anything else — a remote origin, an unexpected frame — is rejected before it
 * can reach any privileged handler. This is defense-in-depth: combined with
 * the navigation/window-open guards, it means a renderer-side bug or injected
 * string cannot pivot to the profile/credential IPC surface.
 */
function isTrustedSender(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  if (url.startsWith("file://")) {
    return true;
  }
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  return Boolean(devServerUrl && url.startsWith(devServerUrl));
}

/** ipcMain.handle wrapper that drops calls from untrusted sender frames. */
function safeHandle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<any> | any
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      console.warn(`[security] rejected IPC '${channel}' from untrusted sender: ${event.senderFrame?.url}`);
      throw new Error("Rejected: untrusted IPC sender.");
    }
    return listener(event, ...args);
  });
}

/** ipcMain.on wrapper that drops calls from untrusted sender frames. */
function safeOn(
  channel: string,
  listener: (event: IpcMainEvent, ...args: any[]) => void
): void {
  ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event.senderFrame?.url)) {
      console.warn(`[security] rejected IPC '${channel}' from untrusted sender: ${event.senderFrame?.url}`);
      return;
    }
    listener(event, ...args);
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: "Relay",
    icon: appIconPath,
    autoHideMenuBar: true,
    backgroundColor: "#0A0A0F",
    titleBarStyle: "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.setIcon(appIconPath);
  window.setTitle("Relay");

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("render-process-gone", details);
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error("preload-error", { preloadPath, error: String(error) });
  });

  // Security: deny all attempts to open new windows and block navigation away
  // from the app's own content. Defense-in-depth against a renderer-side bug or
  // injected string (e.g. via a profile name or usage payload) trying to open
  // external windows or load remote content.
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Route legitimate external links (http/https) through the OS browser
    // rather than opening an in-app window, then always deny the popup.
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch((error) => {
        console.warn(`[security] failed to open external url ${url}:`, error);
      });
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    const isDevNav = Boolean(devServerUrl && url.startsWith(devServerUrl));
    if (!isDevNav && !url.startsWith("file://")) {
      event.preventDefault();
      console.warn(`[security] blocked navigation to ${url}`);
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });

  return window;
}

function registerIpc(): void {
  safeHandle("profiles:get-state", () => profileStore.getState());
  safeHandle("profiles:begin-login-capture", () => profileStore.beginLoginCapture());
  safeHandle("profiles:start-login-capture", () => profileStore.startLoginCapture());
  safeHandle("profiles:open-login-capture", (_event, input: { captureId: string }) => profileStore.openLoginCapture(input.captureId));
  safeHandle("profiles:wait-login-capture", (_event, input: { captureId: string }) => profileStore.waitLoginCapture(input.captureId));
  safeHandle("profiles:cancel-login-capture", (_event, input: { captureId: string }) => profileStore.cancelLoginCapture(input.captureId));
  safeHandle("profiles:create", (_event, input: ProfileCreateInput) => mutate(() => profileStore.createProfile(input)));
  safeHandle("profiles:sync-current", (_event, input: { name: string }) => mutate(() => profileStore.syncCurrentProfile(input)));
  safeHandle("profiles:switch", (_event, input: ProfileActionInput) => mutate(() => profileStore.switchProfile(input)));
  safeHandle("profiles:backup", (_event, input: ProfileActionInput) => mutate(() => profileStore.backupProfile(input)));
  safeHandle("profiles:delete", (_event, input: ProfileActionInput) => mutate(() => profileStore.deleteProfile(input)));
  safeHandle("profiles:rename", (_event, input: ProfileActionInput & { name: string }) => mutate(() => profileStore.renameProfile(input)));
  safeHandle("usage:refresh", (_event, input: ProfileActionInput) => mutate(async () => {
    const snapshot = await profileStore.refreshUsage(input);
    await profileStore.autoSwitchIfNeeded();
    return snapshot;
  }));
  safeHandle("usage:refresh-all", () => mutate(async () => {
    await profileStore.refreshAllUsage();
    await profileStore.autoSwitchIfNeeded();
    return profileStore.getState();
  }));
  safeHandle("settings:update", (_event, input: SettingsUpdateInput) => mutate(async () => {
    let state = await profileStore.updateSettings(input);
    if (input.autoSwitchEnabled !== undefined || input.autoSwitchThresholdPercent !== undefined) {
      await profileStore.autoSwitchIfNeeded();
      state = await profileStore.getState();
    }
    if (input.startWithSystem !== undefined) {
      app.setLoginItemSettings({
        openAtLogin: input.startWithSystem,
        path: process.execPath
      });
    }
    if (input.proxyEnabled !== undefined || input.proxyUrl !== undefined) {
      await applyProxySettings(state.settings);
    }
    if (input.autoSyncCurrentAccount !== undefined || input.syncIntervalMinutes !== undefined) {
      activeProfileSyncer?.restart();
    }
    return state;
  }));
  safeHandle("service:update-state", (_event, input: ServiceStateInput) => mutate(async () => {
    const state = await profileStore.setServiceRunning(input.running);
    if (input.running) {
      usagePoller.start();
      void usagePoller.poll();
    } else {
      usagePoller.stop();
    }
    return state;
  }));
  safeHandle("profiles:export", (_event, input?: { passphrase?: string }) => exportProfiles(input?.passphrase));
  safeHandle("profiles:preview-import", (_event, input?: { passphrase?: string }) => previewImport(input?.passphrase));
  safeHandle("profiles:confirm-import", (_event, input: { path: string; passphrase?: string }) => confirmImport(input.path, input.passphrase));
  safeHandle("profiles:open-folder", (_event, input: ProfileActionInput) => profileStore.openProfileFolder(input));
  safeHandle("system:open-log-directory", async () => {
    await shell.openPath(storageRoot);
  });
  safeHandle("system:browse-executable", async () => {
    const exeFilters = process.platform === "win32"
      ? [{ name: "Executable", extensions: ["exe"] }]
      : [{ name: "All Files", extensions: ["*"] }];
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "Select Codex / ChatGPT executable",
          filters: exeFilters,
          properties: ["openFile"]
        })
      : await dialog.showOpenDialog({
          title: "Select Codex / ChatGPT executable",
          filters: exeFilters,
          properties: ["openFile"]
        });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  // Security: report whether an unlock passphrase is needed (no OS keychain and
  // none set yet), and set the in-memory session passphrase on unlock. Setting
  // it re-seals any auth files that were left plaintext before unlock.
  safeHandle("security:needs-passphrase", () => !isEncryptionAvailable() && !hasSessionPassphrase());
  safeHandle("security:unlock", async (_event, input: { passphrase: string }) => {
    setSessionPassphrase(input.passphrase);
    await profileStore.resealAfterUnlock();
    return true;
  });
  // Fire-and-forget: renderer notifies when it switches themes
  safeOn("system:set-theme", (_event, input: { theme: "light" | "dark" }) => {
    const theme = input?.theme;
    if (theme === "light" || theme === "dark") {
      applyNativeTheme(theme);
    }
  });
}

/** Apply theme to native OS chrome (titlebar colour, background flash prevention). */
function applyNativeTheme(theme: "light" | "dark"): void {
  nativeTheme.themeSource = theme;
  const bg = theme === "light" ? "#fafafa" : "#0a0a0a";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(bg);
  }
}

async function applyProxySettings(settings: { proxyEnabled: boolean; proxyUrl?: string }): Promise<void> {
  const proxyRules = settings.proxyEnabled && settings.proxyUrl?.trim()
    ? settings.proxyUrl.trim()
    : "";
  await session.defaultSession.setProxy({ proxyRules });
}

async function switchFromNotification(input: ProfileActionInput): Promise<void> {
  await profileStore.switchProfile(input);
  const window = mainWindow ?? createWindow();
  mainWindow = window;
  window.webContents.send("profile:focus", input);
  await broadcastStateChanged();
}

async function mutate<T>(action: () => Promise<T>): Promise<T> {
  const result = await action();
  await broadcastStateChanged();
  return result;
}

async function broadcastStateChanged(): Promise<void> {
  await updateTrayMenu();
  mainWindow?.webContents.send("state:changed");
}

async function exportProfiles(passphrase?: string) {
  const options = {
    title: "Export Codex account pool",
    defaultPath: "codex-accounts.json",
    filters: [{ name: "JSON", extensions: ["json"] }]
  };
  const result = mainWindow
    ? await dialog.showSaveDialog(mainWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { count: 0 };
  }
  return profileStore.exportProfilesTo(result.filePath, passphrase);
}

async function previewImport(passphrase?: string) {
  const options: Electron.OpenDialogOptions = {
    title: "Import Codex account pool",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["openFile"]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  // Validate + return preview \u2014 throws with user-friendly message on bad files.
  return profileStore.previewImportFrom(result.filePaths[0], passphrase);
}

async function confirmImport(filePath: string, passphrase?: string) {
  return mutate(() => profileStore.importProfilesFrom(filePath, passphrase));
}

function showMainWindow(): void {
  const window = mainWindow ?? createWindow();
  mainWindow = window;
  window.show();
  if (window.isMinimized()) {
    window.restore();
  }
  window.focus();
}

function createTray(): void {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip("Relay");
  tray.on("click", showMainWindow);
  updateTrayMenu();
}

async function updateTrayMenu(): Promise<void> {
  if (!tray || !profileStore) {
    return;
  }

  const state = await profileStore.getState().catch(() => undefined);
  const profiles = state?.profiles ?? [];
  const active = profiles.find((profile) => profile.isActive);
  tray.setToolTip("Relay");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Current: ${activeAccountLabel(active)}`, enabled: false },
    { label: `Quota: ${quotaLabel(active)}`, enabled: false },
    { type: "separator" },
    {
      label: "Switch to Next Account",
      enabled: profiles.length > 1,
      click: () => void switchToNextAvailableAccount()
    },
    {
      label: "Refresh Current Quota",
      enabled: Boolean(active),
      click: () => {
        if (!active) {
          return;
        }
        void mutate(() => profileStore.refreshUsage({ profileId: active.id }));
      }
    },
    { type: "separator" },
    { label: "Show Main Window", click: showMainWindow },
    {
      label: "Quit Application",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
}

async function switchToNextAvailableAccount(): Promise<void> {
  const state = await profileStore.getState();
  const next = nextAvailableProfile(state);
  if (!next) {
    showTrayNotification("All accounts are rate limited.");
    return;
  }

  await mutate(() => profileStore.switchProfile({ profileId: next.id }));
}

function nextAvailableProfile(state: AppState): ProfileSummary | undefined {
  const profiles = state.profiles;
  if (profiles.length === 0) {
    return undefined;
  }

  const activeIndex = profiles.findIndex((profile) => profile.isActive);
  const startIndex = activeIndex >= 0 ? activeIndex : -1;
  for (let offset = 1; offset <= profiles.length; offset += 1) {
    const profile = profiles[(startIndex + offset + profiles.length) % profiles.length];
    if (!profile.isActive && hasQuotaRemaining(profile)) {
      return profile;
    }
  }
  return undefined;
}

function hasQuotaRemaining(profile: ProfileSummary): boolean {
  const pool = primaryQuotaPool(profile);
  return Boolean(profile.usage?.status === "available" && pool?.remaining !== undefined && pool.remaining > 0);
}

function activeAccountLabel(profile: ProfileSummary | undefined): string {
  return profile?.email || profile?.name || "No active account";
}

function quotaLabel(profile: ProfileSummary | undefined): string {
  const pool = primaryQuotaPool(profile);
  if (!pool || pool.remaining === undefined || pool.limit === undefined) {
    return "Unavailable";
  }
  return `${pool.remaining} / ${pool.limit}`;
}

function primaryQuotaPool(profile: ProfileSummary | undefined): Pick<QuotaPool, "remaining" | "limit"> | undefined {
  const usage = profile?.usage;
  if (!usage || usage.status !== "available") {
    return undefined;
  }

  const fiveHourPool = usage.pools?.find((pool) => pool.id.includes("five"));
  const weeklyPool = usage.pools?.find((pool) => pool.id.includes("weekly"));
  const monthlyPool = usage.pools?.find((pool) => pool.id.includes("monthly"));
  const creditsPool = usage.pools?.find((pool) => pool.id.includes("credits"));
  if (fiveHourPool) {
    return { remaining: fiveHourPool.remaining, limit: fiveHourPool.limit };
  }
  if (weeklyPool) {
    return { remaining: weeklyPool.remaining, limit: weeklyPool.limit };
  }
  if (monthlyPool) {
    return { remaining: monthlyPool.remaining, limit: monthlyPool.limit };
  }
  if (creditsPool) {
    return { remaining: creditsPool.remaining, limit: creditsPool.limit };
  }
  if (usage.fiveHour) {
    return { remaining: usage.fiveHour.remaining, limit: usage.fiveHour.limit };
  }
  if (usage.weekly) {
    return { remaining: usage.weekly.remaining, limit: usage.weekly.limit };
  }
  if (usage.monthly) {
    return { remaining: usage.monthly.remaining, limit: usage.monthly.limit };
  }
  if (usage.credits) {
    return { remaining: usage.credits.remaining, limit: usage.credits.limit };
  }
  return undefined;
}

function showTrayNotification(body: string): void {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title: "Relay", body }).show();
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const processManager = new CrossPlatformProcessManager();
    const usageService = new UsageService();
    const loginCaptureService = new CodexLoginCaptureService({
      openExternal: async (url) => {
        try {
          await shell.openExternal(url);
        } catch {
          throw new Error(
            `Unable to open your default browser. Please check your default browser settings, or copy and open this URL manually:\n${url}`
          );
        }
      },
    });
    profileStore = new ProfileStore(storageRoot, processManager, usageService, loginCaptureService);
    await profileStore.initialize();
    await profileStore.ensureInitialProfiles();
    const initialState = await profileStore.getState();
    await applyProxySettings(initialState.settings);
    // Apply the saved colour scheme before creating the window so the OS titlebar
    // gets the correct light/dark treatment immediately.
    const savedTheme = initialState.settings.theme;
    const initialTheme: "light" | "dark" = savedTheme === "system"
      ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
      : savedTheme === "light"
      ? "light"
      : "dark";
    applyNativeTheme(initialTheme);

    const notifications = new NotificationService(() => mainWindow, switchFromNotification, appIconPath);
    usagePoller = new UsagePoller(profileStore, notifications, broadcastStateChanged);
    activeProfileSyncer = new ActiveProfileSyncer(profileStore, processManager, broadcastStateChanged);
    registerIpc();

    mainWindow = createWindow();
    createTray();
    if (initialState.settings.serviceRunning) {
      usagePoller.start();
    }
    activeProfileSyncer.start();

    initializeAutoUpdater();

    app.on("activate", () => {
      if (!mainWindow) {
        mainWindow = createWindow();
      }
    });
  });
}

function initializeAutoUpdater(): void {
  // Only check for updates when packaged.
  if (!app.isPackaged) {
    return;
  }

  // Security: never silently download. Ask the user before pulling an update.
  // Auto-install on quit is fine once the user has explicitly approved the
  // download in the update-available prompt below.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  let manualUpdateCheck = false;
  let isDownloading = false;

  autoUpdater.on("update-available", (info) => {
    manualUpdateCheck = false;
    console.info(`[AutoUpdater] update available: v${info.version}`);
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Available",
      message: `Version ${info.version} of Relay is available. Download it now?`,
      buttons: ["Download", "Not Now"],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        isDownloading = true;
        if (mainWindow) {
          dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "Downloading Update",
            message: `Relay v${info.version} is downloading in the background. You will be prompted when it is ready to install.`
          }).catch(() => undefined);
        }
        void autoUpdater.downloadUpdate().catch((error) => {
          isDownloading = false;
          console.error("[AutoUpdater] downloadUpdate failed:", error);
          if (mainWindow) {
            dialog.showMessageBox(mainWindow, {
              type: "error",
              title: "Download Failed",
              message: `Could not download the update: ${error instanceof Error ? error.message : String(error)}`
            }).catch(() => undefined);
          }
        });
      }
    }).catch((error) => {
      console.error("[AutoUpdater] update-available dialog failed:", error);
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    console.info(`[AutoUpdater] download progress: ${Math.round(progress.percent)}% (${progress.transferred}/${progress.total})`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    isDownloading = false;
    console.info(`[AutoUpdater] update downloaded: v${info.version}`);
    if (!mainWindow) return;
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update Ready",
      message: `Version ${info.version} of Relay has been downloaded. Restart the application now to install the update?`,
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    }).catch((error) => {
      console.error("[AutoUpdater] dialog failed:", error);
    });
  });

  autoUpdater.on("update-not-available", () => {
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      if (!mainWindow) return;
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Up to Date",
        message: `You are already running the latest version of Relay (v${app.getVersion()}).`
      });
    }
  });

  autoUpdater.on("error", (err) => {
    const wasChecking = manualUpdateCheck;
    const wasDownloading = isDownloading;
    manualUpdateCheck = false;
    isDownloading = false;
    console.error("[AutoUpdater] error:", err);
    if ((wasChecking || wasDownloading) && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "Update Error",
        message: `An error occurred while checking for or downloading updates:\n${err instanceof Error ? err.message : String(err)}`
      }).catch(() => undefined);
    }
  });

  // Run update check (does not download because autoDownload is false).
  void autoUpdater.checkForUpdates().catch((error) => {
    console.error("[AutoUpdater] checkForUpdates failed:", error);
  });

  safeHandle("system:check-updates", async () => {
    manualUpdateCheck = true;
    try {
      await autoUpdater.checkForUpdates();
      return "checking";
    } catch (error) {
      console.error("[AutoUpdater] manual checkForUpdates failed:", error);
      manualUpdateCheck = false;
      if (mainWindow) {
        dialog.showMessageBox(mainWindow, {
          type: "error",
          title: "Update Error",
          message: `Unable to check for updates: ${error instanceof Error ? error.message : String(error)}`
        }).catch(() => undefined);
      }
      return "error";
    }
  });
}

app.on("before-quit", () => {
  quitting = true;
  usagePoller?.stop();
  activeProfileSyncer?.stop();
});

app.on("window-all-closed", () => {
  if (quitting) {
    usagePoller?.stop();
    activeProfileSyncer?.stop();
    app.quit();
  }
});
