import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSafeStorageBackendForTest } from "../electron/services/authStorage.js";
import { ProfileStore, setShellOpenPathForTest } from "../electron/services/profileStore.js";
import { AppSettings, ProfileManifest, UsageSnapshot } from "../src/shared/types.js";

const KEY = 0x42;
const safeStorageMock = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext: string): Buffer => {
    const buf = Buffer.from(plaintext, "utf8");
    for (let i = 0; i < buf.length; i++) buf[i] ^= KEY;
    return buf;
  },
  decryptString: (cipherBuf: Buffer): string => {
    const buf = Buffer.from(cipherBuf);
    for (let i = 0; i < buf.length; i++) buf[i] ^= KEY;
    return buf.toString("utf8");
  }
};

setSafeStorageBackendForTest(safeStorageMock);
setShellOpenPathForTest(vi.fn(async () => ""));

const originalEnv = {
 APPDATA: process.env.APPDATA,
 LOCALAPPDATA: process.env.LOCALAPPDATA,
 USERPROFILE: process.env.USERPROFILE
};
let tempRoot = "";
beforeEach(async () => {
 tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-manager-profile-store-"));
 process.env.USERPROFILE = path.join(tempRoot, "user");
 process.env.APPDATA = path.join(tempRoot, "roaming");
 process.env.LOCALAPPDATA = path.join(tempRoot, "local");
 await fs.mkdir(path.join(process.env.USERPROFILE, ".codex"), { recursive: true });
});
afterEach(async () => {
 process.env.APPDATA = originalEnv.APPDATA;
 process.env.LOCALAPPDATA = originalEnv.LOCALAPPDATA;
 process.env.USERPROFILE = originalEnv.USERPROFILE;
 // Use maxRetries because the background quota-refresh in switchProfile writes
 // manifest.json after the test awaits autoSwitchIfNeeded/switchProfile, and
 // on Windows the still-open write handle causes ENOTEMPTY on rmdir.
 await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
describe("ProfileStore active profile reconciliation", () => {
 it("treats the live Codex auth profile as active instead of stale settings", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Account 1", "account1@example.com");
 await writeProfile(tempRoot, "p3", "Account 3", "account3@example.com");
 await writeSettings(tempRoot, { activeProfileId: "p1" });
 await writeLiveAuth("account3@example.com");
 const state = await store.getState();
 expect(state.profiles.find((profile) => profile.isActive)?.id).toBe("p3");
 expect(state.settings.activeProfileId).toBe("p3");
 });
 it("refreshes live quota only for the profile matching the live Codex auth", async () => {
 const liveUsage: UsageSnapshot = {
 status: "available",
 accountEmail: "account3@example.com",
 weekly: { remaining: 68, limit: 100 },
 pools: [{ id: "weekly", label: "Weekly", status: "available", remaining: 68, limit: 100 }]
 };
 const storedUsage: UsageSnapshot = {
 status: "available",
 accountEmail: "account1@example.com",
 weekly: { remaining: 12, limit: 100 },
 pools: [{ id: "weekly", label: "Weekly", status: "available", remaining: 12, limit: 100 }]
 };
 const usageService = makeUsageService(liveUsage, storedUsage);
 const store = makeStore(usageService);
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Account 1", "account1@example.com");
 await writeProfile(tempRoot, "p3", "Account 3", "account3@example.com");
 await writeSettings(tempRoot, { activeProfileId: "p1" });
 await writeLiveAuth("account3@example.com");
 await store.refreshUsage({ profileId: "p1" });
 await store.refreshUsage({ profileId: "p3" });
 expect(usageService.refreshForProfile).toHaveBeenCalledTimes(1);
 expect(usageService.refreshForProfile).toHaveBeenCalledWith(expect.stringContaining("p1"));
 expect(usageService.refreshForAuthPath).toHaveBeenCalledTimes(1);
 expect((await readManifest(tempRoot, "p1")).usage?.weekly?.remaining).toBe(12);
 expect((await readManifest(tempRoot, "p3")).usage?.weekly?.remaining).toBe(68);
 });
});
describe("ProfileStore profile lifecycle", () => {
 it("saves a new profile and creates missing directories", async () => {
 const store = makeStore();
 await store.initialize();
 await writePendingCapture(tempRoot, "capture-1", "new@example.com");
 const state = await store.createProfile({ captureId: "capture-1", name: "New Account" });
 const created = state.profiles.find((profile) => profile.email === "new@example.com");
 expect(created?.name).toBe("New Account");
 await expect(fs.access(path.join(tempRoot, "profiles", created?.id ?? "", "manifest.json"))).resolves.toBeUndefined();
 await expect(fs.access(path.join(tempRoot, "profiles", created?.id ?? "", "codex-agent", "auth.json"))).resolves.toBeUndefined();
 });
 it("loads a saved profile with matching manifest data", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Saved Account", "saved@example.com");
 const state = await store.getState();
 expect(state.profiles).toEqual(expect.arrayContaining([
 expect.objectContaining({ id: "p1", name: "Saved Account", email: "saved@example.com" })
 ]));
 });
 it("deletes a profile from disk", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Delete Me", "delete@example.com");
 await store.deleteProfile({ profileId: "p1" });
 await expect(fs.access(path.join(tempRoot, "profiles", "p1"))).rejects.toThrow();
 });
 it("renames a profile and preserves capital letters", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "lower", "rename@example.com");
 const state = await store.renameProfile({ profileId: "p1", name: "My Work Account" });
 expect(state.profiles.find((profile) => profile.id === "p1")?.name).toBe("My Work Account");
 expect((await readManifest(tempRoot, "p1")).name).toBe("My Work Account");
 });
 it("backs up a profile to the backup directory", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Backup Me", "backup@example.com");
 await store.backupProfile({ profileId: "p1" });
 const backups = await fs.readdir(path.join(tempRoot, "backups", "codex"));
 expect(backups.some((entry) => entry.endsWith("-p1"))).toBe(true);
 });
  it("prunes old backups when max backups limit is exceeded", async () => {
    const store = makeStore();
    await store.initialize();
    await writeProfile(tempRoot, "p1", "Backup Me", "backup@example.com");

    // Generate 12 backups (with tiny pauses to ensure timestamp order is correct)
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await store.backupProfile({ profileId: "p1" });
    }

    const backups = await fs.readdir(path.join(tempRoot, "backups", "codex"));
    // The default limit is 10, so it should prune down to exactly 10
    expect(backups.length).toBe(10);
  });
 it("loads a profile with missing or corrupt auth.json without crashing", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "missing-auth", "Missing Auth", "missing@example.com", { writeAuth: false });
 await writeProfile(tempRoot, "corrupt-auth", "Corrupt Auth", "corrupt@example.com");
 await fs.writeFile(path.join(tempRoot, "profiles", "corrupt-auth", "codex-agent", "auth.json"), "{bad json}", "utf8");
 const state = await store.getState();
 expect(state.profiles.map((profile) => profile.id)).toEqual(expect.arrayContaining(["missing-auth", "corrupt-auth"]));
 });
 it("throws an error when accessing a profile with directory traversal characters", async () => {
 const store = makeStore();
 await store.initialize();
 await expect(store.openProfileFolder({ profileId: "../dangerous" }))
 .rejects.toThrow("Access Denied: Invalid profile identifier.");
 });
 it("throws an error when updating settings with an invalid Codex binary filename", async () => {
 const store = makeStore();
 await store.initialize();
 await expect(store.updateSettings({ executablePath: "/path/to/malicious.exe" }))
 .rejects.toThrow("Invalid executable path: File name must be 'Codex', 'Codex.exe', 'ChatGPT', or 'ChatGPT.exe'");
 });
 it("accepts ChatGPT.exe as a valid executable path after the desktop rebrand", async () => {
 const store = makeStore();
 await store.initialize();
 const chatGptPath = process.platform === "win32"
   ? "C:\\Apps\\ChatGPT\\ChatGPT.exe"
   : "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
 await store.updateSettings({ executablePath: chatGptPath });
 expect((await store.getState()).settings.executablePath).toBe(chatGptPath);
 });
});
describe("ProfileStore switch flow", () => {
  it("copies profile files to live Codex paths and marks the profile active", async () => {
    const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
    const store = makeStore(makeUsageService(), processManager);
    await store.initialize();
    await writeCodexExecutable();
    await writeProfile(tempRoot, "p1", "Switch Me", "switch@example.com");
    await store.switchProfile({ profileId: "p1" });
    // SAFETY: parsing live auth json to check id_token
    const liveAuth = JSON.parse(await fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", "auth.json"), "utf8")) as { tokens: { id_token: string } };
    expect(emailFromJwt(liveAuth.tokens.id_token)).toBe("switch@example.com");
    expect((await store.getState()).settings.activeProfileId).toBe("p1");
    expect(processManager.close).toHaveBeenCalled();
    expect(processManager.launch).toHaveBeenCalled();
  });
  it("rebuilds Codex native profile files from saved auth before relaunch", async () => {
    const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
    const store = makeStore(makeUsageService(), processManager);
    await store.initialize();
    await writeCodexExecutable();
    await writeProfile(tempRoot, "p1", "Switch Me", "switch@example.com");
    await fs.writeFile(path.join(process.env.USERPROFILE ?? "", ".codex", "profiles.json"), JSON.stringify({
      profiles: [{ id: "old-chatgpt", label: "Old", email: "old@example.com", file: "old-chatgpt.json", updatedAt: new Date().toISOString() }]
    }), "utf8");
    await store.switchProfile({ profileId: "p1" });
    const liveAuthText = await fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", "auth.json"), "utf8");
    expect(() => JSON.parse(liveAuthText)).not.toThrow();
    // SAFETY: parsing mirrored profile auth file
    const profileAuth = JSON.parse(await fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", "profiles", "switch-example-com-chatgpt.json"), "utf8")) as { tokens: { id_token: string } };
    expect(emailFromJwt(profileAuth.tokens.id_token)).toBe("switch@example.com");
    // SAFETY: parsing mirrored profiles index file
    const index = JSON.parse(await fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", "profiles.json"), "utf8")) as { profiles: Array<{ email?: string }> };
    expect(index.profiles.some((profile) => profile.email === "switch@example.com")).toBe(true);
  });
 it("preserves shared Codex projects when switching profiles", async () => {
 const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
 const store = makeStore(makeUsageService(), processManager);
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "p0", "Current", "current@example.com");
 await writeProfile(tempRoot, "p1", "Target", "target@example.com");
 await writeSettings(tempRoot, { activeProfileId: "p0" });
 await writeLiveAuth("current@example.com");
 await writeLiveGlobalState({
 "electron-saved-workspace-roots": ["C:\\New Project", "C:\\Shared Project"],
 "active-workspace-roots": ["C:\\New Project"],
 "electron-workspace-root-labels": {
 "C:\\New Project": "New",
 "C:\\Shared Project": "Live Shared"
 },
 "project-order": ["C:\\New Project", "C:\\Shared Project"],
 "thread-workspace-root-hints": {
 "thread-new": "C:\\New Project",
 "thread-shared": "C:\\Shared Project"
 },
 "projectless-thread-ids": ["thread-live"],
 "theme": "live-theme"
 });
 await writeStoredGlobalState(tempRoot, "p1", {
 "electron-saved-workspace-roots": ["C:\\Old Project", "C:\\Shared Project"],
 "active-workspace-roots": ["C:\\Old Project"],
 "electron-workspace-root-labels": {
 "C:\\Old Project": "Old",
 "C:\\Shared Project": "Target Shared"
 },
 "project-order": ["C:\\Old Project", "C:\\Shared Project"],
 "thread-workspace-root-hints": {
 "thread-old": "C:\\Old Project",
 "thread-shared": "C:\\Old Project"
 },
 "projectless-thread-ids": ["thread-target"],
 "theme": "target-theme"
 });
 await store.switchProfile({ profileId: "p1" });
 const liveState = await readLiveGlobalState();
 const storedTargetState = await readStoredGlobalState(tempRoot, "p1");
 for (const state of [liveState, storedTargetState]) {
 expect(state["electron-saved-workspace-roots"]).toEqual(["C:\\New Project", "C:\\Shared Project", "C:\\Old Project"]);
 expect(state["active-workspace-roots"]).toEqual(["C:\\New Project", "C:\\Old Project"]);
 expect(state["project-order"]).toEqual(["C:\\New Project", "C:\\Shared Project", "C:\\Old Project"]);
 expect(state["electron-workspace-root-labels"]).toEqual({
 "C:\\Old Project": "Old",
 "C:\\Shared Project": "Live Shared",
 "C:\\New Project": "New"
 });
 expect(state["thread-workspace-root-hints"]).toEqual({
 "thread-old": "C:\\Old Project",
 "thread-shared": "C:\\Shared Project",
 "thread-new": "C:\\New Project"
 });
 expect(state["projectless-thread-ids"]).toEqual(["thread-live", "thread-target"]);
 expect(state["theme"]).toBe("target-theme");
 }
 });
 it("preserves shared Codex plugin config when switching profiles", async () => {
 const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
 const store = makeStore(makeUsageService(), processManager);
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "p0", "Current", "current@example.com");
 await writeProfile(tempRoot, "p1", "Target", "target@example.com");
 await writeSettings(tempRoot, { activeProfileId: "p0" });
 await writeLiveAuth("current@example.com");
 await writeLiveConfig(`
model = "gpt-5.3-codex"
[plugins."superpowers@openai-curated"]
enabled = true
[plugins."github@openai-curated"]
enabled = true
[marketplaces.openai-curated]
source_type = "local"
source = "C:\\\\Users\\\\user\\\\.codex\\\\.tmp\\\\plugins"
`);
 await writeStoredConfig(tempRoot, "p1", `
model = "target-model"
[plugins."superpowers@openai-curated"]
enabled = false
[plugins."notion@openai-curated"]
enabled = true
[marketplaces.openai-curated]
source_type = "local"
source = "old-cache"
`);
 await store.switchProfile({ profileId: "p1" });
 const liveConfig = await readLiveConfig();
 const storedTargetConfig = await readStoredConfig(tempRoot, "p1");
 for (const config of [liveConfig, storedTargetConfig]) {
 expect(config).toContain('model = "target-model"');
 expect(config).toContain('[plugins."github@openai-curated"]');
 expect(config).toContain('[plugins."notion@openai-curated"]');
 expect(config).toContain('[plugins."superpowers@openai-curated"]\nenabled = true');
 expect(config).toContain('source = "C:\\\\Users\\\\user\\\\.codex\\\\.tmp\\\\plugins"');
 expect(config).not.toContain('source = "old-cache"');
 expect(config).not.toContain('model = "gpt-5.3-codex"');
 }
 });
 it("does not close Codex when the saved profile auth cannot be read", async () => {
 const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
 const store = makeStore(makeUsageService(), processManager);
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "p1", "Broken", "broken@example.com");
 await fs.writeFile(path.join(tempRoot, "profiles", "p1", "codex-agent", "auth.json"), "{bad json", "utf8");
 await expect(store.switchProfile({ profileId: "p1" })).rejects.toThrow(/auth\.json is missing/i);
 expect(processManager.close).not.toHaveBeenCalled();
 expect(processManager.launch).not.toHaveBeenCalled();
 });
 it("fails gracefully when required source auth.json is missing", async () => {
 const store = makeStore();
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "p1", "Broken", "broken@example.com", { writeAuth: false });
 await expect(store.switchProfile({ profileId: "p1" })).rejects.toThrow(/auth\.json is missing/i);
 });
});
describe("ProfileStore auto-switch logic", () => {
 it("selects the highest-quota ready account and skips the active account", async () => {
 const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
 const store = makeStore(makeUsageService(), processManager);
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "a", "A", "a@example.com", { usage: usagePercent(0) });
 await writeProfile(tempRoot, "b", "B", "b@example.com", { usage: usagePercent(97) });
 await writeProfile(tempRoot, "c", "C", "c@example.com", { usage: usagePercent(45) });
 await writeSettings(tempRoot, { activeProfileId: "a", autoSwitchEnabled: true, autoSwitchThresholdPercent: 15 });
 await writeLiveAuth("a@example.com");
 const result = await store.autoSwitchIfNeeded();
 expect(result?.profile.id).toBe("b");
 expect(processManager.launch).toHaveBeenCalled();
 });
 it("returns undefined when all accounts are rate limited", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "a", "A", "a@example.com", { usage: usagePercent(0) });
 await writeProfile(tempRoot, "b", "B", "b@example.com", { usage: usagePercent(0) });
 await writeProfile(tempRoot, "c", "C", "c@example.com", { usage: usagePercent(0) });
 await writeSettings(tempRoot, { activeProfileId: "a", autoSwitchEnabled: true, autoSwitchThresholdPercent: 15 });
 await writeLiveAuth("a@example.com");
 await expect(store.autoSwitchIfNeeded()).resolves.toBeUndefined();
 });
 it("respects the threshold by skipping accounts below it", async () => {
 const processManager = { isRunning: vi.fn(), close: vi.fn(async () => undefined), launch: vi.fn(async () => undefined) };
 const store = makeStore(makeUsageService(), processManager);
 await store.initialize();
 await writeCodexExecutable();
 await writeProfile(tempRoot, "a", "A", "a@example.com", { usage: usagePercent(0) });
 await writeProfile(tempRoot, "b", "B", "b@example.com", { usage: usagePercent(14) });
 await writeProfile(tempRoot, "c", "C", "c@example.com", { usage: usagePercent(45) });
 await writeSettings(tempRoot, { activeProfileId: "a", autoSwitchEnabled: true, autoSwitchThresholdPercent: 15 });
 await writeLiveAuth("a@example.com");
 const result = await store.autoSwitchIfNeeded();
 expect(result?.profile.id).toBe("c");
 });
});
describe("ProfileStore settings and import/export", () => {
 it("persists settings across store instances", async () => {
 const store = makeStore();
 await store.initialize();
 await store.updateSettings({
 autoSwitchThresholdPercent: 15,
 pollingIntervalMinutes: 25,
 executablePath: "C:\\Codex\\Codex.exe",
 lowQuotaAlerts: false,
 notifyWhenAvailable: false
 });
 const restarted = makeStore();
 const state = await restarted.getState();
 expect(state.settings.autoSwitchThresholdPercent).toBe(15);
 expect(state.settings.pollingIntervalMinutes).toBe(25);
 expect(state.settings.executablePath).toBe("C:\\Codex\\Codex.exe");
 expect(state.settings.lowQuotaAlerts).toBe(false);
 expect(state.settings.notifyWhenAvailable).toBe(false);
 });
 it("rejects export without a passphrase", async () => {
 const store = makeStore();
 await store.initialize();
 await writeProfile(tempRoot, "p1", "Exported", "export@example.com");
 const exportPath = path.join(tempRoot, "exports", "no-pass.json");
 await expect(store.exportProfilesTo(exportPath)).rejects.toThrow(/passphrase is required/i);
 await expect(store.exportProfilesTo(exportPath, "   ")).rejects.toThrow(/passphrase is required/i);
 });
  it("exports encrypted JSON with profile metadata and imports it back", async () => {
    const store = makeStore();
    await store.initialize();
    await writeProfile(tempRoot, "p1", "Exported", "export@example.com", {
      planType: "plus",
      usage: usagePercent(50)
    });
    const exportPath = path.join(tempRoot, "exports", "accounts.json");
    const passphrase = "test-export-pass-phrase";
    const exported = await store.exportProfilesTo(exportPath, passphrase);
    // SAFETY: reading onDisk JSON envelope from exportPath
    const onDisk = JSON.parse(await fs.readFile(exportPath, "utf8")) as { cmSecure?: number; data?: string; exportedBy?: string; profiles?: unknown[] };
    expect(exported.count).toBe(1);
    // Must be sealed (not plaintext profile dump)
    expect(onDisk).toHaveProperty("cmSecure");
    expect(onDisk).toHaveProperty("data");
    expect(onDisk).not.toHaveProperty("exportedBy");
    expect(onDisk).not.toHaveProperty("profiles");
    const importRoot = path.join(tempRoot, "imported-store");
    // SAFETY: mocking usage service for imported store
    const importedStore = new ProfileStore(importRoot, { isRunning: vi.fn(), close: vi.fn(), launch: vi.fn() }, makeUsageService() as never);
    await importedStore.initialize();
    const importResult = await importedStore.importProfilesFrom(exportPath, passphrase);
    expect(importResult.count).toBe(1);
    // All imported profiles are READY — none set as active
    const state = await importedStore.getState();
    expect(state.profiles[0]).toEqual(expect.objectContaining({
      name: "Exported",
      email: "export@example.com",
      planType: "plus"
    }));
    expect(state.profiles[0].usage?.weekly?.remaining).toBe(50);
    expect(state.profiles[0].isActive).toBe(false);
    expect(state.settings.availabilityByProfile[state.profiles[0].id]?.status).toBe("available");
  });
  it("previewImportFrom returns profile list without writing", async () => {
    const store = makeStore();
    await store.initialize();
    await writeProfile(tempRoot, "p1", "Alice", "alice@example.com");
    await writeProfile(tempRoot, "p2", "Bob", undefined);
    const exportPath = path.join(tempRoot, "exports", "preview-test.json");
    const passphrase = "preview-pass";
    await store.exportProfilesTo(exportPath, passphrase);
    // Encrypted without passphrase → UI should prompt
    const locked = await store.previewImportFrom(exportPath);
    expect(locked.encrypted).toBe(true);
    expect(locked.profiles).toEqual([]);
    // With passphrase → names/emails without modifying store
    const preview = await store.previewImportFrom(exportPath, passphrase);
    expect(preview.profiles.map((p) => p.name)).toEqual(expect.arrayContaining(["Alice", "Bob"]));
    expect(preview.profiles.find((p) => p.name === "Alice")?.email).toBe("alice@example.com");
    expect(preview.profiles.find((p) => p.name === "Bob")?.email).toBeUndefined();
  });
  it("previewImportFrom throws user-friendly error for non-relay files", async () => {
    const store = makeStore();
    await store.initialize();
    const wrongPath = path.join(tempRoot, "wrong.json");
    await fs.writeFile(wrongPath, JSON.stringify({ exportedBy: "something-else", profiles: [] }), "utf8");
    await expect(store.previewImportFrom(wrongPath)).rejects.toThrow("This file doesn't look like a Relay export.");
  });
  it("rejects malformed import JSON without crashing", async () => {
    const store = makeStore();
    await store.initialize();
    const badPath = path.join(tempRoot, "bad.json");
    await fs.writeFile(badPath, "{bad", "utf8");
    await expect(store.importProfilesFrom(badPath)).rejects.toThrow();
  });
});
function makeStore(
  usageService = makeUsageService(),
  processManager = { isRunning: vi.fn(), close: vi.fn(), launch: vi.fn() }
): ProfileStore {
  return new ProfileStore(
    tempRoot,
    processManager,
    // SAFETY: mocking usage service for makeStore
    usageService as never
  );
}
function makeUsageService(
  liveUsage: UsageSnapshot = { status: "available" },
  storedUsage: UsageSnapshot = { status: "available" }
) {
  return {
    refreshForAuthPath: vi.fn(async () => liveUsage),
    refreshForProfile: vi.fn(async () => storedUsage),
    deriveAvailability: vi.fn((usage: UsageSnapshot) => usage.status === "available" ? "available" : "unavailable")
  };
}
async function writeProfile(
  root: string,
  id: string,
  name: string,
  email?: string,
  options: { writeAuth?: boolean; appFiles?: Record<string, string>; usage?: UsageSnapshot; planType?: string } = {}
) {
  const profileRoot = path.join(root, "profiles", id);
  await fs.mkdir(profileRoot, { recursive: true });
  await fs.writeFile(path.join(profileRoot, "manifest.json"), JSON.stringify({
    id,
    name,
    email,
    planType: options.planType,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    usage: options.usage
  }), "utf8");
  if (options.writeAuth !== false) {
    await fs.mkdir(path.join(profileRoot, "codex-agent"), { recursive: true });
    await fs.writeFile(path.join(profileRoot, "codex-agent", "auth.json"), JSON.stringify(authJson(email ?? "user@example.com")), "utf8");
  }
  for (const [relativePath, content] of Object.entries(options.appFiles ?? {})) {
    const target = path.join(profileRoot, "codex-app", relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}
async function readManifest(root: string, id: string): Promise<ProfileManifest> {
  // SAFETY: reading manifest file as ProfileManifest
  return JSON.parse(await fs.readFile(path.join(root, "profiles", id, "manifest.json"), "utf8")) as ProfileManifest;
}
async function writeSettings(root: string, settings: Partial<AppSettings>): Promise<void> {
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify(settings), "utf8");
}
async function writePendingCapture(root: string, captureId: string, email: string): Promise<void> {
  const pendingRoot = path.join(root, "pending", captureId);
  await fs.mkdir(path.join(pendingRoot, "codex-agent"), { recursive: true });
  await fs.writeFile(path.join(pendingRoot, "codex-agent", "auth.json"), JSON.stringify(authJson(email)), "utf8");
  await fs.writeFile(path.join(pendingRoot, "capture.json"), JSON.stringify({
    captureId,
    accountEmail: email,
    suggestedName: email,
    createdAt: new Date().toISOString()
  }), "utf8");
}
async function writeCodexExecutable(): Promise<void> {
  const executablePath = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "test-build", "codex.exe");
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, "", "utf8");
}
async function writeLiveAuth(email: string): Promise<void> {
  await fs.writeFile(path.join(process.env.USERPROFILE ?? "", ".codex", "auth.json"), JSON.stringify(authJson(email)), "utf8");
}
async function writeLiveGlobalState(state: CodexGlobalState): Promise<void> {
  await fs.writeFile(path.join(process.env.USERPROFILE ?? "", ".codex", ".codex-global-state.json"), JSON.stringify(state), "utf8");
}
async function writeLiveConfig(config: string): Promise<void> {
  await fs.writeFile(path.join(process.env.USERPROFILE ?? "", ".codex", "config.toml"), config.trimStart(), "utf8");
}
async function readLiveConfig(): Promise<string> {
  return fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", "config.toml"), "utf8");
}
async function readLiveGlobalState(): Promise<CodexGlobalState> {
  // SAFETY: parsing live global state as CodexGlobalState
  return JSON.parse(await fs.readFile(path.join(process.env.USERPROFILE ?? "", ".codex", ".codex-global-state.json"), "utf8")) as CodexGlobalState;
}
async function writeStoredGlobalState(root: string, id: string, state: CodexGlobalState): Promise<void> {
  await fs.writeFile(path.join(root, "profiles", id, "codex-agent", ".codex-global-state.json"), JSON.stringify(state), "utf8");
}
async function writeStoredConfig(root: string, id: string, config: string): Promise<void> {
  await fs.writeFile(path.join(root, "profiles", id, "codex-agent", "config.toml"), config.trimStart(), "utf8");
}
async function readStoredConfig(root: string, id: string): Promise<string> {
  return fs.readFile(path.join(root, "profiles", id, "codex-agent", "config.toml"), "utf8");
}
async function readStoredGlobalState(root: string, id: string): Promise<CodexGlobalState> {
  // SAFETY: parsing stored global state as CodexGlobalState
  return JSON.parse(await fs.readFile(path.join(root, "profiles", id, "codex-agent", ".codex-global-state.json"), "utf8")) as CodexGlobalState;
}
function authJson(email: string) {
  return { tokens: { id_token: jwtWithEmail(email), account_id: "acct_test" } };
}
function usagePercent(percent: number): UsageSnapshot {
  return {
    status: "available",
    weekly: { remaining: percent, limit: 100 },
    pools: [{ id: "codex-weekly", label: "Weekly", status: percent <= 0 ? "exhausted" : "available", remaining: percent, limit: 100 }]
  };
}
function jwtWithEmail(email: string): string {
  return `${base64Url({ alg: "none" })}.${base64Url({ email })}.signature`;
}
function base64Url(value: { alg: string } | { email: string }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function emailFromJwt(token: string): string | undefined {
  const [, payload] = token.split(".");
  if (!payload) {
    return undefined;
  }
  // SAFETY: parsing JWT payload to extract email
  return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string }).email;
}
