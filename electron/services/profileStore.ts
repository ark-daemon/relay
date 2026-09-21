import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import electron from "electron";

const { shell } = electron;

let customOpenPath: ((targetPath: string) => Promise<string>) | undefined;

export function setShellOpenPathForTest(fn?: (targetPath: string) => Promise<string>): void {
  customOpenPath = fn;
}
import {
  AppSettings,
  AppState,
  AvailabilityState,
  AvailabilityStatus,
  ProfileActionInput,
  ProfileCreateInput,
  ProfileExportResult,
  ProfileImportPreview,
  ProfileLoginCapture,
  ProfileLoginSession,
  ProfileManifest,
  ProfileSummary,
  SettingsUpdateInput,
  SwitchResult,
  UsageSnapshot
} from "../../src/shared/types.js";
import { findEmail, isEmail, parseJwtPayload, primaryPool, quotaPercent } from "../../src/shared/utils.js";
import { CodexLoginCaptureService } from "./codexLoginCaptureService.js";
import { CodexAuthJson, mirrorCodexProfile } from "./codexProfileMirror.js";
import { copyManagedFromLive, copyManagedLiveToBackup, copyProfileToBackup, restoreManagedToLive } from "./filePlan.js";
import { getAppDefinition, getCodexExecutableCandidates, getDefaultExecutablePath, isAllowedCodexExecutableBasename } from "./paths.js";
import type { AppDefinition } from "./paths.js";
import { ProcessManager } from "./processManager.js";
import { normalizeLowQuotaThreshold, normalizePollingInterval, normalizeSyncInterval, normalizeThreshold, SettingsStore } from "./settingsStore.js";
import { UsageService } from "./usageService.js";
import { decryptKeychainBuffer, isEncryptionAvailable, migrateAuthFile, readAuthFile, writeAuthFile } from "./authStorage.js";
import { BundlePassphraseRequiredError, isEncryptedBundleFile, readBundleFile, writeBundleFile } from "./secureBundle.js";
interface PendingCapture {
  captureId: string;
  suggestedName?: string;
  accountEmail?: string;
  avatarUrl?: string;
  createdAt: string;
}
interface ExportedProfile {
  id: string;
  name: string;
  email?: string;
  planType?: string;
  usage?: UsageSnapshot;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  /** Serialised text content of codex-agent/auth.json, or null if missing. */
  authJson: string | null;
}

interface ExportBundle {
  exportedBy: "relay" | "codex-manager";
  version: "1.0";
  exportedAt: string;
  profiles: ExportedProfile[];
}

interface RawImportProfileEntry {
  id?: string;
  name?: string;
  email?: string;
  planType?: string;
  usage?: UsageSnapshot;
  createdAt?: string;
  updatedAt?: string;
  isActive?: boolean;
  authJson?: string | null;
  manifest?: {
    name?: string;
    email?: string;
    planType?: string;
    usage?: UsageSnapshot;
    createdAt?: string;
  };
}

interface RawExportBundle {
  exportedBy?: string;
  version?: string;
  exportedAt?: string;
  profiles?: RawImportProfileEntry[];
}
const SHARED_GLOBAL_STATE_ARRAY_KEYS = [
  "electron-saved-workspace-roots",
  "active-workspace-roots",
  "project-order",
  "projectless-thread-ids",
  "electron-completed-local-data-migration-ids"
] as const;
const SHARED_GLOBAL_STATE_STRING_RECORD_KEYS = [
  "electron-workspace-root-labels",
  "thread-workspace-root-hints"
] as const;
const SHARED_GLOBAL_STATE_ANY_RECORD_KEYS = [
  "local-projects",
  "thread-project-assignments",
  "thread-writable-roots"
] as const;
const SHARED_GLOBAL_STATE_LIVE_OVERRIDE_KEYS = [
  "selected-project"
] as const;
export class ProfileStore {
  private readonly settingsStore: SettingsStore;
  constructor(
    private readonly storageRoot: string,
    private readonly processManager: ProcessManager,
    private readonly usageService: UsageService,
    private readonly loginCaptureService: CodexLoginCaptureService = new CodexLoginCaptureService()
  ) {
    this.settingsStore = new SettingsStore(storageRoot);
  }
  async initialize(): Promise<void> {
    await fs.mkdir(this.profilesRoot, { recursive: true });
    await fs.mkdir(this.pendingRoot, { recursive: true });
    await fs.mkdir(this.backupsRoot, { recursive: true });
    await hardenDirectoryBestEffort(this.storageRoot);
    // Migrate any plain-text auth.json files left from previous versions.
    await this.migrateAuthFiles();
    // Cap historical switch backups (can grow multi‑GB if left forever).
    await this.pruneOldBackups();
  }
  /**
   * Re-seal any plaintext auth.json files after a session passphrase is set.
   * Called on unlock (no-keyring path) so files that could not be sealed at
   * startup become encrypted as soon as key material is available.
   */
  async resealAfterUnlock(): Promise<void> {
    await this.migrateAuthFiles();
  }
  /** Encrypt all plain-text auth.json files found in managed profile directories. */
  private async migrateAuthFiles(): Promise<void> {
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(this.profilesRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    let migrated = 0;
    for (const id of dirs) {
      const authPath = path.join(this.profilePath(id), "codex-agent", "auth.json");
      const result = await migrateAuthFile(authPath);
      if (result === "encrypted") {
        migrated++;
        console.info(`[authStorage] migrated plain-text auth.json \u2192 encrypted for profile ${id}`);
      }
    }
    if (migrated > 0) {
      console.info(`[authStorage] migration complete \u2014 encrypted ${migrated} auth.json file(s)`);
    }
  }
  async ensureInitialProfiles(): Promise<void> {
    const settings = await this.settingsStore.read();
    const existing = await this.listProfiles(settings);
    const definition = getAppDefinition();
    const agentRoot = definition.sourceRoots.find((root) => root.key === "agent")?.livePath;
    // If live auth exists, always capture or update the matching profile \u2014
    // this handles reinstalls where the user has logged into Codex manually.
    if (agentRoot) {
      const liveAuth = await readLiveAuthJson(path.join(agentRoot, "auth.json"));
      if (liveAuth && !isTokenPermanentlyExpired(liveAuth)) {
        const liveEmail = findEmailFromIdToken(liveAuth);
        const matchingProfile = liveEmail
          ? existing.find((profile) => profile.email?.toLowerCase() === liveEmail.toLowerCase())
          : undefined;
        if (!matchingProfile) {
          // Live account is new \u2014 create a profile for it.
          await this.captureCurrentProfile("Codex current");
        } else {
          // Live account matches an existing profile \u2014 refresh it so the
          // saved tokens are not stale (e.g. after a Codex reinstall).
          await this.captureCurrentProfile(matchingProfile.name);
        }
        return;
      }
    }
    // No live auth \u2014 only auto-capture if there are no profiles at all.
    if (existing.length === 0) {
      const hasLiveState = await Promise.any(
        definition.sourceRoots.map(async (root) => {
          await fs.access(root.livePath);
          return true;
        })
      ).catch(() => false);
      if (hasLiveState) {
        await this.captureCurrentProfile("Codex current");
      }
    }
  }
  async getState(): Promise<AppState> {
    const settings = await this.settingsStore.read();
    const profiles = await this.listProfiles(settings);
    return {
      profiles,
      settings,
      defaultExecutablePath: getDefaultExecutablePath(),
      appInfo: {
        version: electron.app?.getVersion() ?? process.env.npm_package_version ?? "0.1.0",
        platform: process.platform,
        license: "CC BY-NC-SA 4.0",
        storageEncrypted: isEncryptionAvailable()
      }
    };
  }
  async listProfiles(settings?: AppSettings): Promise<ProfileSummary[]> {
    const currentSettings = settings ?? await this.settingsStore.read();
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.profilesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      entries = [];
    }
    const summaries: ProfileSummary[] = [];
    for (const id of entries) {
      const manifest = await this.readManifest(id);
      if (manifest) {
        const authEmail = await this.readProfileAuthEmail(id);
        const email = authEmail ?? manifest.email;
        summaries.push({
          ...manifest,
          name: normalizeDisplayName(manifest.name, email),
          email,
          avatarUrl: undefined,
          isActive: false
        });
      }
    }
    const liveActiveId = await this.reconcileActiveProfileId(currentSettings, summaries);
    for (const summary of summaries) {
      summary.isActive = summary.id === liveActiveId;
    }
    return dedupeProfilesByEmail(summaries).sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      const leftQuota = quotaPercent(left.usage) ?? -1;
      const rightQuota = quotaPercent(right.usage) ?? -1;
      if (leftQuota !== rightQuota) {
        return rightQuota - leftQuota;
      }
      return left.name.localeCompare(right.name);
    });
  }
  async beginLoginCapture(): Promise<ProfileLoginCapture> {
    const session = await this.startLoginCapture();
    await this.openLoginCapture(session.captureId);
    return this.waitLoginCapture(session.captureId);
  }
  async startLoginCapture(): Promise<ProfileLoginSession> {
    return this.loginCaptureService.startCapture();
  }
  async openLoginCapture(captureId: string): Promise<void> {
    await this.loginCaptureService.openLoginPage(captureId);
  }
  async waitLoginCapture(captureId: string): Promise<ProfileLoginCapture> {
    const capture = await this.loginCaptureService.waitForCapture(captureId);
    const metadata = await this.persistPendingCapture(captureId, capture);
    return {
      captureId,
      suggestedName: metadata.suggestedName,
      accountEmail: metadata.accountEmail
    };
  }
  async cancelLoginCapture(captureId: string): Promise<void> {
    await this.loginCaptureService.cancelCapture(captureId).catch(() => undefined);
    await fs.rm(this.pendingPath(captureId), { recursive: true, force: true });
  }
  async createProfile(input: ProfileCreateInput): Promise<AppState> {
    const capture = await this.readPendingCapture(input.captureId);
    const pendingPath = this.pendingPath(input.captureId);
    const displayName = input.name.trim() || capture.suggestedName || capture.accountEmail || "Codex profile";
    const pendingAuthJson = await readAuthJson(path.join(pendingPath, "codex-agent", "auth.json"));
    const captureEmail = capture.accountEmail ?? (pendingAuthJson ? findEmailFromIdToken(pendingAuthJson) : undefined);
    const existing = captureEmail ? await this.findProfileByEmail(captureEmail) : undefined;
    const id = existing?.id ?? createProfileId(displayName);
    const profilePath = this.profilePath(id);
    const now = new Date().toISOString();
    const manifest: ProfileManifest = {
      id,
      name: displayName,
      email: captureEmail,
      avatarUrl: capture.avatarUrl ?? existing?.avatarUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await fs.cp(pendingPath, profilePath, {
      recursive: true,
      force: true,
      errorOnExist: false,
      verbatimSymlinks: true
    });
    await fs.rm(this.pendingMetadataPath(input.captureId), { force: true });
    await fs.rm(path.join(profilePath, "capture.json"), { force: true });
    await this.writeManifest(manifest);
    const authJson = pendingAuthJson ?? await this.readProfileAuthJson(id);
    if (authJson) {
      await mirrorCodexProfile(authJson, manifest.name, captureEmail);
    }
    await this.refreshUsage({ profileId: id });
    await fs.rm(pendingPath, { recursive: true, force: true });
    await this.settingsStore.update((settings) => {
      settings.activeProfileId ??= id;
    });
    return this.getState();
  }
  async syncCurrentProfile(input: { name: string }): Promise<AppState> {
    return this.captureCurrentProfile(input.name.trim() || "Codex current");
  }
  async syncActiveProfileFromLive(): Promise<AppState> {
    const settings = await this.settingsStore.read();
    if (!settings.activeProfileId) {
      return this.getState();
    }
    const manifest = await this.requireManifest(settings.activeProfileId);
    const profilePath = this.profilePath(settings.activeProfileId);
    await fs.mkdir(profilePath, { recursive: true });
    await copyManagedFromLive(getAppDefinition(), profilePath);
    // Re-encrypt auth.json after the raw copy so the profile store
    // never holds plain-text credentials.
    await migrateAuthFile(path.join(profilePath, "codex-agent", "auth.json"));
    const authJson = await this.readProfileAuthJson(settings.activeProfileId);
    const email = authJson ? findEmailFromIdToken(authJson) : manifest.email;
    const avatarUrl = authJson ? findAvatarUrl(authJson) : manifest.avatarUrl;
    await this.writeManifest({
      ...manifest,
      email,
      avatarUrl,
      updatedAt: new Date().toISOString()
    });
    return this.getState();
  }
  private async captureCurrentProfile(name: string): Promise<AppState> {
    const authJson = await readLiveAuthJson(path.join(getAppDefinition().sourceRoots.find((root) => root.key === "agent")?.livePath ?? "", "auth.json"));
    const email = authJson ? findEmailFromIdToken(authJson) : undefined;
    const avatarUrl = authJson ? findAvatarUrl(authJson) : undefined;
    const existing = email ? await this.findProfileByEmail(email) : undefined;
    const id = existing?.id ?? createProfileId(name);
    const profilePath = this.profilePath(id);
    const now = new Date().toISOString();
    const manifest: ProfileManifest = {
      id,
      name: name || email || "Codex current",
      email,
      avatarUrl: avatarUrl ?? existing?.avatarUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    await fs.mkdir(profilePath, { recursive: true });
    await copyManagedFromLive(getAppDefinition(), profilePath);
    // Re-encrypt auth.json after the raw copy so the profile store
    // never holds plain-text credentials.
    await migrateAuthFile(path.join(profilePath, "codex-agent", "auth.json"));
    await this.writeManifest(manifest);
    await this.settingsStore.update((settings) => {
      settings.activeProfileId = id;
    });
    return this.getState();
  }
  async switchProfile(input: ProfileActionInput): Promise<SwitchResult> {
    const definition = getAppDefinition();
    const switchContext = `profile=${input.profileId}`;
    try {
      const manifest = await this.runSwitchStep("loading target profile manifest", switchContext, () => this.requireManifest(input.profileId));
      const settings = await this.runSwitchStep("reading settings", switchContext, () => this.settingsStore.read());
      const executablePath = await this.runSwitchStep("resolving Codex / ChatGPT executable path", switchContext, () =>
        this.resolveExecutablePath(settings.executablePath, definition)
      );
      const profilePath = this.profilePath(input.profileId);
      await this.runSwitchStep("validating target profile folder", switchContext, async () => {
        try {
          await fs.access(profilePath);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Profile folder is not accessible: ${profilePath}. ${detail}`);
        }
      });
      let targetAuthJson = await this.runSwitchStep("validating source profile auth", switchContext, () =>
        this.requireProfileAuthJson(input.profileId)
      );
      if (isTokenExpired(targetAuthJson)) {
        console.warn(`[Relay switch] ${switchContext}: target auth token is expired — attempting refresh`);
        const refreshToken = targetAuthJson.tokens?.refresh_token;
        if (refreshToken) {
          try {
            const refreshed = await this.runSwitchStep("refreshing expired auth token", switchContext, () =>
              this.usageService.tryRefreshToken(refreshToken)
            );
            if (refreshed) {
              targetAuthJson = {
                ...targetAuthJson,
                tokens: {
                  ...targetAuthJson.tokens,
                  account_id: targetAuthJson.tokens?.account_id,
                  access_token: refreshed.accessToken,
                  id_token: refreshed.idToken ?? targetAuthJson.tokens?.id_token,
                  refresh_token: refreshed.refreshToken ?? refreshToken
                },
                last_refresh: new Date().toISOString()
              };
              await writeAuthFile(
                path.join(profilePath, "codex-agent", "auth.json"),
                `${JSON.stringify(targetAuthJson, null, 2)}\n`
              );
            } else {
              console.warn(`[Relay switch] ${switchContext}: token refresh failed or timed out — continuing with stored credentials so Codex can refresh session on launch`);
            }
          } catch (error) {
            console.warn(`[Relay switch] ${switchContext}: silent token refresh error — continuing switch:`, error);
          }
        } else {
          console.warn(`[Relay switch] ${switchContext}: no refresh_token found on expired profile — continuing switch`);
        }
      }
      await this.runSwitchStep("closing Codex / ChatGPT", switchContext, () => this.processManager.close(definition));
      // Note: we previously waited 1500ms here to let SQLite WAL writes flush
      // before capturing state_5.sqlite. That file is now shared across accounts
      // and never swapped \u2014 so this delay is no longer needed. Auth writes
      // (auth.json) are synchronous and complete before Codex exits.
      // Save the current active profile's live state back to its profile folder
      // AFTER closing Codex so sqlite WAL files are fully checkpointed and the
      // databases are in a clean, copyable state.
      await this.runSwitchStep("saving current profile", switchContext, async () => {
        const previousActiveId = settings.activeProfileId;
        if (previousActiveId && previousActiveId !== input.profileId) {
          const previousPath = this.profilePath(previousActiveId);
          try {
            await fs.access(previousPath);
            // Raw-copy all live files (including plain-text auth.json from Codex's dir)
            // into the previous profile's store.
            await copyManagedFromLive(definition, previousPath);
            // Re-encrypt the just-copied plain-text auth.json so the profile store
            // always contains encrypted credentials, never plain text.
            const prevAuthPath = path.join(previousPath, "codex-agent", "auth.json");
            await migrateAuthFile(prevAuthPath);
            console.info(`[Relay switch] saved live state back to profile ${previousActiveId}`);
          } catch {
            // Previous profile folder gone \u2014 skip silently.
            console.warn(`[Relay switch] could not save previous profile ${previousActiveId} \u2014 skipping`);
          }
        }
      });
      await this.runSwitchStep("backing up current live profile", switchContext, () => this.backupLiveState());
      const sharedProjectState = await this.runSwitchStep("preserving shared Codex project state", switchContext, () =>
        this.buildSharedCodexProjectState(definition, profilePath)
      );
      const sharedPluginConfig = await this.runSwitchStep("preserving shared Codex plugin config", switchContext, () =>
        this.buildSharedCodexPluginConfig(definition, profilePath)
      );
      // Restore all profile files EXCEPT auth.json, profiles.json, and the
      // profiles/ directory. auth.json is always encrypted in the profile store
      // and must be decrypted before Codex can read it. profiles.json and
      // profiles/ are rebuilt by mirrorCodexProfile (called from
      // writeReadableLiveAuth) so that stale native-account state from the
      // managed profile does not overwrite the live state that Codex may have
      // updated during the previous session.
      await this.runSwitchStep("copying selected profile files into Codex live paths", switchContext, () =>
        restoreManagedToLive(definition, profilePath, ["auth.json", "profiles.json", "profiles"])
      );
      if (sharedProjectState) {
        await this.runSwitchStep("restoring shared Codex project state", switchContext, () =>
          this.writeSharedCodexProjectState(definition, profilePath, sharedProjectState)
        );
      }
      if (sharedPluginConfig) {
        await this.runSwitchStep("restoring shared Codex plugin config", switchContext, () =>
          this.writeSharedCodexPluginConfig(definition, profilePath, sharedPluginConfig)
        );
      }
      await this.runSwitchStep("activating selected Codex account", switchContext, () =>
        this.writeReadableLiveAuth(definition, manifest, targetAuthJson)
      );
      await this.runSwitchStep("marking active profile", switchContext, async () => {
        const now = new Date().toISOString();
        await this.writeManifest({ ...manifest, lastUsedAt: now, updatedAt: now });
        await this.settingsStore.update((nextSettings) => {
          nextSettings.activeProfileId = input.profileId;
        });
      });
      await this.runSwitchStep("waiting before Codex relaunch", switchContext, () => delay(500));
      await this.runSwitchStep("relaunching Codex / ChatGPT", switchContext, () => this.processManager.launch(executablePath, definition));
      // Return immediately so the UI unblocks \u2014 quota refresh is a network call
      // that can take 30\u201360 s and is not needed for the switch to be usable.
      const state = await this.getState();
      const profile = state.profiles.find((item) => item.id === input.profileId);
      // Run quota refresh in the background; the UI will pick it up on the next
      // state-changed broadcast triggered by the refresh persisting to disk.
      void this.refreshCodexUsageFromLive(input).then(() => {
        console.info(`[Relay switch] background quota refresh complete for ${input.profileId}`);
      }).catch((err: Error | string | null | undefined) => {
        console.warn(`[Relay switch] background quota refresh failed: ${err}`);
      });
      return { profile: profile ?? { ...manifest, isActive: true } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Relay switch] failed ${switchContext}: ${message}`, error);
      throw error instanceof Error ? error : new Error(message);
    }
  }
  private async resolveExecutablePath(configuredPath: string | undefined, definition: AppDefinition): Promise<string> {
    const candidates = uniqueStrings([
      configuredPath,
      definition.defaultExecutablePath,
      ...getCodexExecutableCandidates()
    ].filter((candidate): candidate is string => Boolean(candidate?.trim())));
    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        if (configuredPath && candidate !== configuredPath) {
          console.warn(`[Relay switch] configured Codex / ChatGPT executable was unavailable, using detected path: ${candidate}`);
        }
        return candidate;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate} (${detail})`);
      }
    }
    const configured = configuredPath ? `Saved setting: ${configuredPath}. ` : "";
    throw new Error(
      `Codex / ChatGPT executable could not be found. ${configured}Checked: ${failures.join("; ")}. ` +
      "Open Settings > Codex / ChatGPT > Executable and choose ChatGPT.exe or Codex.exe."
    );
  }
  async backupProfile(input: ProfileActionInput): Promise<AppState> {
    const manifest = await this.requireManifest(input.profileId);
    const now = new Date().toISOString();
    const backupPath = path.join(this.backupsRoot, `${timestampForPath(now)}-${input.profileId}`);
    await copyProfileToBackup(this.profilePath(input.profileId), backupPath);
    await this.pruneOldBackups();
    await this.writeManifest({ ...manifest, updatedAt: now, lastBackupAt: now });
    return this.getState();
  }
  async deleteProfile(input: ProfileActionInput): Promise<AppState> {
    await fs.rm(this.profilePath(input.profileId), { recursive: true, force: true });
    await this.settingsStore.update((settings) => {
      if (settings.activeProfileId === input.profileId) {
        delete settings.activeProfileId;
      }
      delete settings.availabilityByProfile[input.profileId];
    });
    return this.getState();
  }
  async renameProfile(input: ProfileActionInput & { name: string }): Promise<AppState> {
    const manifest = await this.requireManifest(input.profileId);
    await this.writeManifest({
      ...manifest,
      name: input.name.trim() || manifest.name,
      updatedAt: new Date().toISOString()
    });
    return this.getState();
  }
  async updateSettings(input: SettingsUpdateInput): Promise<AppState> {
    await this.settingsStore.update((settings) => {
      if (input.executablePath !== undefined) {
        if (input.executablePath) {
          const basename = path.basename(input.executablePath);
          if (!isAllowedCodexExecutableBasename(basename)) {
            throw new Error("Invalid executable path: File name must be 'Codex', 'Codex.exe', 'ChatGPT', or 'ChatGPT.exe'");
          }
        }
        settings.executablePath = input.executablePath;
      }
      if (input.autoSwitchEnabled !== undefined) {
        settings.autoSwitchEnabled = input.autoSwitchEnabled;
      }
      if (input.autoSwitchThresholdPercent !== undefined) {
        settings.autoSwitchThresholdPercent = normalizeThreshold(input.autoSwitchThresholdPercent);
      }
      if (input.pollingIntervalMinutes !== undefined) {
        settings.pollingIntervalMinutes = normalizePollingInterval(input.pollingIntervalMinutes);
      }
      if (input.theme !== undefined) {
        settings.theme = input.theme;
      }
      if (input.language !== undefined) {
        settings.language = input.language.trim() || settings.language;
      }
      if (input.autoRefreshQuota !== undefined) {
        settings.autoRefreshQuota = input.autoRefreshQuota;
      }
      if (input.autoSyncCurrentAccount !== undefined) {
        settings.autoSyncCurrentAccount = input.autoSyncCurrentAccount;
      }
      if (input.syncIntervalMinutes !== undefined) {
        settings.syncIntervalMinutes = normalizeSyncInterval(input.syncIntervalMinutes);
      }
      if (input.startWithSystem !== undefined) {
        settings.startWithSystem = input.startWithSystem;
      }
      if (input.lowQuotaAlerts !== undefined) {
        settings.lowQuotaAlerts = input.lowQuotaAlerts;
      }
      if (input.notifyWhenAvailable !== undefined) {
        settings.notifyWhenAvailable = input.notifyWhenAvailable;
      }
      if (input.lowQuotaThresholdPercent !== undefined) {
        settings.lowQuotaThresholdPercent = normalizeLowQuotaThreshold(input.lowQuotaThresholdPercent);
      }
      if (input.proxyEnabled !== undefined) {
        settings.proxyEnabled = input.proxyEnabled;
      }
      if (input.proxyUrl !== undefined) {
        settings.proxyUrl = input.proxyUrl.trim();
      }
      if (input.serviceRunning !== undefined) {
        settings.serviceRunning = input.serviceRunning;
      }
    });
    return this.getState();
  }
  async setServiceRunning(running: boolean): Promise<AppState> {
    await this.settingsStore.update((settings) => {
      settings.serviceRunning = running;
    });
    return this.getState();
  }
  async refreshUsage(input: ProfileActionInput): Promise<UsageSnapshot> {
    const manifest = await this.requireManifest(input.profileId);
    const settings = await this.settingsStore.read();
    const profiles = await this.listProfilesWithoutDedupe();
    const activeProfileId = await this.reconcileActiveProfileId(settings, profiles);
    const snapshot = activeProfileId === input.profileId
      ? await this.readLiveCodexUsage()
      : await this.usageService.refreshForProfile(this.profilePath(input.profileId));
    // Don't persist transient failures \u2014 "error" is a network/timeout issue and
    // "unavailable" is typically a temporary API format mismatch or auth problem.
    // Either way we keep the last known-good snapshot on disk so the UI doesn't
    // flash "Quota unavailable" just because one refresh round-trip failed.
    if (snapshot.status === "error" || snapshot.status === "unavailable") {
      return snapshot;
    }
    await this.persistUsage(input, manifest, snapshot);
    return snapshot;
  }
  private async refreshCodexUsageFromLive(input: ProfileActionInput): Promise<UsageSnapshot> {
    const manifest = await this.requireManifest(input.profileId);
    const snapshot = await this.readLiveCodexUsage();
    await this.persistUsage(input, manifest, snapshot);
    return snapshot;
  }
  private async readLiveCodexUsage(): Promise<UsageSnapshot> {
    const agentRoot = getAppDefinition().sourceRoots.find((root) => root.key === "agent");
    const authPath = path.join(agentRoot?.livePath ?? "", "auth.json");
    return this.usageService.refreshForAuthPath(authPath, { skipAutoEncrypt: true });
  }
  private async persistUsage(input: ProfileActionInput, manifest: ProfileManifest, snapshot: UsageSnapshot): Promise<void> {
    const status = this.usageService.deriveAvailability(snapshot);
    const authEmail = await this.readProfileAuthEmail(input.profileId);
    const nextManifest: ProfileManifest = {
      ...manifest,
      email: authEmail ?? manifest.email,
      usage: snapshot,
      updatedAt: new Date().toISOString()
    };
    await this.writeManifest(nextManifest);
    await this.settingsStore.update((settings) => {
      settings.availabilityByProfile[input.profileId] = {
        profileId: input.profileId,
        status,
        poolStatuses: poolStatusesFromSnapshot(snapshot),
        lastUsage: snapshot,
        updatedAt: new Date().toISOString()
      };
    });
  }
  async refreshAllUsage(): Promise<Array<{
    profile: ProfileSummary;
    before: string;
    after: string;
    usage: UsageSnapshot;
    becameAvailable: boolean;
    lowQuotaCrossed: boolean;
    lowQuotaPercent?: number;
  }>> {
    const settings = await this.settingsStore.read();
    const profiles = await this.listProfiles(settings);
    const transitions: Array<{
      profile: ProfileSummary;
      before: string;
      after: string;
      usage: UsageSnapshot;
      becameAvailable: boolean;
      lowQuotaCrossed: boolean;
      lowQuotaPercent?: number;
    }> = [];
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      if (i > 0) {
        await delay(200);
      }
      const previousState = settings.availabilityByProfile[profile.id];
      const previous = previousState?.status ?? "unknown";
      const previousPercent = quotaPercent(previousState?.lastUsage);
      const usage = await this.refreshUsage({ profileId: profile.id });
      const after = this.usageService.deriveAvailability(usage);
      const currentPercent = quotaPercent(usage);
      const lowQuotaCrossed = (
        settings.lowQuotaAlerts
        && currentPercent !== undefined
        && currentPercent <= settings.lowQuotaThresholdPercent
        && (previousPercent === undefined || previousPercent > settings.lowQuotaThresholdPercent)
      );
      transitions.push({
        profile,
        before: previous,
        after,
        usage,
        becameAvailable: becameAvailable(previousState, after, usage),
        lowQuotaCrossed,
        lowQuotaPercent: currentPercent
      });
    }
    return transitions;
  }
  async autoSwitchIfNeeded(): Promise<SwitchResult | undefined> {
    const settings = await this.settingsStore.read();
    if (!settings.autoSwitchEnabled || !settings.activeProfileId) {
      return undefined;
    }
    const profiles = await this.listProfiles(settings);
    const active = profiles.find((profile) => profile.id === settings.activeProfileId);
    if (!active || !shouldAutoSwitch(active.usage, settings.autoSwitchThresholdPercent)) {
      return undefined;
    }
    const nextProfile = profiles.find((profile) => profile.id !== active.id && isReady(profile.usage, settings.autoSwitchThresholdPercent));
    if (!nextProfile) {
      return undefined;
    }
    return this.switchProfile({ profileId: nextProfile.id });
  }
  async exportProfilesTo(filePath: string, passphrase?: string): Promise<ProfileExportResult> {
    if (!passphrase || passphrase.trim().length === 0) {
      throw new Error("A passphrase is required to export accounts. Exports are always encrypted.");
    }
    const profiles = await this.listProfiles();
    const activeProfileId = (await this.settingsStore.read()).activeProfileId;
    const bundle: ExportBundle = {
      exportedBy: "relay",
      version: "1.0",
      exportedAt: new Date().toISOString(),
      profiles: []
    };
    for (const profile of profiles) {
      const manifest = await this.requireManifest(profile.id);
      // Decrypt auth.json before serialising so the in-memory bundle is portable
      // JSON. The whole file is then sealed by writeBundleFile — tokens never
      // touch disk in the clear.
      const authJsonPath = path.join(this.profilePath(profile.id), "codex-agent", "auth.json");
      const authJson = await readAuthFile(authJsonPath) ?? null;
      bundle.profiles.push({
        id: manifest.id,
        name: manifest.name,
        email: manifest.email,
        planType: manifest.planType,
        usage: manifest.usage,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        isActive: manifest.id === activeProfileId,
        authJson
      });
    }
    await writeBundleFile(filePath, bundle, passphrase.trim());
    return { path: filePath, count: bundle.profiles.length };
  }
  /**
   * Validate and preview an export file without writing anything.
   * Returns the list of profiles found so the UI can show a confirmation dialog.
   * When the file is encrypted and no (or a wrong) passphrase is supplied, the
   * preview is returned with `encrypted: true` and no profiles so the UI can
   * prompt for a passphrase. Throws a user-friendly error for invalid files.
   */
  async previewImportFrom(filePath: string, passphrase?: string): Promise<ProfileImportPreview> {
    const encrypted = await isEncryptedBundleFile(filePath);
    let bundle: RawExportBundle | undefined;
    try {
      bundle = await readBundleFile<RawExportBundle>(filePath, passphrase);
    } catch (err) {
      if (err instanceof BundlePassphraseRequiredError) {
        return { path: filePath, profiles: [], encrypted: true };
      }
      throw err instanceof Error ? err : new Error("Could not read the selected file. Make sure it is a valid JSON file.");
    }
    if (!bundle || (bundle.exportedBy !== "relay" && bundle.exportedBy !== "codex-manager") || !Array.isArray(bundle.profiles)) {
      throw new Error("This file doesn't look like a Relay export.");
    }
    const profiles = bundle.profiles.flatMap((e) => {
      if (!e) return [];
      const legacy = e.manifest;
      const name = String((e.name ?? legacy?.name) || "Unnamed profile");
      const email = e.email ?? legacy?.email;
      return [{ name, email: email ? String(email) : undefined }];
    });
    if (profiles.length === 0) {
      throw new Error("The export file contains no profiles.");
    }
    return { path: filePath, profiles, encrypted };
  }

  async importProfilesFrom(filePath: string, passphrase?: string): Promise<ProfileExportResult> {
    // Re-validate before writing — defence against calling importProfilesFrom without a prior preview.
    let bundle: RawExportBundle | undefined;
    try {
      bundle = await readBundleFile<RawExportBundle>(filePath, passphrase);
    } catch (err) {
      if (err instanceof BundlePassphraseRequiredError) {
        throw err;
      }
      throw err instanceof Error ? err : new Error("Could not read the selected file.");
    }
    if (!bundle || (bundle.exportedBy !== "relay" && bundle.exportedBy !== "codex-manager") || !Array.isArray(bundle.profiles)) {
      throw new Error("This file doesn't look like a Relay export.");
    }
    let count = 0;
    const importedAvailabilities: Record<string, AvailabilityState> = {};
    for (const e of bundle.profiles) {
      if (!e) continue;
      // Support both the new v2 shape and the old v1 shape (which had a nested manifest).
      const legacy = e.manifest;
      const name = String((e.name ?? legacy?.name) || "Imported Codex profile");
      const email = e.email ?? legacy?.email;
      const planType = e.planType ?? legacy?.planType;
      const usage = e.usage ?? legacy?.usage;
      const createdAt = String(e.createdAt ?? legacy?.createdAt ?? new Date().toISOString());
      // Generate a stable but unique profile id for the target store.
      const id = createProfileId(name);
      const profilePath = this.profilePath(id);
      await fs.rm(profilePath, { recursive: true, force: true });
      await fs.mkdir(profilePath, { recursive: true });
      // Restore auth.json — write encrypted so the imported profile is
      // immediately protected by the same OS keychain as native profiles.
      const authJsonText = e.authJson ?? null;
      if (authJsonText !== null) {
        const agentDir = path.join(profilePath, "codex-agent");
        await fs.mkdir(agentDir, { recursive: true });
        await writeAuthFile(path.join(agentDir, "auth.json"), authJsonText);
      }
      await this.writeManifest({
        id,
        name,
        email: email ? String(email) : undefined,
        planType: planType ? String(planType) : undefined,
        usage: usage ? usage : undefined,
        createdAt,
        updatedAt: new Date().toISOString()
      });
      if (usage) {
        importedAvailabilities[id] = {
          profileId: id,
          status: this.usageService.deriveAvailability(usage),
          poolStatuses: poolStatusesFromSnapshot(usage),
          lastUsage: usage,
          updatedAt: new Date().toISOString()
        };
      }
      count += 1;
    }
    // Do NOT auto-activate any profile — all imported profiles start as READY.
    // The user activates one explicitly by clicking USE.
    await this.settingsStore.update((settings) => {
      delete settings.activeProfileId;
      for (const [id, avail] of Object.entries(importedAvailabilities)) {
        settings.availabilityByProfile[id] = avail;
      }
    });
    return { path: filePath, count };
  }
  async openProfileFolder(input: ProfileActionInput): Promise<void> {
    const target = this.profilePath(input.profileId);
    if (customOpenPath) {
      await customOpenPath(target);
      return;
    }
    await shell.openPath(target);
  }
  getProfilePath(input: ProfileActionInput): string {
    return this.profilePath(input.profileId);
  }
  private get profilesRoot(): string {
    return path.join(this.storageRoot, "profiles");
  }
  private get pendingRoot(): string {
    return path.join(this.storageRoot, "pending");
  }
  private get backupsRoot(): string {
    return path.join(this.storageRoot, "backups", "codex");
  }
  private profilePath(profileId: string): string {
    if (!profileId || !/^[a-z0-9-]+$/i.test(profileId)) {
      throw new Error("Access Denied: Invalid profile identifier.");
    }
    return path.join(this.profilesRoot, profileId);
  }
  private pendingPath(captureId: string): string {
    if (!captureId || !/^[a-z0-9-]+$/i.test(captureId)) {
      throw new Error("Access Denied: Invalid capture identifier.");
    }
    return path.join(this.pendingRoot, captureId);
  }
  private manifestPath(profileId: string): string {
    return path.join(this.profilePath(profileId), "manifest.json");
  }
  private pendingMetadataPath(captureId: string): string {
    return path.join(this.pendingPath(captureId), "capture.json");
  }
  private async backupLiveState(): Promise<void> {
    const now = new Date().toISOString();
    const backupPath = path.join(this.backupsRoot, `${timestampForPath(now)}-live`);
    await copyManagedLiveToBackup(getAppDefinition(), backupPath);
    await this.pruneOldBackups();
  }
  private async pruneOldBackups(): Promise<void> {
    try {
      const maxBackups = 10;
      const entries = await fs.readdir(this.backupsRoot, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(); // Lexicographical sort puts older timestamps first
      if (directories.length > maxBackups) {
        const toDelete = directories.slice(0, directories.length - maxBackups);
        for (const dirName of toDelete) {
          const dirPath = path.join(this.backupsRoot, dirName);
          await fs.rm(dirPath, { recursive: true, force: true });
        }
      }
    } catch (error) {
      console.error("Failed to prune old backups:", error);
    }
  }
  private codexGlobalStatePaths(definition: AppDefinition, profilePath: string): { livePath: string; storedPath: string } | undefined {
    const agentRoot = definition.sourceRoots.find((root) => root.key === "agent");
    if (!agentRoot) {
      return undefined;
    }
    return {
      livePath: path.join(agentRoot.livePath, ".codex-global-state.json"),
      storedPath: path.join(profilePath, agentRoot.profileFolder, ".codex-global-state.json")
    };
  }
  private codexConfigPaths(definition: AppDefinition, profilePath: string): { livePath: string; storedPath: string } | undefined {
    const agentRoot = definition.sourceRoots.find((root) => root.key === "agent");
    if (!agentRoot) {
      return undefined;
    }
    return {
      livePath: path.join(agentRoot.livePath, "config.toml"),
      storedPath: path.join(profilePath, agentRoot.profileFolder, "config.toml")
    };
  }
  private async buildSharedCodexProjectState(definition: AppDefinition, profilePath: string): Promise<CodexGlobalState | undefined> {
    const paths = this.codexGlobalStatePaths(definition, profilePath);
    if (!paths) {
      return undefined;
    }
    const liveState = await readJsonObject(paths.livePath);
    const targetState = await readJsonObject(paths.storedPath);
    if (!hasSharedProjectState(liveState) && !hasSharedProjectState(targetState)) {
      return undefined;
    }
    return mergeSharedProjectState(targetState, liveState);
  }

  private async writeSharedCodexProjectState(definition: AppDefinition, profilePath: string, state: CodexGlobalState): Promise<void> {
    const paths = this.codexGlobalStatePaths(definition, profilePath);
    if (!paths) {
      return;
    }
    const content = `${JSON.stringify(state)}\n`;
    await fs.mkdir(path.dirname(paths.livePath), { recursive: true });
    await fs.writeFile(paths.livePath, content, "utf8");
    await fs.mkdir(path.dirname(paths.storedPath), { recursive: true });
    await fs.writeFile(paths.storedPath, content, "utf8");
  }

  private async buildSharedCodexPluginConfig(definition: AppDefinition, profilePath: string): Promise<string | undefined> {
    const paths = this.codexConfigPaths(definition, profilePath);
    if (!paths) {
      return undefined;
    }
    const liveConfig = await readTextFile(paths.livePath);
    const targetConfig = await readTextFile(paths.storedPath);
    if (!hasSharedPluginConfig(liveConfig) && !hasSharedPluginConfig(targetConfig)) {
      return undefined;
    }
    return mergeSharedPluginConfig(targetConfig, liveConfig);
  }

  private async writeSharedCodexPluginConfig(definition: AppDefinition, profilePath: string, config: string): Promise<void> {
    const paths = this.codexConfigPaths(definition, profilePath);
    if (!paths) {
      return;
    }
    await fs.mkdir(path.dirname(paths.livePath), { recursive: true });
    await fs.writeFile(paths.livePath, config, "utf8");
    await fs.mkdir(path.dirname(paths.storedPath), { recursive: true });
    await fs.writeFile(paths.storedPath, config, "utf8");
  }

  private async runSwitchStep<T>(step: string, context: string, action: () => Promise<T>): Promise<T> {
    console.info(`[Relay switch] ${context}: ${step}...`);
    try {
      const result = await action();
      console.info(`[Relay switch] ${context}: ${step} complete`);
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Relay switch] ${context}: ${step} failed: ${detail}`, error);
      throw new Error(`Switch failed while ${step}: ${detail}`);
    }
  }

  private async readManifest(profileId: string): Promise<ProfileManifest | undefined> {
    try {
      // SAFETY: JSON parsed from manifest file adheres to ProfileManifest interface
      return JSON.parse(await fs.readFile(this.manifestPath(profileId), "utf8")) as ProfileManifest;
    } catch {
      return undefined;
    }
  }

  private async requireManifest(profileId: string): Promise<ProfileManifest> {
    const manifest = await this.readManifest(profileId);
    if (!manifest) {
      throw new Error(`Profile ${profileId} was not found.`);
    }
    return manifest;
  }

  private async readPendingCapture(captureId: string): Promise<PendingCapture> {
    try {
      // SAFETY: JSON parsed from pending capture metadata file matches PendingCapture shape
      return JSON.parse(await fs.readFile(this.pendingMetadataPath(captureId), "utf8")) as PendingCapture;
    } catch {
      throw new Error("Login capture was not found. Please add the account again.");
    }
  }

  private async readProfileAuthJson(profileId: string): Promise<CodexAuthJson | undefined> {
    const authPath = path.join(this.profilePath(profileId), "codex-agent", "auth.json");
    const exists = await fs.access(authPath).then(() => true).catch(() => false);
    console.log(`[ProfileStore] reading auth.json profile=${profileId} path=${authPath} exists=${exists}`);
    const text = await readAuthFile(authPath);
    if (!text) return undefined;
    try {
      // SAFETY: decrypted auth.json contents match CodexAuthJson structure
      return JSON.parse(text) as CodexAuthJson;
    } catch {
      return undefined;
    }
  }
  private async requireProfileAuthJson(profileId: string): Promise<CodexAuthJson> {
    const authPath = path.join(this.profilePath(profileId), "codex-agent", "auth.json");
    const authJson = await this.readProfileAuthJson(profileId);
    if (!authJson) {
      throw new Error(`Profile auth.json is missing, encrypted with an unavailable key, or not valid JSON: ${authPath}`);
    }
    return authJson;
  }
  private async writeReadableLiveAuth(definition: AppDefinition, manifest: ProfileManifest, authJson: CodexAuthJson): Promise<void> {
    const agentRoot = definition.sourceRoots.find((root) => root.key === "agent")?.livePath;
    if (!agentRoot) {
      throw new Error("Codex live profile directory is not configured.");
    }
    await fs.mkdir(agentRoot, { recursive: true });
    await fs.writeFile(path.join(agentRoot, "auth.json"), `${JSON.stringify(authJson, null, 2)}\n`, "utf8");
    const email = findEmailFromIdToken(authJson) ?? manifest.email;
    await mirrorCodexProfile(authJson, manifest.name, email);
  }
  private async readProfileAuthEmail(profileId: string): Promise<string | undefined> {
    const authJson = await this.readProfileAuthJson(profileId);
    return authJson ? findEmailFromIdToken(authJson) : undefined;
  }
  private async findProfileMatchingLiveAuth(profiles: ProfileSummary[]): Promise<string | undefined> {
    const agentRoot = getAppDefinition().sourceRoots.find((root) => root.key === "agent")?.livePath;
    if (!agentRoot) {
      return undefined;
    }
    const liveAuth = await readLiveAuthJson(path.join(agentRoot, "auth.json"));
    if (!liveAuth || isTokenPermanentlyExpired(liveAuth)) {
      return undefined;
    }
    const liveEmail = findEmailFromIdToken(liveAuth)?.toLowerCase();
    if (!liveEmail) {
      return undefined;
    }
    return profiles.find((profile) => profile.email?.toLowerCase() === liveEmail)?.id;
  }
  private async reconcileActiveProfileId(settings: AppSettings, profiles: ProfileSummary[]): Promise<string | undefined> {
    const agentRoot = getAppDefinition().sourceRoots.find((root) => root.key === "agent")?.livePath;
    const liveAuth = agentRoot ? await readLiveAuthJson(path.join(agentRoot, "auth.json")) : undefined;
    // If Codex has no live auth at all or its tokens are permanently expired (no refresh token),
    // nothing is active. Clear the stale activeProfileId so profiles
    // do not falsely show the green "Active" border.
    if (!liveAuth || isTokenPermanentlyExpired(liveAuth)) {
      if (settings.activeProfileId !== undefined) {
        await this.settingsStore.update((nextSettings) => {
          nextSettings.activeProfileId = undefined;
        });
      }
      return undefined;
    }
    const configuredActiveId = profiles.some((summary) => summary.id === settings.activeProfileId)
      ? settings.activeProfileId
      : undefined;
    const liveActiveId = await this.findProfileMatchingLiveAuth(profiles);
    const activeProfileId = liveActiveId ?? configuredActiveId;
    if (liveActiveId && liveActiveId !== settings.activeProfileId) {
      settings.activeProfileId = liveActiveId;
      await this.settingsStore.update((nextSettings) => {
        nextSettings.activeProfileId = liveActiveId;
      });
      const manifest = await this.readManifest(liveActiveId);
      if (manifest) {
        await this.writeManifest({ ...manifest, lastUsedAt: new Date().toISOString() });
      }
    }
    return activeProfileId;
  }
  private async findProfileByEmail(email: string): Promise<ProfileManifest | undefined> {
    const target = email.toLowerCase();
    const profiles = await this.listProfilesWithoutDedupe();
    return profiles.find((profile) => profile.email?.toLowerCase() === target);
  }
  private async listProfilesWithoutDedupe(): Promise<ProfileSummary[]> {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(this.profilesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      entries = [];
    }
    const summaries: ProfileSummary[] = [];
    for (const id of entries) {
      const manifest = await this.readManifest(id);
      if (manifest) {
        const authEmail = await this.readProfileAuthEmail(id);
        const email = authEmail ?? manifest.email;
        summaries.push({
          ...manifest,
          name: normalizeDisplayName(manifest.name, email),
          email,
          avatarUrl: undefined,
          isActive: false
        });
      }
    }
    return summaries;
  }
  private async writeManifest(manifest: ProfileManifest): Promise<void> {
    await fs.mkdir(this.profilePath(manifest.id), { recursive: true });
    await fs.writeFile(this.manifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  private async persistPendingCapture(captureId: string, capture: { authJson: CodexAuthJson; accountEmail?: string; avatarUrl?: string }): Promise<PendingCapture> {
    const pendingPath = this.pendingPath(captureId);
    const metadata: PendingCapture = {
      captureId,
      accountEmail: capture.accountEmail,
      avatarUrl: capture.avatarUrl,
      suggestedName: capture.accountEmail ?? "Codex profile",
      createdAt: new Date().toISOString()
    };
    await fs.mkdir(pendingPath, { recursive: true });
    await fs.mkdir(path.join(pendingPath, "codex-agent"), { recursive: true });
    await writeAuthFile(
      path.join(pendingPath, "codex-agent", "auth.json"),
      `${JSON.stringify(capture.authJson, null, 2)}\n`
    );
    await fs.writeFile(this.pendingMetadataPath(captureId), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  }
}
function createProfileId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 32);
  return `${slug || "profile"}-${crypto.randomUUID().slice(0, 8)}`;
}
function dedupeProfilesByEmail(profiles: ProfileSummary[]): ProfileSummary[] {
  const byEmail = new Map<string, ProfileSummary>();
  const withoutEmail: ProfileSummary[] = [];
  for (const profile of profiles) {
    const key = profile.email?.trim().toLowerCase();
    if (!key) {
      withoutEmail.push(profile);
      continue;
    }
    const existing = byEmail.get(key);
    if (!existing || shouldPreferProfile(profile, existing)) {
      byEmail.set(key, profile);
    }
  }
  return [...byEmail.values(), ...withoutEmail];
}
function shouldPreferProfile(candidate: ProfileSummary, current: ProfileSummary): boolean {
  if (candidate.isActive !== current.isActive) {
    return candidate.isActive;
  }
  const candidateQuota = quotaPercent(candidate.usage) ?? -1;
  const currentQuota = quotaPercent(current.usage) ?? -1;
  if (candidateQuota !== currentQuota) {
    return candidateQuota > currentQuota;
  }
  return new Date(candidate.updatedAt).getTime() > new Date(current.updatedAt).getTime();
}
function timestampForPath(value: string): string {
  return value.replace(/[:.]/g, "-");
}
export interface CodexGlobalState {
  "electron-saved-workspace-roots"?: string[];
  "active-workspace-roots"?: string[];
  "project-order"?: string[];
  "projectless-thread-ids"?: string[];
  "electron-completed-local-data-migration-ids"?: string[];
  "electron-workspace-root-labels"?: Record<string, string>;
  "thread-workspace-root-hints"?: Record<string, string>;
  "local-projects"?: Record<string, string>;
  "thread-project-assignments"?: Record<string, string>;
  "thread-writable-roots"?: Record<string, string>;
  "selected-project"?: string;
}

async function readJsonObject(filePath: string): Promise<CodexGlobalState> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    // SAFETY: JSON parsed from Codex global state file is cast to CodexGlobalState interface
    const parsed = JSON.parse(raw) as CodexGlobalState;
    return parsed ? parsed : {};
  } catch {
    return {};
  }
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function hasSharedProjectState(state: CodexGlobalState): boolean {
  return [
    ...SHARED_GLOBAL_STATE_ARRAY_KEYS,
    ...SHARED_GLOBAL_STATE_STRING_RECORD_KEYS,
    ...SHARED_GLOBAL_STATE_ANY_RECORD_KEYS,
    ...SHARED_GLOBAL_STATE_LIVE_OVERRIDE_KEYS
  ].some((key) => state[key] !== undefined);
}

function hasSharedPluginConfig(config: string): boolean {
  return extractTomlSections(config).some((section) => isSharedPluginSection(section.name));
}

function mergeSharedPluginConfig(targetConfig: string, liveConfig: string): string {
  const target = splitTomlSections(targetConfig);
  const liveSections = extractTomlSections(liveConfig).filter((section) => isSharedPluginSection(section.name));
  const targetSharedSections = extractTomlSections(targetConfig).filter((section) => isSharedPluginSection(section.name));
  const mergedSections = new Map<string, TomlSection>();
  // Current live plugin state wins, so newly installed/enabled plugins do not
  // disappear when switching into a profile with an older config.toml.
  for (const section of liveSections) {
    mergedSections.set(section.name, section);
  }
  for (const section of targetSharedSections) {
    if (!mergedSections.has(section.name)) {
      mergedSections.set(section.name, section);
    }
  }
  const base = target.nonSharedText.trimEnd();
  const sharedText = [...mergedSections.values()]
    .map((section) => section.text.trimEnd())
    .filter(Boolean)
    .join("\n\n");
  if (!base) {
    return sharedText ? `${sharedText}\n` : "";
  }
  if (!sharedText) {
    return `${base}\n`;
  }
  return `${base}\n\n${sharedText}\n`;
}

interface TomlSection {
  name: string;
  text: string;
}

interface SplitTomlResult {
  nonSharedText: string;
}

function splitTomlSections(config: string): SplitTomlResult {
  const sections = extractTomlSections(config);
  let cursor = 0;
  let nonSharedText = "";
  for (const section of sections) {
    if (!isSharedPluginSection(section.name)) {
      nonSharedText += config.slice(cursor, section.end);
    } else {
      nonSharedText += config.slice(cursor, section.start);
    }
    cursor = section.end;
  }
  nonSharedText += config.slice(cursor);
  return { nonSharedText };
}

function extractTomlSections(config: string): Array<TomlSection & { start: number; end: number }> {
  const headerPattern = /^\s*\[([^\]\r\n]+)\]\s*$/gm;
  const headers: Array<{ name: string; start: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headerPattern.exec(config)) !== null) {
    headers.push({ name: match[1].trim(), start: match.index });
  }
  return headers.map((header, index) => {
    const end = headers[index + 1]?.start ?? config.length;
    return {
      name: header.name,
      start: header.start,
      end,
      text: config.slice(header.start, end)
    };
  });
}

function isSharedPluginSection(sectionName: string): boolean {
  const normalized = sectionName.toLowerCase().trim();
  return (
    normalized === "plugins" ||
    normalized.startsWith("plugins.") ||
    normalized === "plugin" ||
    normalized.startsWith("plugin.") ||
    normalized === "marketplaces" ||
    normalized.startsWith("marketplaces.") ||
    normalized === "marketplace" ||
    normalized.startsWith("marketplace.") ||
    normalized === "tools" ||
    normalized.startsWith("tools.")
  );
}

function mergeSharedProjectState(targetState: CodexGlobalState, liveState: CodexGlobalState): CodexGlobalState {
  const merged: CodexGlobalState = { ...targetState };
  for (const key of SHARED_GLOBAL_STATE_ARRAY_KEYS) {
    const liveArr = liveState[key] ?? [];
    const targetArr = targetState[key] ?? [];
    const values = mergeStringArrays(liveArr, targetArr);
    if (values.length > 0) {
      merged[key] = values;
    }
  }
  for (const key of SHARED_GLOBAL_STATE_STRING_RECORD_KEYS) {
    const targetMap = targetState[key] ?? {};
    const liveMap = liveState[key] ?? {};
    const values = { ...targetMap, ...liveMap };
    if (Object.keys(values).length > 0) {
      merged[key] = values;
    }
  }
  for (const key of SHARED_GLOBAL_STATE_ANY_RECORD_KEYS) {
    const targetMap = targetState[key] ?? {};
    const liveMap = liveState[key] ?? {};
    const values = { ...targetMap, ...liveMap };
    if (Object.keys(values).length > 0) {
      merged[key] = values;
    }
  }
  for (const key of SHARED_GLOBAL_STATE_LIVE_OVERRIDE_KEYS) {
    if (key in liveState) {
      merged[key] = liveState[key];
    }
  }
  return merged;
}

function mergeStringArrays(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...primary, ...secondary]) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    merged.push(value);
  }
  return merged;
}

async function hardenDirectoryBestEffort(storageRoot: string): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  try {
    await fs.mkdir(storageRoot, { recursive: true });
  } catch {
    // Directory hardening is best effort.
  }
}

function poolStatusesFromSnapshot(snapshot: UsageSnapshot): Record<string, AvailabilityStatus> | undefined {
  if (!snapshot.pools?.length) {
    return undefined;
  }
  return Object.fromEntries(snapshot.pools.map((pool) => {
    const status: AvailabilityStatus = pool.status === "exhausted"
      ? "at_limit"
      : pool.status === "available"
        ? "available"
        : "unavailable";
    return [pool.id, status];
  }));
}

function becameAvailable(previous: AvailabilityState | undefined, after: string, usage: UsageSnapshot): boolean {
  if ((previous?.status ?? "unknown") === "at_limit" && after === "available") {
    return true;
  }
  const nextPoolStatuses = poolStatusesFromSnapshot(usage);
  if (!nextPoolStatuses) {
    return false;
  }
  return Object.entries(nextPoolStatuses).some(([poolId, nextStatus]) => {
    return previous?.poolStatuses?.[poolId] === "at_limit" && nextStatus === "available";
  });
}

function shouldAutoSwitch(usage: UsageSnapshot | undefined, thresholdPercent: number): boolean {
  if (!usage || usage.status !== "available") {
    return true;
  }
  if (usage.pools?.some((pool) => pool.status === "exhausted" || (Number.isFinite(pool.remaining) && (pool.remaining ?? 0) <= 0))) {
    return true;
  }
  const primary = primaryPool(usage);
  const remaining = primary?.remaining;
  const limit = primary?.limit;
  if (remaining === undefined || limit === undefined || limit <= 0) {
    return false;
  }
  return (remaining / limit) * 100 <= thresholdPercent;
}

function isReady(usage: UsageSnapshot | undefined, thresholdPercent: number): boolean {
  return Boolean(usage && usage.status === "available" && !shouldAutoSwitch(usage, thresholdPercent));
}

async function readAuthJson(authPath: string): Promise<CodexAuthJson | undefined> {
  const text = await readAuthFile(authPath);
  if (!text) return undefined;
  try {
    // SAFETY: decrypted auth.json payload matches CodexAuthJson interface
    return JSON.parse(text) as CodexAuthJson;
  } catch {
    return undefined;
  }
}

const LIVE_AUTH_MAGIC = Buffer.from("CMENC1:", "ascii");

/**
 * Reads the live Codex auth.json WITHOUT auto-encrypting it.
 *
 * Unlike {@link readAuthJson} (which calls readAuthFile and triggers an
 * opportunistic plaintext→encrypted migration), this ensures the file
 * remains plain text so Codex can read it.
 *
 * Also remediates files that were previously corrupted by the auto-encrypt
 * bug: if the live auth.json was encrypted with the CMENC1 magic prefix,
 * it is decrypted and written back as plain text.
 */
async function readLiveAuthJson(authPath: string): Promise<CodexAuthJson | undefined> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(authPath);
  } catch {
    return undefined;
  }
  let text: string;
  if (raw.length > LIVE_AUTH_MAGIC.length && raw.slice(0, LIVE_AUTH_MAGIC.length).equals(LIVE_AUTH_MAGIC)) {
    if (!isEncryptionAvailable()) {
      console.warn(`[profileStore] safeStorage unavailable — cannot decrypt live auth.json: ${authPath}`);
      return undefined;
    }
    try {
      text = decryptKeychainBuffer(raw.slice(LIVE_AUTH_MAGIC.length));
    } catch (err) {
      console.error(`[profileStore] decryption failed for live auth.json: ${authPath}`, err);
      return undefined;
    }
    try {
      await fs.writeFile(authPath, text, "utf8");
    } catch (error) {
      console.warn(`[profileStore] could not rewrite live auth.json as plain text: ${authPath}`, error);
    }
  } else {
    text = raw.toString("utf8");
  }
  try {
    // SAFETY: live auth text parsed conforms to CodexAuthJson interface
    const parsed = JSON.parse(text) as CodexAuthJson;
    if (parsed) {
      return parsed;
    }
  } catch {
    // Not valid JSON — fall back to readAuthFile for legacy decryption support
    // (e.g. legacy-encrypted files without the CMENC1 magic prefix).
  }
  const fallbackText = await readAuthFile(authPath, { skipAutoEncrypt: true });
  if (!fallbackText) return undefined;
  try {
    // SAFETY: fallback readAuthFile payload conforms to CodexAuthJson interface
    const parsed = JSON.parse(fallbackText) as CodexAuthJson;
    return parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findAvatarUrl(authJson: CodexAuthJson): string | undefined {
  if (authJson.account?.avatar_url && /^https?:\/\//i.test(authJson.account.avatar_url)) {
    return authJson.account.avatar_url;
  }
  const idToken = authJson.tokens?.id_token;
  if (idToken) {
    const claims = parseJwtPayload(idToken);
    if (claims) {
      const candidate = claims.picture ?? claims.avatar_url ?? claims.avatarUrl ?? claims.image ?? claims.photo_url ?? claims.photoUrl;
      if (candidate && /^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function normalizeDisplayName(name: string, email?: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return email ?? "Codex profile";
  }
  if (email && isEmail(trimmed) && trimmed.toLowerCase() !== email.toLowerCase()) {
    return email;
  }
  return trimmed;
}

function findEmailFromIdToken(authJson: CodexAuthJson): string | undefined {
  const idToken = authJson.tokens?.id_token;
  if (!idToken) {
    return undefined;
  }
  const payload = parseJwtPayload(idToken);
  if (!payload) {
    return undefined;
  }
  return findEmail(payload);
}

function isTokenExpired(authJson: CodexAuthJson): boolean {
  const idToken = authJson.tokens?.id_token;
  if (!idToken) return false;
  const payload = parseJwtPayload(idToken);
  if (!payload) return false;
  const exp = Number(payload["exp"]);
  if (!Number.isFinite(exp)) return false;
  return Date.now() / 1000 >= exp;
}

function isTokenPermanentlyExpired(authJson: CodexAuthJson): boolean {
  return isTokenExpired(authJson) && !authJson.tokens?.refresh_token;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
