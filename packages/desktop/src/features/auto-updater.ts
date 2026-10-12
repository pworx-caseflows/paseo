import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

interface AppUpdateLogSink {
  info(message: string, details: object): void;
}

interface AppUpdateCheckLogDetails {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}

interface AppUpdateCheckCompletedLogDetails extends AppUpdateCheckLogDetails {
  targetVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  errorMessage: string | null;
}

export function createAppUpdateLifecycleLogger(logger: AppUpdateLogSink) {
  return {
    checkStarted(details: AppUpdateCheckLogDetails): void {
      logger.info("[auto-updater] check started", details);
    },
    checkCompleted(details: AppUpdateCheckCompletedLogDetails): void {
      logger.info("[auto-updater] check completed", details);
    },
    updateAvailable(targetVersion: string): void {
      logger.info("[auto-updater] update available", { targetVersion });
    },
    updateDownloaded(targetVersion: string): void {
      logger.info("[auto-updater] update downloaded", { targetVersion });
    },
    downloadRequested(targetVersion: string): void {
      logger.info("[auto-updater] download requested", { targetVersion });
    },
    quitAndInstallRequested(details: AppUpdateInstallRequest): void {
      logger.info("[auto-updater] quitAndInstall requested", details);
    },
  };
}

const updateLifecycleLog = createAppUpdateLifecycleLogger(log);

/**
 * PW build: a Paseo that restarted itself after an update carries Linux's "no new privileges"
 * mark, and with it pkexec refuses to run ("pkexec must be setuid root"), so the update did
 * nothing. Then the install command goes through the desktop's service manager, which starts
 * it fresh without the mark, and the password prompt appears (card "Our own Paseo build").
 */
export function wrapSudoForServiceManager(
  sudo: readonly string[],
  context: { hasNoNewPrivs: boolean; hasSystemdRun: boolean },
): string[] {
  const [command, ...args] = sudo;
  if (!command || !context.hasNoNewPrivs || !context.hasSystemdRun) return [...sudo];
  // One string, so electron-updater still sees pkexec in it and quotes the command the same way.
  return [`systemd-run --user --wait --pipe --collect --quiet ${command}`, ...args];
}

function hasNoNewPrivs(): boolean {
  try {
    return /^NoNewPrivs:\s*1$/m.test(readFileSync("/proc/self/status", "utf8"));
  } catch {
    return false;
  }
}

function hasSystemdRun(): boolean {
  return spawnSync("sh", ["-c", "command -v systemd-run"], { stdio: "ignore" }).status === 0;
}

function routeLinuxInstallThroughServiceManager(): void {
  if (process.platform !== "linux") return;
  const updater = autoUpdater as unknown as {
    sudoWithArgs?: (installComment: string) => string[];
  };
  const original = updater.sudoWithArgs;
  if (typeof original !== "function") return;
  updater.sudoWithArgs = function (this: unknown, installComment: string) {
    return wrapSudoForServiceManager(original.call(this, installComment), {
      hasNoNewPrivs: hasNoNewPrivs(),
      hasSystemdRun: hasSystemdRun(),
    });
  };
}

interface UpdaterMessageSink {
  info(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  error(...params: unknown[]): void;
}

function describeUpdaterMessage(message: unknown): string {
  if (message instanceof Error) return message.stack ?? message.message;
  return typeof message === "string" ? message : JSON.stringify(message);
}

export function createUpdaterMessageLogger(sink: UpdaterMessageSink) {
  return {
    info: (message: unknown) => sink.info("[electron-updater]", describeUpdaterMessage(message)),
    warn: (message: unknown) => sink.warn("[electron-updater]", describeUpdaterMessage(message)),
    error: (message: unknown) => {
      if (isUpdateChannelNotPublished(message)) return;
      if (typeof message === "string" && message.includes("Cannot find channel")) return;
      sink.error("[electron-updater]", describeUpdaterMessage(message));
    },
  };
}

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  return shouldAdmitAppUpdate({ ...args, intent: "automatic" });
}

export async function resolveStagingUserId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, "utf8")).trim();
    if (UUID.check(id)) {
      return id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-updater] Couldn't read staging user ID, creating a blank one: ${error}`);
    }
  }

  const id = UUID.v5(randomBytes(4096), UUID.OID);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, id);
  } catch (error) {
    console.warn(`[auto-updater] Couldn't write out staging user ID: ${error}`);
  }

  return id;
}

export function getStagingUserId(): Promise<string> {
  if (cachedStagingUserIdPromise == null) {
    cachedStagingUserIdPromise = resolveStagingUserId(
      path.join(app.getPath("userData"), ".updaterId"),
    );
  }
  return cachedStagingUserIdPromise;
}

export function shouldInstallAppUpdateOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  // AppImage's no-relaunch install path blocks while launching the replacement
  // binary, which can hang after the running file has already been replaced.
  return !(input.platform === "linux" && input.isAppImage);
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configured = false;

  configure(input: AppUpdateRuntimeConfiguration): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoRunAppAfterInstall = true;
    // Paseo revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    // PW build: our fork publishes no beta releases, so the updater stays on stable whatever
    // channel an older setting holds (card "Our own Paseo build" on the board).
    autoUpdater.allowPrerelease = false;
    autoUpdater.channel = "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await input.shouldAdmitUpdate(info as RuntimeUpdateInfo);
      } catch {
        return true;
      }
    };

    if (this.configured) return;
    this.configured = true;

    // PW build: electron-updater's own messages - the install command, the admin-password
    // prompt, a failed install - go into Paseo's log, so a failed update records why
    // (card "Our own Paseo build" on the board). The missing-channel error stays out.
    autoUpdater.logger = createUpdaterMessageLogger(log);
    routeLinuxInstallThroughServiceManager();

    autoUpdater.on("update-available", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateAvailable(updateInfo.version);
      input.onUpdateAvailable(updateInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateDownloaded(updateInfo.version);
      input.onUpdateDownloaded(updateInfo);
    });
    autoUpdater.on("error", (error) => {
      if (isUpdateChannelNotPublished(error)) return;
      input.onError(error);
    });
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo as RuntimeUpdateInfo,
      };
    } catch (error) {
      if (isUpdateChannelNotPublished(error)) return null;
      throw error;
    }
  }

  downloadUpdate(targetVersion: string): Promise<unknown> {
    updateLifecycleLog.downloadRequested(targetVersion);
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall({ targetVersion, isSilent, isForceRunAfter }: AppUpdateInstallRequest): void {
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested({
      targetVersion,
      isSilent,
      isForceRunAfter,
    });
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
  },
  reportRuntimeError: (error) => {
    console.error("[auto-updater] Updater event failed:", error);
  },
  reportInstallError: (message) => {
    console.error("[auto-updater] Failed to download/install update:", message);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}): Promise<AppUpdateCheckResult> {
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
  });
  updateLifecycleLog.checkCompleted({
    currentVersion,
    targetVersion: result.latestVersion,
    releaseChannel,
    intent,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function downloadAndInstallUpdate(
  {
    currentVersion,
    releaseChannel,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
  },
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  return appUpdateService.downloadAndInstallUpdate(
    { currentVersion, releaseChannel },
    onBeforeQuit,
  );
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
}): Promise<boolean> {
  if (
    !shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    })
  ) {
    return false;
  }

  return appUpdateService.installUpdateOnQuit({ currentVersion, releaseChannel, signal });
}
