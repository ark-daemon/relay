import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AppState,
  ProfileActionInput,
  ProfileExportResult,
  ProfileCreateInput,
  ProfileImportPreview,
  ProfileLoginCapture,
  ProfileLoginSession,
  ProfileSwitcherApi,
  ServiceStateInput,
  SettingsUpdateInput,
  SwitchResult,
  UsageSnapshot
} from "../src/shared/types.js";

function invokeIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  // SAFETY: IPC handler return value matches the exposed API method contract T
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: ProfileSwitcherApi = {
  getState: () => invokeIpc<AppState>("profiles:get-state"),
  beginLoginCapture: () => invokeIpc<ProfileLoginCapture>("profiles:begin-login-capture"),
  startLoginCapture: () => invokeIpc<ProfileLoginSession>("profiles:start-login-capture"),
  openLoginCapture: (input: { captureId: string }) => invokeIpc<void>("profiles:open-login-capture", input),
  waitLoginCapture: (input: { captureId: string }) => invokeIpc<ProfileLoginCapture>("profiles:wait-login-capture", input),
  cancelLoginCapture: (input: { captureId: string }) => invokeIpc<void>("profiles:cancel-login-capture", input),
  createProfile: (input: ProfileCreateInput) => invokeIpc<AppState>("profiles:create", input),
  syncCurrentProfile: (input: { name: string }) => invokeIpc<AppState>("profiles:sync-current", input),
  switchProfile: (input: ProfileActionInput) => invokeIpc<SwitchResult>("profiles:switch", input),
  backupProfile: (input: ProfileActionInput) => invokeIpc<AppState>("profiles:backup", input),
  deleteProfile: (input: ProfileActionInput) => invokeIpc<AppState>("profiles:delete", input),
  renameProfile: (input: ProfileActionInput & { name: string }) => invokeIpc<AppState>("profiles:rename", input),
  refreshUsage: (input: ProfileActionInput) => invokeIpc<UsageSnapshot>("usage:refresh", input),
  refreshAllQuotas: () => invokeIpc<AppState>("usage:refresh-all"),
  updateSettings: (input: SettingsUpdateInput) => invokeIpc<AppState>("settings:update", input),
  updateServiceState: (input: ServiceStateInput) => invokeIpc<AppState>("service:update-state", input),
  exportProfiles: (input?: { passphrase?: string }) => invokeIpc<ProfileExportResult>("profiles:export", input),
  previewImport: (input?: { passphrase?: string }) => invokeIpc<ProfileImportPreview | null>("profiles:preview-import", input),
  confirmImport: (input: { path: string; passphrase?: string }) => invokeIpc<ProfileExportResult>("profiles:confirm-import", input),
  openProfileFolder: (input: ProfileActionInput) => invokeIpc<void>("profiles:open-folder", input),
  openLogDirectory: () => invokeIpc<void>("system:open-log-directory"),
  browseExecutable: () => invokeIpc<string | null>("system:browse-executable"),
  checkForUpdates: () => invokeIpc<string>("system:check-updates"),
  needsPassphrase: () => invokeIpc<boolean>("security:needs-passphrase"),
  unlock: (input: { passphrase: string }) => invokeIpc<boolean>("security:unlock", input),
  focusProfile: (listener) => {
    const handler = (_event: IpcRendererEvent, input: ProfileActionInput) => listener(input);
    ipcRenderer.on("profile:focus", handler);
    return () => ipcRenderer.off("profile:focus", handler);
  },
  stateChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.off("state:changed", handler);
  },
  setTheme: (theme: "light" | "dark") => {
    ipcRenderer.send("system:set-theme", { theme });
  }
};

contextBridge.exposeInMainWorld("profileSwitcher", api);
