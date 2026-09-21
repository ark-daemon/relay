export type UsageStatus = "idle" | "loading" | "available" | "unavailable" | "error";

export type AvailabilityStatus = "unknown" | "available" | "at_limit" | "unavailable";

export type QuotaPoolStatus = "available" | "exhausted" | "unavailable";

export interface UsageWindow {
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
}

export interface QuotaPool {
  id: string;
  label: string;
  status: QuotaPoolStatus;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: string;
  refreshAt?: string;
  message?: string;
}

export interface UsageSnapshot {
  status: UsageStatus;
  accountEmail?: string;
  planType?: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  monthly?: UsageWindow;
  credits?: UsageWindow;
  pools?: QuotaPool[];
  checkedAt?: string;
  source?: string;
  message?: string;
}

export interface ProfileManifest {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  planType?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastBackupAt?: string;
  usage?: UsageSnapshot;
}

export interface AvailabilityState {
  profileId: string;
  status: AvailabilityStatus;
  poolStatuses?: Record<string, AvailabilityStatus>;
  lastUsage?: UsageSnapshot;
  updatedAt: string;
}

export interface AppSettings {
  activeProfileId?: string;
  executablePath?: string;
  autoSwitchEnabled: boolean;
  autoSwitchThresholdPercent: number;
  pollingIntervalMinutes: number;
  theme: "system" | "light" | "dark";
  language: string;
  autoRefreshQuota: boolean;
  autoSyncCurrentAccount: boolean;
  syncIntervalMinutes: number;
  startWithSystem: boolean;
  lowQuotaAlerts: boolean;
  notifyWhenAvailable: boolean;
  lowQuotaThresholdPercent: number;
  proxyEnabled: boolean;
  proxyUrl?: string;
  serviceRunning: boolean;
  availabilityByProfile: Record<string, AvailabilityState>;
}

export interface ProfileSummary extends ProfileManifest {
  isActive: boolean;
}

export interface AppState {
  profiles: ProfileSummary[];
  settings: AppSettings;
  defaultExecutablePath: string;
  appInfo: {
    version: string;
    platform: string;
    license: string;
    /** True when Electron safeStorage is available and auth.json files are OS-encrypted. */
    storageEncrypted: boolean;
  };
}

export interface SwitchResult {
  profile: ProfileSummary;
  usage?: UsageSnapshot;
}

export interface ProfileCreateInput {
  captureId: string;
  name: string;
}

export interface ProfileActionInput {
  profileId: string;
}

export interface ExecutablePathInput {
  path: string;
}

export interface SettingsUpdateInput {
  executablePath?: string;
  autoSwitchEnabled?: boolean;
  autoSwitchThresholdPercent?: number;
  pollingIntervalMinutes?: number;
  theme?: "system" | "light" | "dark";
  language?: string;
  autoRefreshQuota?: boolean;
  autoSyncCurrentAccount?: boolean;
  syncIntervalMinutes?: number;
  startWithSystem?: boolean;
  lowQuotaAlerts?: boolean;
  notifyWhenAvailable?: boolean;
  lowQuotaThresholdPercent?: number;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  serviceRunning?: boolean;
}

export interface ServiceStateInput {
  running: boolean;
}

export interface ProfileLoginCapture {
  captureId: string;
  suggestedName?: string;
  accountEmail?: string;
}

export interface ProfileLoginSession {
  captureId: string;
  authorizationUrl: string;
}

export interface ProfileExportResult {
  path?: string;
  count: number;
}

export interface ImportProfileEntry {
  name: string;
  email?: string;
}

export interface ProfileImportPreview {
  path: string;
  profiles: ImportProfileEntry[];
  /** True when the selected export file is passphrase-encrypted. */
  encrypted?: boolean;
}

export interface StatusMessage {
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

export interface ProfileSwitcherApi {
  getState(): Promise<AppState>;
  beginLoginCapture(): Promise<ProfileLoginCapture>;
  startLoginCapture(): Promise<ProfileLoginSession>;
  openLoginCapture(input: { captureId: string }): Promise<void>;
  waitLoginCapture(input: { captureId: string }): Promise<ProfileLoginCapture>;
  cancelLoginCapture(input: { captureId: string }): Promise<void>;
  createProfile(input: ProfileCreateInput): Promise<AppState>;
  syncCurrentProfile(input: { name: string }): Promise<AppState>;
  switchProfile(input: ProfileActionInput): Promise<SwitchResult>;
  backupProfile(input: ProfileActionInput): Promise<AppState>;
  deleteProfile(input: ProfileActionInput): Promise<AppState>;
  renameProfile(input: ProfileActionInput & { name: string }): Promise<AppState>;
  refreshUsage(input: ProfileActionInput): Promise<UsageSnapshot>;
  refreshAllQuotas(): Promise<AppState>;
  updateSettings(input: SettingsUpdateInput): Promise<AppState>;
  updateServiceState(input: ServiceStateInput): Promise<AppState>;
  exportProfiles(input?: { passphrase?: string }): Promise<ProfileExportResult>;
  previewImport(input?: { passphrase?: string }): Promise<ProfileImportPreview | null>;
  confirmImport(input: { path: string; passphrase?: string }): Promise<ProfileExportResult>;
  openProfileFolder(input: ProfileActionInput): Promise<void>;
  openLogDirectory(): Promise<void>;
  browseExecutable(): Promise<string | null>;
  checkForUpdates(): Promise<string>;
  /** True when there is no OS keychain and no session passphrase has been set yet. */
  needsPassphrase(): Promise<boolean>;
  /** Set the in-memory session passphrase used to seal auth files when no keychain exists. */
  unlock(input: { passphrase: string }): Promise<boolean>;
  focusProfile(listener: (input: ProfileActionInput) => void): () => void;
  stateChanged(listener: () => void): () => void;
  setTheme(theme: "light" | "dark"): void;
}
