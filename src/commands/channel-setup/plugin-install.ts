// Channel setup plugin install/reload helpers used by onboarding and channel commands.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveConfiguredChannelPluginIds,
  resolveDiscoverableScopedChannelPluginIds,
} from "../../plugins/channel-plugin-ids.js";
import { normalizePluginsConfigWithResolver } from "../../plugins/config-policy.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "../../plugins/discovery.js";
import { describePluginInstallSource } from "../../plugins/install-source-info.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../../plugins/installed-plugin-index-record-reader.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { createPluginLoaderLogger } from "../../plugins/logger.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import {
  ensureOnboardingPluginInstalled,
  type OnboardingPluginInstallEntry,
  type OnboardingPluginInstallStatus,
} from "../onboarding-plugin-install.js";
import { getTrustedChannelPluginCatalogEntry } from "./trusted-catalog.js";

type InstallResult = {
  cfg: OpenClawConfig;
  installed: boolean;
  pluginId?: string;
  status: OnboardingPluginInstallStatus;
};

function toOnboardingPluginInstallEntry(
  entry: ChannelPluginCatalogEntry,
): OnboardingPluginInstallEntry {
  return {
    pluginId: entry.pluginId ?? entry.id,
    label: entry.meta.label,
    install: entry.install,
    ...(entry.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
  };
}

/** Install or reuse the plugin package required by a trusted channel catalog entry. */
export async function ensureChannelSetupPluginInstalled(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  promptInstall?: boolean;
  autoConfirmSingleSource?: boolean;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<InstallResult> {
  const result = await ensureOnboardingPluginInstalled({
    cfg: params.cfg,
    entry: toOnboardingPluginInstallEntry(params.entry),
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
    ...(params.promptInstall !== undefined ? { promptInstall: params.promptInstall } : {}),
    ...(params.autoConfirmSingleSource !== undefined
      ? { autoConfirmSingleSource: params.autoConfirmSingleSource }
      : {}),
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
  });
  return {
    cfg: result.cfg,
    installed: result.installed,
    pluginId: result.pluginId,
    status: result.status,
  };
}

function loadChannelSetupPluginRegistry(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  onlyPluginIds?: string[];
  activate?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  trustedCatalogOwner?: ChannelPluginCatalogEntry;
}): PluginRegistry {
  const autoEnabled = applyPluginAutoEnable({ config: params.cfg, env: process.env });
  const resolvedConfig = autoEnabled.config;
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const onlyPluginIds =
    params.onlyPluginIds ??
    resolveConfiguredChannelPluginIds({
      config: resolvedConfig,
      activationSourceConfig: params.cfg,
      workspaceDir,
      env: process.env,
    });
  const trustedOwnerScope = params.trustedCatalogOwner
    ? resolveTrustedCatalogOwnerDiscovery({
        cfg: resolvedConfig,
        entry: params.trustedCatalogOwner,
        workspaceDir,
      })
    : undefined;
  const log = createSubsystemLogger("plugins");
  return loadOpenClawPlugins({
    config: resolvedConfig,
    activationSourceConfig: params.cfg,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    cache: false,
    logger: createPluginLoaderLogger(log),
    onlyPluginIds,
    ...(trustedOwnerScope
      ? {
          discovery: trustedOwnerScope.discovery,
          installRecords: trustedOwnerScope.installRecords,
        }
      : {}),
    includeSetupOnlyChannelPlugins: true,
    forceSetupOnlyChannelPlugins: params.forceSetupOnlyChannelPlugins,
    activate: params.activate,
  });
}

function resolveTrustedCatalogOwnerDiscovery(params: {
  cfg: OpenClawConfig;
  entry: ChannelPluginCatalogEntry;
  workspaceDir: string;
}): {
  discovery: PluginDiscoveryResult;
  installRecords: NonNullable<OpenClawConfig["plugins"]>["installs"];
} {
  const pluginId = params.entry.pluginId?.trim() || params.entry.id.trim();
  const installSource =
    params.entry.installSource ?? describePluginInstallSource(params.entry.install);
  const packageName = installSource.npm?.packageName ?? installSource.clawhub?.packageName;
  const installRecords = {
    ...loadInstalledPluginIndexInstallRecordsSync({ env: process.env }),
    ...params.cfg.plugins?.installs,
  };
  const normalizedPlugins = normalizePluginsConfigWithResolver(params.cfg.plugins);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    extraPaths: normalizedPlugins.loadPaths,
    installRecords,
    env: process.env,
  });
  if (!pluginId || !packageName) {
    return { discovery: { ...discovery, candidates: [] }, installRecords };
  }
  const manifestRegistry = loadPluginManifestRegistry({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: process.env,
    discovery,
    installRecords,
  });
  const owner = manifestRegistry.plugins.find(
    (record) =>
      record.id === pluginId &&
      record.packageName === packageName &&
      (params.entry.origin === "bundled"
        ? record.origin === "bundled"
        : params.entry.trustedSourceLinkedOfficialInstall === true &&
          record.trustedOfficialInstall === true),
  );
  // Recovery code is executable. Scope discovery to the already-verified manifest root so a
  // same-id or same-package candidate with higher discovery precedence cannot run first.
  return {
    discovery: {
      ...discovery,
      candidates: owner
        ? discovery.candidates.filter((candidate) => candidate.rootDir === owner.rootDir)
        : [],
    },
    installRecords,
  };
}

function resolveScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
}): string | undefined {
  const explicitPluginId = params.pluginId?.trim();
  if (explicitPluginId) {
    return explicitPluginId;
  }
  return (
    getTrustedChannelPluginCatalogEntry(params.channel, {
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.pluginId ?? resolveUniqueManifestScopedChannelPluginId(params)
  );
}

function resolveUniqueManifestScopedChannelPluginId(params: {
  cfg: OpenClawConfig;
  channel: string;
  workspaceDir?: string;
}): string | undefined {
  const matches = resolveDiscoverableScopedChannelPluginIds({
    config: params.cfg,
    channelIds: [params.channel],
    workspaceDir: params.workspaceDir,
    env: process.env,
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Load an inactive setup-plugin registry snapshot for resolving a channel without side effects. */
export function loadChannelSetupPluginRegistrySnapshotForChannel(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  channel: string;
  pluginId?: string;
  workspaceDir?: string;
  forceSetupOnlyChannelPlugins?: boolean;
  trustedCatalogOwner?: ChannelPluginCatalogEntry;
}): PluginRegistry {
  const scopedPluginId = resolveScopedChannelPluginId({
    cfg: params.cfg,
    channel: params.channel,
    pluginId: params.pluginId,
    workspaceDir: params.workspaceDir,
  });
  return loadChannelSetupPluginRegistry({
    ...params,
    ...(scopedPluginId ? { onlyPluginIds: [scopedPluginId] } : {}),
    activate: false,
  });
}
