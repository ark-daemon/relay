import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ProfileActionInput,
  ProfileExportResult,
  ProfileImportPreview,
  ProfileLoginCapture,
  ProfileSummary,
  SettingsUpdateInput,
  StatusMessage
} from "./shared/types";
import { copyForLanguage, formatMessage, PSEUDO_LOCALE_STORAGE_KEY, readPseudoLocaleEnabled } from "./i18n";
import {
  buildStats,
  errorMessage,
  firstProfile,
  firstProfileByCreatedAt,
  getApi,
  requireApi,
  resolveTheme
} from "./ui-utils";
import { Sidebar } from "./components/Sidebar";
import { AccountsPage } from "./components/AccountsPage";
import { SettingsPage } from "./components/SettingsPage";
import { StatusToast } from "./components/StatusToast";
import { ImportPreviewModal } from "./components/ImportPreviewModal";
import { LoginCaptureModal } from "./components/LoginCaptureModal";
import { PromptModal, type PromptModalConfig } from "./components/PromptModal";

type View = "accounts" | "settings";
type LoginFlowStatus = "idle" | "ready" | "waiting" | "error" | "saved";

interface LoginModalState {
  open: boolean;
  captureId?: string;
  authorizationUrl?: string;
  status: LoginFlowStatus;
  message?: string;
  capture?: ProfileLoginCapture;
  profileName?: string;
}
export function App() {
  const [state, setState] = useState<AppState | undefined>();
  const [selected, setSelected] = useState<ProfileActionInput | undefined>();
  const [view, setView] = useState<View>("accounts");
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<StatusMessage | undefined>();
  const [fatal, setFatal] = useState<string | undefined>();
  const [loginModal, setLoginModal] = useState<LoginModalState>({ open: false, status: "idle" });
  const [promptModal, setPromptModal] = useState<PromptModalConfig | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(() => new Set());
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [importPreview, setImportPreview] = useState<ProfileImportPreview | null>(null);
  const [autoSwitchSessionCount, setAutoSwitchSessionCount] = useState(0);
  const [pseudoLocaleEnabled, setPseudoLocaleEnabled] = useState(() => readPseudoLocaleEnabled());
  const previousActiveProfileIdRef = useRef<string | undefined>(undefined);
  const manualSwitchInProgressRef = useRef(false);
  const selectedProfile = useMemo(() => {
    if (!state || !selected) {
      return undefined;
    }
    return state.profiles.find((profile) => profile.id === selected.profileId);
  }, [selected, state]);
  const stats = useMemo(() => buildStats(state), [state]);
  const copy = useMemo(() => copyForLanguage(state?.settings.language), [state?.settings.language]);
  useEffect(() => {
    const api = getApi();
    if (!api) {
      setFatal(copyForLanguage().startup.bridgeMissing);
      return;
    }
    // Security: when no OS keychain is available, prompt for a session
    // passphrase and unlock BEFORE loading state, so the first auth read/write
    // has key material and credentials are never persisted in the clear.
    void (async () => {
      const unlockCopy = copyForLanguage();
      try {
        if (await api.needsPassphrase()) {
          setPromptModal({
            open: true,
            title: unlockCopy.prompts.passphraseTitle,
            description: unlockCopy.prompts.passphraseDescription,
            inputLabel: unlockCopy.prompts.passphraseLabel,
            placeholder: unlockCopy.prompts.passphrasePlaceholder,
            inputType: "password",
            confirmText: unlockCopy.actions.unlock,
            onSubmit: async (pass) => {
              setPromptModal(null);
              if (pass) {
                await api.unlock({ passphrase: pass });
              }
              await loadState();
            },
            onCancel: () => {
              setPromptModal(null);
              void loadState();
            }
          });
          return;
        }
      } catch {
        // If the unlock probe fails, fall through to loadState; auth writes will
        // surface a clear error if sealing is still unavailable.
      }
      await loadState();
    })();
    const cleanupFocus = api.focusProfile((input) => {
      void loadState(false, false).then(() => setSelected(input));
      setMessage({ kind: "info", text: copyForLanguage().messages.focusedFromNotification });
    });
    const cleanupState = api.stateChanged(() => {
      void loadState(false, false);
    });
    return () => {
      cleanupFocus();
      cleanupState();
    };
  }, []);
  useEffect(() => {
    if (!state) {
      return;
    }
    const resolvedTheme = resolveTheme(state.settings.theme);
    document.documentElement.dataset.theme = resolvedTheme;
    window.profileSwitcher?.setTheme?.(resolvedTheme);
  }, [state?.settings.theme]);
  useEffect(() => {
    if (!globalThis.window) {
      return;
    }
    function handlePseudoLocaleShortcut(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== "p") {
        return;
      }
      event.preventDefault();
      const next = !readPseudoLocaleEnabled();
      window.localStorage.setItem(PSEUDO_LOCALE_STORAGE_KEY, next ? "1" : "0");
      setPseudoLocaleEnabled(next);
      void updateSettings({ language: next ? "pseudo" : "en" });
    }
    window.addEventListener("keydown", handlePseudoLocaleShortcut);
    return () => window.removeEventListener("keydown", handlePseudoLocaleShortcut);
  }, []);
  useEffect(() => {
    if (!state) {
      return;
    }
    setSelectedAccountIds((current) => {
      const validIds = new Set(state.profiles.map((profile) => profile.id));
      const next = new Set([...current].filter((profileId) => validIds.has(profileId)));
      return next.size === current.size ? current : next;
    });
  }, [state?.profiles]);
  useEffect(() => {
    if (!state) {
      return;
    }
    const currentActiveProfileId = state.settings.activeProfileId;
    const previousActiveProfileId = previousActiveProfileIdRef.current;
    if (previousActiveProfileId && currentActiveProfileId && previousActiveProfileId !== currentActiveProfileId) {
      if (manualSwitchInProgressRef.current) {
        manualSwitchInProgressRef.current = false;
      } else if (state.settings.autoSwitchEnabled) {
        setAutoSwitchSessionCount((count) => count + 1);
      }
    }
    previousActiveProfileIdRef.current = currentActiveProfileId;
  }, [state?.settings.activeProfileId, state?.settings.autoSwitchEnabled]);
  useEffect(() => {
    if (!message) {
      return;
    }
    const timeout = window.setTimeout(() => setMessage(undefined), message.kind === "error" ? 7000 : 3500);
    return () => window.clearTimeout(timeout);
  }, [message]);
  async function loadState(refreshActiveUsage = true, showBusy = true) {
    const api = getApi();
    if (!api) {
      setFatal(copy.startup.bridgeMissing);
      return;
    }
    if (showBusy) {
      setBusy(copy.messages.loadingProfiles);
    }
    try {
      let nextState = await api.getState();
      const activeProfile = nextState.profiles.find((profile) => profile.isActive);
      if (refreshActiveUsage && activeProfile && nextState.settings.autoRefreshQuota) {
        await api.refreshUsage({ profileId: activeProfile.id });
        nextState = await api.getState();
      }
      setState(nextState);
      setSelected((current) => current ?? firstProfile(nextState));
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      if (showBusy) {
        setBusy(undefined);
      }
    }
  }
  async function runAction<T>(label: string, action: () => Promise<T>, after?: (result: T) => void | boolean | Promise<void | boolean>) {
    setBusy(label);
    setMessage(undefined);
    try {
      const result = await action();
      // SAFETY: checking optional count field on action result
      if (result && Number.isFinite((result as { count?: number }).count)) {
        // SAFETY: verified count property is a finite number
        const count = (result as { count: number }).count;
        if (count === 0) {
          return;
        }
      }
      const customHandled = await after?.(result);
      if (customHandled !== true) {
        setMessage({ kind: "success", text: formatMessage(copy.messages.actionFinished, { label }) });
      }
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }
  async function createProfile() {
    const api = requireApi(setFatal);
    if (!api) return;
    setBusy(copy.messages.preparingLogin);
    try {
      const session = await api.startLoginCapture();
      setLoginModal({
        open: true,
        captureId: session.captureId,
        authorizationUrl: session.authorizationUrl,
        status: "ready",
        message: copy.login.readyOpenLogin
      });
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }
  async function openLoginPageFromModal() {
    const api = requireApi(setFatal);
    if (!api || !loginModal.captureId) return;
    setLoginModal((current) => ({
      ...current,
      status: "waiting",
      message: copy.login.waitingSignIn
    }));
    try {
      await api.openLoginCapture({ captureId: loginModal.captureId });
      const capture = await api.waitLoginCapture({ captureId: loginModal.captureId });
      setLoginModal((current) => ({
        ...current,
        status: "ready",
        message: copy.login.signInComplete,
        capture,
        profileName: capture.suggestedName ?? capture.accountEmail ?? copy.messages.defaultProfileName
      }));
    } catch (error) {
      const msg = errorMessage(error);
      const isRecoverable =
        msg.toLowerCase().includes("state mismatch") ||
        msg.toLowerCase().includes("timed out");
      if (isRecoverable) {
        try {
          const session = await api.startLoginCapture();
          setLoginModal((current) => ({
            ...current,
            captureId: session.captureId,
            authorizationUrl: session.authorizationUrl,
            status: "ready",
            message: copy.login.sessionExpired,
            capture: undefined
          }));
        } catch (freshError) {
          setLoginModal((current) => ({
            ...current,
            status: "error",
            message: errorMessage(freshError)
          }));
        }
      } else {
        setLoginModal((current) => ({
          ...current,
          status: "error",
          message: msg
        }));
      }
    }
  }
  async function saveLoginProfile() {
    const api = requireApi(setFatal);
    if (!api || !loginModal.capture) return;
    setBusy(copy.messages.savingAccount);
    try {
      const name = loginModal.profileName?.trim() || loginModal.capture.suggestedName || loginModal.capture.accountEmail || copy.messages.defaultProfileName;
      const nextState = await api.createProfile({ captureId: loginModal.capture.captureId, name });
      setState(nextState);
      setSelected(firstProfileByCreatedAt(nextState));
      setLoginModal({ open: true, status: "saved", message: name });
    } catch (error) {
      setLoginModal((current) => ({
        ...current,
        status: "error",
        message: errorMessage(error)
      }));
    } finally {
      setBusy(undefined);
    }
  }
  async function addAnotherAccount() {
    const api = requireApi(setFatal);
    if (!api) return;
    setBusy(copy.messages.preparingLogin);
    try {
      const session = await api.startLoginCapture();
      setLoginModal({
        open: true,
        captureId: session.captureId,
        authorizationUrl: session.authorizationUrl,
        status: "ready",
        message: copy.login.readyOpenLogin
      });
    } catch (error) {
      setLoginModal((current) => ({
        ...current,
        status: "error",
        message: errorMessage(error)
      }));
    } finally {
      setBusy(undefined);
    }
  }
  async function cancelLoginModal() {
    const api = requireApi(setFatal);
    if (!api) return;
    const captureId = loginModal.captureId;
    setLoginModal({ open: false, status: "idle" });
    if (!captureId) {
      return;
    }
    try {
      await api.cancelLoginCapture({ captureId });
    } catch {
      // Ignore cleanup errors when the session has already completed.
    }
  }
  async function syncFromApp() {
    const api = requireApi(setFatal);
    if (!api) return;
    setPromptModal({
      open: true,
      title: copy.prompts.nameImportedTitle,
      description: copy.prompts.nameImportedDescription,
      inputLabel: copy.prompts.profileNameLabel,
      defaultValue: copy.messages.defaultSyncName,
      placeholder: copy.messages.defaultSyncName,
      inputType: "text",
      confirmText: copy.actions.sync,
      onSubmit: async (name) => {
        setPromptModal(null);
        await runAction(copy.messages.syncFromApp, () => api.syncCurrentProfile({ name: name.trim() || copy.messages.defaultSyncName }), (nextState) => {
          setState(nextState);
          setSelected(firstProfileByCreatedAt(nextState));
          return false;
        });
      },
      onCancel: () => setPromptModal(null)
    });
  }
  async function switchProfile(profile: ProfileSummary) {
    const api = requireApi(setFatal);
    if (!api) return;
    manualSwitchInProgressRef.current = true;
    try {
      await runAction(copy.messages.switchProfile, () => api.switchProfile({ profileId: profile.id }), async () => {
        await loadState(false);
        setSelected({ profileId: profile.id });
      });
    } finally {
      manualSwitchInProgressRef.current = false;
    }
  }
  async function refreshUsage(profile: ProfileSummary) {
    const api = requireApi(setFatal);
    if (!api) return;
    await runAction(copy.messages.refreshUsage, () => api.refreshUsage({ profileId: profile.id }), () => {
      void loadState(false);
    });
  }
  async function refreshAll() {
    if (!state || refreshingAll) return;
    const api = requireApi(setFatal);
    if (!api) return;
    setRefreshingAll(true);
    setMessage(undefined);
    try {
      const nextState = await api.refreshAllQuotas();
      setState(nextState);
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setRefreshingAll(false);
    }
  }
  async function backupProfile(profile: ProfileSummary) {
    const api = requireApi(setFatal);
    if (!api) return;
    await runAction(copy.messages.backupProfile, () => api.backupProfile({ profileId: profile.id }), setState);
  }
  async function renameProfile(profile: ProfileSummary, name: string) {
    const api = requireApi(setFatal);
    if (!api) return;
    await runAction(copy.messages.renameProfile, () => api.renameProfile({ profileId: profile.id, name }), setState);
  }
  async function deleteProfile(profile: ProfileSummary) {
    const api = requireApi(setFatal);
    if (!api) return;
    await runAction(copy.messages.deleteProfile, () => api.deleteProfile({ profileId: profile.id }), (nextState) => {
      setState(nextState);
      setSelected(firstProfile(nextState));
    });
  }
  async function deleteSelectedProfiles() {
    if (!state || selectedAccountIds.size === 0) return;
    const api = requireApi(setFatal);
    if (!api) return;
    const selectedProfiles = state.profiles.filter((profile) => selectedAccountIds.has(profile.id));
    const count = selectedProfiles.length;
    if (count === 0) return;
    await runAction(copy.messages.deleteSelected, async () => {
      let nextState = state;
      for (const profile of selectedProfiles) {
        nextState = await api.deleteProfile({ profileId: profile.id });
      }
      return nextState;
    }, (nextState) => {
      setState(nextState);
      setSelectedAccountIds(new Set());
      setSelected(firstProfile(nextState));
    });
  }
  function toggleAccountSelection(profileId: string) {
    setSelectedAccountIds((current) => {
      const next = new Set(current);
      if (next.has(profileId)) {
        next.delete(profileId);
      } else {
        next.add(profileId);
      }
      return next;
    });
  }
  function toggleAllAccounts() {
    if (!state) return;
    setSelectedAccountIds((current) => {
      if (current.size === state.profiles.length) {
        return new Set();
      }
      return new Set(state.profiles.map((profile) => profile.id));
    });
  }
  async function openProfileFolder(input: ProfileActionInput) {
    const api = requireApi(setFatal);
    if (!api) return;
    await api.openProfileFolder(input);
  }
  async function exportProfiles() {
    const api = requireApi(setFatal);
    if (!api) return;
    setPromptModal({
      open: true,
      title: copy.prompts.exportTitle,
      description: copy.prompts.exportDescription,
      inputLabel: copy.prompts.exportPassphraseLabel,
      placeholder: copy.prompts.exportPassphrasePlaceholder,
      inputType: "password",
      confirmText: copy.actions.export,
      onSubmit: async (pass) => {
        if (!pass.trim()) {
          setMessage({ kind: "error", text: copy.messages.exportPassphraseRequired });
          return;
        }
        setPromptModal(null);
        await runAction(copy.messages.exportProfiles, () => api.exportProfiles({ passphrase: pass.trim() }), (result: ProfileExportResult) => {
          if (result && Number.isFinite(result.count) && result.count > 0) {
            const count = result.count;
            const template = count === 1 ? copy.messages.exported : copy.messages.exportedPlural;
            setMessage({ kind: "success", text: formatMessage(template, { count }) });
            return true;
          }
          return false;
        });
      },
      onCancel: () => setPromptModal(null)
    });
  }
  async function importProfiles() {
    const api = requireApi(setFatal);
    if (!api) return;
    setBusy(copy.messages.previewImport);
    try {
      const preview = await api.previewImport();
      if (!preview) return;
      // Encrypted bundle: previewImport returns no profiles + encrypted flag.
      // Prompt for the passphrase and import directly by path so we don't
      // re-open the file dialog.
      if (preview.encrypted && preview.profiles.length === 0) {
        const { path } = preview;
        setPromptModal({
          open: true,
          title: copy.prompts.importEncryptedTitle,
          description: copy.prompts.importEncryptedDescription,
          inputLabel: copy.prompts.importPassphraseLabel,
          placeholder: copy.prompts.importPassphrasePlaceholder,
          inputType: "password",
          confirmText: copy.actions.import,
          onSubmit: async (pass) => {
            setPromptModal(null);
            if (!pass) return;
            await runAction(copy.messages.importProfiles, () => api.confirmImport({ path, passphrase: pass }), async (result) => {
              await loadState(false);
              const template = result.count === 1 ? copy.messages.imported : copy.messages.importedPlural;
              setMessage({ kind: "success", text: formatMessage(template, { count: result.count }) });
              void refreshAll();
              return true;
            });
          },
          onCancel: () => setPromptModal(null)
        });
        return;
      }
      setImportPreview(preview);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : copy.messages.importFailed });
    } finally {
      setBusy(undefined);
    }
  }
  async function confirmImportProfiles() {
    const api = requireApi(setFatal);
    if (!api || !importPreview) return;
    const { path } = importPreview;
    setImportPreview(null);
    await runAction(copy.messages.importProfiles, () => api.confirmImport({ path }), async (result) => {
      await loadState(false);
      const template = result.count === 1 ? copy.messages.imported : copy.messages.importedPlural;
      setMessage({ kind: "success", text: formatMessage(template, { count: result.count }) });
      void refreshAll();
    });
  }
  async function updateSettings(input: SettingsUpdateInput) {
    const api = requireApi(setFatal);
    if (!api) return;
    setBusy(copy.messages.saveSettings);
    setMessage(undefined);
    try {
      const nextState = await api.updateSettings(input);
      setState(nextState);
      setMessage({ kind: "success", text: copy.messages.settingsSaved });
      window.setTimeout(() => {
        setMessage((current) => current?.text === copy.messages.settingsSaved ? undefined : current);
      }, 2000);
    } catch (error) {
      setMessage({ kind: "error", text: errorMessage(error) });
    } finally {
      setBusy(undefined);
    }
  }
  async function setServiceRunning(running: boolean) {
    const api = requireApi(setFatal);
    if (!api) return;
    await runAction(running ? copy.messages.startService : copy.messages.stopService, () => api.updateServiceState({ running }), setState);
  }
  async function openLogDirectory() {
    const api = requireApi(setFatal);
    if (!api) return;
    await api.openLogDirectory();
  }
  if (fatal) {
    return (
      <main className="loading">
        <div>
          <h2>Startup Error</h2>
          <p>{fatal}</p>
          <p>{copy.startup.retry}</p>
        </div>
      </main>
    );
  }
  if (!state) {
    return <main className="loading">{copy.startup.loading}</main>;
  }
  return (
    <div className="app-container">
      <main className="workspace">
        <Sidebar
          state={state}
          copy={copy}
          view={view}
          setView={setView}
          autoSwitchSessionCount={autoSwitchSessionCount}
          onUpdateSettings={updateSettings}
          onSetServiceRunning={setServiceRunning}
        />
        <section className="main-panel">
          {busy && <div className="busy">{busy}...</div>}
          {view === "accounts" ? (
            <AccountsPage
              state={state}
              copy={copy}
              selectedProfile={selectedProfile}
              stats={stats}
              onCreateProfile={createProfile}
              onSyncFromApp={syncFromApp}
              onExportProfiles={exportProfiles}
              onImportProfiles={importProfiles}
              onRefreshAll={refreshAll}
              refreshingAll={refreshingAll}
              selectedAccountIds={selectedAccountIds}
              onToggleAccountSelection={toggleAccountSelection}
              onToggleAllAccounts={toggleAllAccounts}
              onDeleteSelectedProfiles={deleteSelectedProfiles}
              onSelectProfile={(profileId) => setSelected({ profileId })}
              onSwitchProfile={switchProfile}
              onRefreshUsage={refreshUsage}
              onRenameProfile={renameProfile}
              onDeleteProfile={deleteProfile}
              onBackupProfile={backupProfile}
              onOpenProfileFolder={(profile) => void openProfileFolder({ profileId: profile.id })}
            />
          ) : (
            <SettingsPage
              state={state}
              copy={copy}
              pseudoLocaleEnabled={pseudoLocaleEnabled}
              onSave={updateSettings}
              onOpenLogDirectory={openLogDirectory}
            />
          )}
        </section>
        {message && <StatusToast message={message} onClose={() => setMessage(undefined)} closeLabel={copy.actions.closeMessage} />}
        {loginModal.open && (
          <LoginCaptureModal
            loginModal={loginModal}
            copy={copy}
            onAddAnother={addAnotherAccount}
            onDone={() => setLoginModal({ open: false, status: "idle" })}
            onOpenLoginPage={openLoginPageFromModal}
            onSave={saveLoginProfile}
            onCancel={cancelLoginModal}
            onChangeProfileName={(name) => setLoginModal((current) => ({ ...current, profileName: name }))}
          />
        )}
        {importPreview && (
          <ImportPreviewModal
            preview={importPreview}
            copy={copy}
            onConfirm={confirmImportProfiles}
            onCancel={() => setImportPreview(null)}
          />
        )}
        <PromptModal config={promptModal} copy={copy} />
      </main>
    </div>
  );
}
