import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { copyForLanguage } from "../src/i18n";
import { AppState, ProfileSwitcherApi } from "../src/shared/types";
describe("App", () => {
 let api: ProfileSwitcherApi;
 afterEach(() => {
 cleanup();
 });
 beforeEach(() => {
 window.localStorage.clear();
 api = fakeApi({
 profiles: [
 {
 id: "codex-1",
 name: "Codex Work",
 email: "work@example.com",
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive: true,
 usage: {
 status: "unavailable",
 checkedAt: "2026-05-17T00:00:00.000Z",
 message: "Codex 5-hour and weekly limits were not found in the usage response."
 }
 }
 ],
 settings: {
 activeProfileId: "codex-1",
 autoSwitchEnabled: false,
 autoSwitchThresholdPercent: 10,
 pollingIntervalMinutes: 20,
 theme: "system",
 language: "en",
 autoRefreshQuota: true,
 autoSyncCurrentAccount: false,
 syncIntervalMinutes: 5,
 startWithSystem: false,
 lowQuotaAlerts: true,
 notifyWhenAvailable: true,
 lowQuotaThresholdPercent: 15,
 proxyEnabled: false,
 proxyUrl: "",
 serviceRunning: true,
 availabilityByProfile: {}
 },
 defaultExecutablePath: "C:\\Users\\testuser\\AppData\\Local\\Programs\\Codex\\Codex.exe",
 appInfo: {
 version: "0.1.0",
 platform: "win32",
 license: "CC BY-NC-SA 4.0",
 storageEncrypted: false
 }
 });
 window.profileSwitcher = api;
 });
 it("renders loaded app state", async () => {
 render(<App />);
 expect((await screen.findAllByText("Codex Work")).length).toBeGreaterThanOrEqual(1);
 expect((await screen.findAllByText("Quota unavailable")).length).toBeGreaterThan(0);
 });
 it("uses one native tooltip source for the auto-switch count badge", async () => {
 render(<App />);
 await screen.findAllByText("Codex Work");
 const badge = screen.getByLabelText("0 auto-switches performed this session");
 expect(badge).toHaveAttribute("title", "0 auto-switches performed this session");
 expect(badge).not.toHaveAttribute("data-tooltip");
 });
 it("renders valid localized copy without mojibake", () => {
 const localizedCopies = [copyForLanguage("zh"), copyForLanguage("ja"), copyForLanguage("ko")];
 expect(copyForLanguage("zh").settings.title).toBe("设置");
 expect(copyForLanguage("ja").settings.title).toBe("設定");
 expect(copyForLanguage("ko").settings.title).toBe("설정");
 for (const copy of localizedCopies) {
 expect(JSON.stringify(copy)).not.toMatch(/[ÃÂ]/);
 expect(JSON.stringify(copy)).not.toContain("â€");
 }
 });
 it("generates pseudo-localized strings for layout stress testing", () => {
 const pseudo = copyForLanguage("pseudo");
 expect(pseudo.actions.selectAll).toBe("[Select AllSelec]");
 expect(pseudo.status.limited).toBe("[Rate LimitedRate L]");
 });
 it("opens login capture and saves the named profile from the modal", async () => {
 render(<App />);
 const addButton = await screen.findByRole("button", { name: /add account/i });
 fireEvent.click(addButton);
 const openLoginButton = await screen.findByRole("button", { name: /open login page/i });
 fireEvent.click(openLoginButton);
 await waitFor(() => expect(api.startLoginCapture).toHaveBeenCalled());
 await waitFor(() => expect(api.openLoginCapture).toHaveBeenCalledWith({ captureId: "capture-1" }));
 await waitFor(() => expect(api.waitLoginCapture).toHaveBeenCalledWith({ captureId: "capture-1" }));
 const nameInput = await screen.findByLabelText(/display name|profile name/i);
 fireEvent.change(nameInput, { target: { value: "Work Browser" } });
 fireEvent.click(screen.getByRole("button", { name: /save account/i }));
 await waitFor(() => expect(api.createProfile).toHaveBeenCalledWith({ captureId: "capture-1", name: "Work Browser" }));
 });
 it("shows token expired on profile row when usage refresh returns 403 mapping", async () => {
 const expiredState: AppState = {
 profiles: [
 {
 id: "codex-1",
 name: "Codex Work",
 email: "work@example.com",
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive: true,
 usage: {
 status: "unavailable",
 checkedAt: "2026-05-17T00:00:00.000Z",
 message: "Token expired"
 }
 }
 ],
 settings: {
 activeProfileId: "codex-1",
 autoSwitchEnabled: false,
 autoSwitchThresholdPercent: 10,
 pollingIntervalMinutes: 20,
 theme: "system",
 language: "en",
 autoRefreshQuota: true,
 autoSyncCurrentAccount: false,
 syncIntervalMinutes: 5,
 startWithSystem: false,
 lowQuotaAlerts: true,
 notifyWhenAvailable: true,
 lowQuotaThresholdPercent: 15,
 proxyEnabled: false,
 proxyUrl: "",
 serviceRunning: true,
 availabilityByProfile: {}
 },
 defaultExecutablePath: "C:\\Users\\testuser\\AppData\\Local\\Programs\\Codex\\Codex.exe",
 appInfo: {
 version: "0.1.0",
 platform: "win32",
 license: "CC BY-NC-SA 4.0",
 storageEncrypted: false
 }
 };
 window.profileSwitcher = fakeApi(expiredState);
 render(<App />);
 expect((await screen.findAllByText("Token expired")).length).toBeGreaterThan(0);
 });
 it("renders the primary five-hour quota bar when both windows exist", async () => {
 window.profileSwitcher = fakeApi(stateWithUsage({
 status: "available",
 fiveHour: { remaining: 6, limit: 10, resetAt: "2026-05-17T05:00:00.000Z" },
 weekly: { remaining: 60, limit: 100, resetAt: "2026-05-24T00:00:00.000Z" },
 pools: [
 { id: "codex-five-hour", label: "5-hour", status: "available", remaining: 6, limit: 10, resetAt: "2026-05-17T05:00:00.000Z" },
 { id: "codex-weekly", label: "Weekly", status: "available", remaining: 60, limit: 100, resetAt: "2026-05-24T00:00:00.000Z" }
 ]
 }));
 render(<App />);
 expect(await screen.findByText("5-hour")).toBeInTheDocument();
 expect(screen.queryByText("Weekly")).not.toBeInTheDocument();
 expect(screen.getByText("(+1 other limits)")).toBeInTheDocument();
 expect(screen.getAllByText("60%").length).toBeGreaterThanOrEqual(1);
 });
 it("renders only the weekly quota bar when only weekly exists", async () => {
 window.profileSwitcher = fakeApi(stateWithUsage({
 status: "available",
 weekly: { remaining: 60, limit: 100, resetAt: "2026-05-24T00:00:00.000Z" },
 pools: [
 { id: "codex-weekly", label: "Weekly", status: "available", remaining: 60, limit: 100, resetAt: "2026-05-24T00:00:00.000Z" }
 ]
 }));
 render(<App />);
 expect(await screen.findByText("Weekly")).toBeInTheDocument();
 expect(screen.queryByText("5-hour")).not.toBeInTheDocument();
 });
 it("renders only the five-hour quota bar when only five-hour exists", async () => {
 window.profileSwitcher = fakeApi(stateWithUsage({
 status: "available",
 fiveHour: { remaining: 6, limit: 10, resetAt: "2026-05-17T05:00:00.000Z" },
 pools: [
 { id: "codex-five-hour", label: "5-hour", status: "available", remaining: 6, limit: 10, resetAt: "2026-05-17T05:00:00.000Z" }
 ]
 }));
 render(<App />);
 expect(await screen.findByText("5-hour")).toBeInTheDocument();
 expect(screen.queryByText("Weekly")).not.toBeInTheDocument();
 });
 it("renders credits instead of quota bars when credits-only usage exists", async () => {
 window.profileSwitcher = fakeApi(stateWithUsage({
 status: "available",
 credits: { remaining: 450, limit: 1000 },
 pools: [
 { id: "codex-credits", label: "Credits", status: "available", remaining: 450, limit: 1000 }
 ]
 }));
 render(<App />);
 expect(await screen.findByText("Credits")).toBeInTheDocument();
 expect(screen.getAllByText("45%").length).toBeGreaterThanOrEqual(1); // 450/1000 = 45%
 expect(screen.queryByText("Weekly")).not.toBeInTheDocument();
 expect(screen.queryByText("5-hour")).not.toBeInTheDocument();
 });
 it("shows action feedback as a toast", async () => {
 render(<App />);
 fireEvent.click(await screen.findByRole("button", { name: /more actions/i }));
 const backupButton = await screen.findByRole("button", { name: /backup/i });
 fireEvent.click(backupButton);
 expect(await screen.findByRole("status")).toHaveTextContent("Backup profile finished.");
 });
 it("renames a profile through inline editing", async () => {
    const renamedState = await api.getState();
    // SAFETY: mocking renameProfile method on ProfileSwitcherApi
    api.renameProfile = vi.fn(async () => ({
      ...renamedState,
      profiles: renamedState.profiles.map((profile) => (
        profile.id === "codex-1" ? { ...profile, name: "Renamed Work" } : profile
      ))
    })) as ProfileSwitcherApi["renameProfile"];
 const promptSpy = vi.spyOn(window, "prompt");
 render(<App />);
 fireEvent.click(await screen.findByRole("button", { name: /rename/i }));
 const input = await screen.findByLabelText(/display name|profile name/i);
 fireEvent.change(input, { target: { value: "Renamed Work" } });
 fireEvent.keyDown(input, { key: "Enter" });
 await waitFor(() => expect(api.renameProfile).toHaveBeenCalledWith({ profileId: "codex-1", name: "Renamed Work" }));
  expect((await screen.findAllByText("Renamed Work")).length).toBeGreaterThanOrEqual(1);
  expect(promptSpy).not.toHaveBeenCalled();
 promptSpy.mockRestore();
 });
 it("completes refresh all when all profiles resolve and state reloads", async () => {
 const refreshedState: AppState = {
 profiles: [
 {
 id: "codex-1",
 name: "Codex Work",
 email: "work@example.com",
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive: true,
 usage: {
 status: "available",
 weekly: { remaining: 80, limit: 100 },
 pools: [{ id: "codex-weekly", label: "Weekly", status: "available", remaining: 80, limit: 100 }]
 }
 },
 {
 id: "codex-2",
 name: "Codex Personal",
 email: "personal@example.com",
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive: false,
 usage: {
 status: "available",
 weekly: { remaining: 50, limit: 100 },
 pools: [{ id: "codex-weekly", label: "Weekly", status: "available", remaining: 50, limit: 100 }]
 }
 }
 ],
 settings: {
 activeProfileId: "codex-1",
 autoSwitchEnabled: false,
 autoSwitchThresholdPercent: 10,
 pollingIntervalMinutes: 20,
 theme: "system",
 language: "en",
 autoRefreshQuota: false,
 autoSyncCurrentAccount: false,
 syncIntervalMinutes: 5,
 startWithSystem: false,
 lowQuotaAlerts: true,
 notifyWhenAvailable: true,
 lowQuotaThresholdPercent: 15,
 proxyEnabled: false,
 proxyUrl: "",
 serviceRunning: true,
 availabilityByProfile: {}
 },
 defaultExecutablePath: "C:\\Users\\testuser\\AppData\\Local\\Programs\\Codex\\Codex.exe",
 appInfo: {
 version: "0.1.0",
 platform: "win32",
 license: "CC BY-NC-SA 4.0",
 storageEncrypted: false
 }
 };
 window.profileSwitcher = fakeApi(stateWithUsage({
 status: "available",
 weekly: { remaining: 10, limit: 100 },
 pools: [{ id: "codex-weekly", label: "Weekly", status: "available", remaining: 10, limit: 100 }]
 }));
    // SAFETY: mocking refreshAllQuotas method on ProfileSwitcherApi
    window.profileSwitcher.refreshAllQuotas = vi.fn(async () => refreshedState) as ProfileSwitcherApi["refreshAllQuotas"];
    // SAFETY: mocking getState method on ProfileSwitcherApi
    window.profileSwitcher.getState = vi.fn(async () => refreshedState) as ProfileSwitcherApi["getState"];
 render(<App />);
 const refreshButton = await screen.findByTitle("Refresh all quotas");
 fireEvent.click(refreshButton);
 await waitFor(() => expect(refreshButton).not.toBeDisabled());
 expect(await screen.findByText("80%")).toBeInTheDocument();
 });
 it("renders an empty accounts state", async () => {
 window.profileSwitcher = fakeApi(accountsState([]));
 render(<App />);
 expect(await screen.findByText("No saved Codex accounts yet.")).toBeInTheDocument();
 expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(3);
 });
 it("renders one account with active badge", async () => {
    window.profileSwitcher = fakeApi(accountsState([
      profileFixture("one", "Solo", "solo@example.com", 88, true)
    ]));
    render(<App />);
    expect((await screen.findAllByText("Solo")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("88%").length).toBeGreaterThanOrEqual(1); // 88/100 = 88%
  });
 it("renders ten accounts", async () => {
 const profiles = Array.from({ length: 10 }, (_, index) => profileFixture(`p${index}`, `Account ${index}`, `account${index}@example.com`, index === 0 ? 50 : 0, index === 0));
 window.profileSwitcher = fakeApi(accountsState(profiles));
 render(<App />);
 expect((await screen.findAllByText("Account 0")).length).toBeGreaterThanOrEqual(1);
 expect(screen.getByText("Account 9")).toBeInTheDocument();
 expect(screen.getByText("10")).toBeInTheDocument();
 });
 it("shows all accounts rate limited with limited badges and zero quota", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("a", "A", "a@example.com", 0, true),
 profileFixture("b", "B", "b@example.com", 0, false)
 ]));
 render(<App />);
 expect((await screen.findAllByText("Rate Limited")).length).toBeGreaterThanOrEqual(2);
 expect(screen.getAllByText("0%").length).toBeGreaterThanOrEqual(2); // 0/100 = 0%
 });
 it("shows mixed active, ready, and rate-limited badges", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("active", "Active One", "active@example.com", 60, true),
 profileFixture("ready", "Ready One", "ready@example.com", 97, false),
 profileFixture("limited", "Limited One", "limited@example.com", 0, false)
 ]));
 render(<App />);
 expect((await screen.findAllByText("Active")).length).toBeGreaterThanOrEqual(1);
 expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(1);
 expect(screen.getAllByText("Rate Limited").length).toBeGreaterThanOrEqual(1);
 });
 it("renders the account context menu in a body portal", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("one", "Solo", "solo@example.com", 88, true)
 ]));
 render(<App />);
 const menuButton = await screen.findByRole("button", { name: /more actions for solo/i });
 fireEvent.click(menuButton);
 const menu = document.body.querySelector(".card-menu");
 expect(menu).toBeInTheDocument();
 expect(menu?.parentElement).toBe(document.body);
 expect(menu).toHaveStyle({ position: "fixed", zIndex: "9999" });
 });
 it("shows Rate Limited on active exhausted accounts without the old banner", async () => {
    const activeLow = profileFixture("active", "Active Low", "active-low@example.com", 0, true);
    if (activeLow.usage?.pools?.[0]) {
      activeLow.usage.pools[0].status = "exhausted";
    }
    window.profileSwitcher = fakeApi(accountsState([activeLow]));
    render(<App />);
    expect((await screen.findAllByText("Active Low")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Quota exhausted, switch to a ready account")).not.toBeInTheDocument();
    expect(screen.getAllByText("Rate Limited").length).toBeGreaterThanOrEqual(1);
    const card = screen.getAllByText("Active Low").map((el) => el.closest(".account-card")).find(Boolean);
    // Exhausted quota is amber — a waiting state, not the alarm-red reserved for failures.
    expect(card?.querySelector(".quota-value")).toHaveStyle({ color: "#f59e0b" });
    expect(card?.querySelector(".bar span")).toHaveStyle({ background: "#f59e0b" });
  });
 it("uses accent orange for healthy high percentage quota bars", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("ready-high", "Ready High", "ready-high@example.com", 97, false)
 ]));
 render(<App />);
 expect(await screen.findByText("Ready High")).toBeInTheDocument();
 const card = screen.getByText("Ready High").closest(".account-card");
 expect(card?.querySelector(".quota-value")).toHaveStyle({ color: "#e06020" });
 expect(card?.querySelector(".bar span")).toHaveStyle({ background: "#e06020" });
 });
 it("uses amber for rate-limited quota bars regardless of shown percentage", async () => {
 const limited = profileFixture("limited", "Limited 24", "limited24@example.com", 24, false);
 if (limited.usage?.pools?.[0]) {
 limited.usage.pools[0].status = "exhausted";
 }
 window.profileSwitcher = fakeApi(accountsState([limited]));
 render(<App />);
 expect((await screen.findAllByText("Rate Limited")).length).toBeGreaterThanOrEqual(1);
 const card = screen.getByText("Limited 24").closest(".account-card");
 // Rate-limited is a normal cycling state \u2014 amber, not alarm-red.
 expect(card?.querySelector(".quota-value")).toHaveStyle({ color: "#f59e0b" });
 expect(card?.querySelector(".bar span")).toHaveStyle({ background: "#f59e0b" });
 });
 it("keeps a visible amber bar treatment when rate limited at zero percent", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("limited-zero", "Limited Zero", "limited-zero@example.com", 0, false)
 ]));
 render(<App />);
 expect((await screen.findAllByText("Rate Limited")).length).toBeGreaterThanOrEqual(1);
 const card = screen.getByText("Limited Zero").closest(".account-card");
 // Amber track (matching the bar) so a cycling account reads as waiting, not broken.
 expect(card?.querySelector(".bar")).toHaveStyle({
 background: "rgba(245, 158, 11, 0.16)",
 borderColor: "rgba(245, 158, 11, 0.4)"
 });
    expect(card?.querySelector(".bar span")).toHaveStyle({ background: "#f59e0b", width: "0%" });
  });

  it("renders Active now for active account, Used X ago for used account, and Updated X ago for un-activated account", async () => {
    const activeProf = {
      ...profileFixture("p-active", "Active User", "active@example.com", 80, true),
      lastUsedAt: new Date(Date.now() - 60000).toISOString(),
      updatedAt: new Date(Date.now() - 300000).toISOString()
    };
    const usedProf = {
      ...profileFixture("p-used", "Used User", "used@example.com", 50, false),
      lastUsedAt: new Date(Date.now() - 7200000).toISOString(),
      updatedAt: new Date(Date.now() - 300000).toISOString()
    };
    const updatedProf = {
      ...profileFixture("p-updated", "Updated User", "updated@example.com", 90, false),
      lastUsedAt: undefined,
      updatedAt: new Date(Date.now() - 300000).toISOString()
    };

    window.profileSwitcher = fakeApi(accountsState([activeProf, usedProf, updatedProf]));
    render(<App />);

    expect(await screen.findByText("Active User")).toBeInTheDocument();
    expect(screen.getByText("Active now")).toBeInTheDocument();
    expect(screen.getByText(/Used 2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/Updated 5m ago/)).toBeInTheDocument();
  });
 it.skip("switches between grid, list, and compact account views", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("one", "One", "one@example.com", 50, true)
 ]));
 const { container } = render(<App />);
 expect(await screen.findByText("One")).toBeInTheDocument();
 expect(container.querySelector(".account-grid.grid")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: /list/i }));
 expect(container.querySelector(".account-grid.list")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: /compact/i }));
 expect(container.querySelector(".account-grid.compact")).toBeInTheDocument();
 });
 it.skip("uses a compact dashed placeholder for unavailable quota", async () => {
 window.profileSwitcher = fakeApi(accountsState([
 profileFixture("unknown", "Unknown", "unknown@example.com", undefined, false)
 ]));
 const { container } = render(<App />);
 expect(await screen.findByText("Quota unavailable")).toBeInTheDocument();
 const placeholder = container.querySelector(".quota-bar--unavailable");
 expect(placeholder).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button", { name: /compact/i }));
 expect(container.querySelector(".account-grid.compact .quota-bar--unavailable .bar-placeholder")).toBeInTheDocument();
 expect(container.querySelector(".account-grid.compact .quota-bar--unavailable .bar-placeholder-pct")).toHaveTextContent("—");
 });
  it("calculates stats and global quota from known quota accounts", async () => {
    window.profileSwitcher = fakeApi(accountsState([
      profileFixture("active", "Active", "active@example.com", 100, true),
      profileFixture("ready", "Ready", "ready@example.com", 50, false),
      profileFixture("unknown", "Unknown", "unknown@example.com", undefined, false)
    ]));
    render(<App />);
    expect(await screen.findByText("Global quota")).toBeInTheDocument();
    const statText = Array.from(document.querySelectorAll(".stat-box")).map((element) => element.textContent);
    expect(statText).toEqual(expect.arrayContaining(["3Accounts", "2Ready", "0Rate Limited", "75%Global quota"]));
  });
});
function fakeApi(state: AppState): ProfileSwitcherApi {
  return {
    getState: vi.fn(async () => state),
    beginLoginCapture: vi.fn(async () => ({ captureId: "capture-1", suggestedName: "person@example.com", accountEmail: "person@example.com" })),
    startLoginCapture: vi.fn(async () => ({ captureId: "capture-1", authorizationUrl: "https://auth.openai.com/oauth/authorize" })),
    openLoginCapture: vi.fn(async () => undefined),
    waitLoginCapture: vi.fn(async () => ({ captureId: "capture-1", suggestedName: "person@example.com", accountEmail: "person@example.com" })),
    cancelLoginCapture: vi.fn(async () => undefined),
    createProfile: vi.fn(async () => state),
    syncCurrentProfile: vi.fn(async () => state),
    switchProfile: vi.fn(async () => ({ previousActiveId: undefined, targetProfileId: "codex-1", status: "success" as const })),
    backupProfile: vi.fn(async () => state),
    deleteProfile: vi.fn(async () => state),
    renameProfile: vi.fn(async () => state),
    refreshUsage: vi.fn(async () => ({ status: "unavailable" })),
    refreshAllQuotas: vi.fn(async () => state),
    updateSettings: vi.fn(async () => state),
    updateServiceState: vi.fn(async () => state),
    exportProfiles: vi.fn(async () => ({ count: 1 })),
    previewImport: vi.fn(async () => null),
    confirmImport: vi.fn(async () => ({ count: 1 })),
    openProfileFolder: vi.fn(async () => undefined),
    openLogDirectory: vi.fn(async () => undefined),
    browseExecutable: vi.fn(async () => null),
    checkForUpdates: vi.fn(async () => "up-to-date"),
    needsPassphrase: vi.fn(async () => false),
    unlock: vi.fn(async () => true),
    focusProfile: vi.fn(() => () => undefined),
    stateChanged: vi.fn(() => () => undefined),
    setTheme: vi.fn()
  };
}
function stateWithUsage(usage: AppState["profiles"][number]["usage"]): AppState {
 return {
 profiles: [
 {
 id: "codex-1",
 name: "Codex Work",
 email: "work@example.com",
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive: true,
 usage
 }
 ],
 settings: {
 activeProfileId: "codex-1",
 autoSwitchEnabled: false,
 autoSwitchThresholdPercent: 10,
 pollingIntervalMinutes: 20,
 theme: "system",
 language: "en",
 autoRefreshQuota: false,
 autoSyncCurrentAccount: false,
 syncIntervalMinutes: 5,
 startWithSystem: false,
 lowQuotaAlerts: true,
 notifyWhenAvailable: true,
 lowQuotaThresholdPercent: 15,
 proxyEnabled: false,
 proxyUrl: "",
 serviceRunning: true,
 availabilityByProfile: {}
 },
 defaultExecutablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Codex\\Codex.exe",
 appInfo: {
 version: "0.1.0",
 platform: "win32",
 license: "CC BY-NC-SA 4.0",
 storageEncrypted: false
 }
 };
}
function accountsState(profiles: AppState["profiles"]): AppState {
 return {
 profiles,
 settings: {
 activeProfileId: profiles.find((profile) => profile.isActive)?.id,
 autoSwitchEnabled: false,
 autoSwitchThresholdPercent: 10,
 pollingIntervalMinutes: 20,
 theme: "system",
 language: "en",
 autoRefreshQuota: false,
 autoSyncCurrentAccount: false,
 syncIntervalMinutes: 5,
 startWithSystem: false,
 lowQuotaAlerts: true,
 notifyWhenAvailable: true,
 lowQuotaThresholdPercent: 15,
 proxyEnabled: false,
 proxyUrl: "",
 serviceRunning: true,
 availabilityByProfile: {}
 },
 defaultExecutablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Codex\\Codex.exe",
 appInfo: {
 version: "0.1.0",
 platform: "win32",
 license: "CC BY-NC-SA 4.0",
 storageEncrypted: false
 }
 };
}
function profileFixture(
 id: string,
 name: string,
 email: string,
 quotaPercentValue: number | undefined,
 isActive = false
): AppState["profiles"][number] {
 return {
 id,
 name,
 email,
 createdAt: "2026-05-17T00:00:00.000Z",
 updatedAt: "2026-05-17T00:00:00.000Z",
 isActive,
 usage: quotaPercentValue === undefined
 ? { status: "unavailable", message: "No quota" }
 : {
 status: "available",
 weekly: { remaining: quotaPercentValue, limit: 100 },
 pools: [{
 id: "codex-weekly",
 label: "Weekly",
 status: quotaPercentValue <= 0 ? "exhausted" : "available",
 remaining: quotaPercentValue,
 limit: 100
 }]
 }
 };
}
