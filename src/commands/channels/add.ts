// Implements guided and non-interactive `openclaw channels add` account setup.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getBundledChannelSetupPlugin } from "../../channels/plugins/bundled.js";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "../../channels/plugins/setup-helpers.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId, ChannelSetupInput } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { validateConfigObjectRawWithPlugins } from "../../config/validation.js";
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { applyChannelAccountConfig } from "./add-mutators.js";
import { channelLabel } from "./runtime-label.js";
import {
  rejectInvalidConfigFileSnapshot,
  requireValidConfigFileSnapshot,
  shouldUseWizard,
} from "./shared.js";

type ChannelSetupPluginInstallModule = typeof import("../channel-setup/plugin-install.js");
type OnboardChannelsModule = typeof import("../onboard-channels.js");

const channelSetupPluginInstallLoader = createLazyImportLoader<ChannelSetupPluginInstallModule>(
  () => import("../channel-setup/plugin-install.js"),
);
const onboardChannelsLoader = createLazyImportLoader<OnboardChannelsModule>(
  () => import("../onboard-channels.js"),
);

function loadChannelSetupPluginInstall(): Promise<ChannelSetupPluginInstallModule> {
  return channelSetupPluginInstallLoader.load();
}

function loadOnboardChannels(): Promise<OnboardChannelsModule> {
  return onboardChannelsLoader.load();
}

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
} & Record<string, unknown>;

const CHANNEL_ADD_CONTROL_OPTION_KEYS = new Set(["channel", "account"]);
const NEXTCLOUD_TALK_CLI_ALIASES = new Set(["nextcloud-talk", "nc-talk", "nc"]);

function isShippedSetupRecoveryOwner(entry: ChannelPluginCatalogEntry | undefined): boolean {
  return (
    (entry?.origin === "bundled" || entry?.trustedSourceLinkedOfficialInstall === true) &&
    entry.setupCapabilities?.invalidConfigRecovery === true
  );
}

async function resolveCatalogChannelEntry(
  raw: string,
  cfg: OpenClawConfig | null,
  opts?: { trustedRecoveryOnly?: boolean },
) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = cfg
    ? await import("../channel-setup/trusted-catalog.js").then(
        ({ listTrustedChannelPluginCatalogEntries }) =>
          listTrustedChannelPluginCatalogEntries({
            cfg,
            workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
          }),
      )
    : await import("../../channels/plugins/catalog.js").then(
        ({ listRawChannelPluginCatalogEntries }) =>
          listRawChannelPluginCatalogEntries({
            excludeWorkspace: true,
            ...(opts?.trustedRecoveryOnly
              ? { excludeOrigins: ["config", "workspace", "global"] }
              : {}),
          }),
      );
  return entries.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
}

function parseOptionalInt(value: unknown, flag: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function parseOptionalDelimitedInput(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return parseOptionalDelimitedEntries(typeof value === "string" ? value : undefined);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildChannelSetupInput(opts: ChannelsAddOptions): ChannelSetupInput {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) || value === undefined) {
      continue;
    }
    input[key] = value;
  }

  const rawChannel = readOptionalString(opts.channel)?.trim().toLowerCase();
  if (rawChannel && NEXTCLOUD_TALK_CLI_ALIASES.has(rawChannel)) {
    input.baseUrl ??= readOptionalString(input.url);
    input.secret ??= readOptionalString(input.token) ?? readOptionalString(input.password);
    input.secretFile ??= readOptionalString(input.tokenFile);
  }

  input.initialSyncLimit = parseOptionalInt(opts.initialSyncLimit, "--initial-sync-limit");
  input.groupChannels = parseOptionalDelimitedInput(opts.groupChannels);
  input.dmAllowlist = parseOptionalDelimitedInput(opts.dmAllowlist);
  return input as ChannelSetupInput;
}

/** Add or configure a channel account, using the wizard when no concrete flags are supplied. */
export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  try {
    return await channelsAddCommandImpl(opts, runtime, params);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

async function channelsAddCommandImpl(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv,
  params?: { hasFlags?: boolean; beforePersistentEffect?: () => Promise<void> },
) {
  const useWizard = shouldUseWizard(params);
  const rawChannel = opts.channel ?? "";
  const recoveryCatalogEntry = useWizard
    ? undefined
    : await resolveCatalogChannelEntry(rawChannel, null, { trustedRecoveryOnly: true });
  // Invalid config may reach setup only through a trusted owner that explicitly opted its
  // setup adapter into recovery. Install recovery is a separate, narrower capability.
  const recoveryChannelId = isShippedSetupRecoveryOwner(recoveryCatalogEntry)
    ? normalizeChannelId(recoveryCatalogEntry?.id ?? "")
    : undefined;
  const recoveryCatalogPluginId = recoveryCatalogEntry?.pluginId?.trim();
  const recoveryPluginId = recoveryChannelId
    ? recoveryCatalogPluginId || recoveryCatalogEntry?.id.trim()
    : undefined;
  const configSnapshot = await requireValidConfigFileSnapshot(
    runtime,
    recoveryChannelId
      ? { invalidConfigRecoveryPathPrefix: `channels.${recoveryChannelId}` }
      : undefined,
  );
  if (!configSnapshot) {
    return;
  }
  const cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;
  const baseHash = configSnapshot.hash;
  let nextConfig = cfg;
  let pluginRegistrySourceChanged = false;

  if (useWizard) {
    const { resolveInitialWizardChannel, runChannelsAddWizardFlow } =
      await import("./add-wizard.js");
    const initialChannel = await resolveInitialWizardChannel(opts.channel ?? "", cfg);
    await runChannelsAddWizardFlow({
      cfg,
      ...(baseHash !== undefined ? { baseHash } : {}),
      runtime,
      prompter: createClackPrompter(),
      ...(initialChannel ? { initialChannel } : {}),
      ...(params?.beforePersistentEffect
        ? { beforePersistentEffect: params.beforePersistentEffect }
        : {}),
    });
    return;
  }

  const recoveringInvalidConfig = configSnapshot.exists && !configSnapshot.valid;
  if (recoveringInvalidConfig && (!recoveryChannelId || !recoveryCatalogEntry)) {
    rejectInvalidConfigFileSnapshot(runtime, configSnapshot);
    return;
  }
  // Invalid config cannot participate in owner selection. Keep the exact shipped catalog owner
  // that authorized recovery so a configured same-channel shadow cannot replace its setup code.
  let channel = recoveringInvalidConfig ? recoveryChannelId : normalizeChannelId(rawChannel);
  let catalogEntry = recoveringInvalidConfig
    ? recoveryCatalogEntry
    : await resolveCatalogChannelEntry(rawChannel, nextConfig);
  const resolveWorkspaceDir = () =>
    resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
  // May load a scoped plugin when the channel is not already registered.
  const loadScopedPlugin = async (
    channelId: ChannelId,
    pluginId?: string,
  ): Promise<ChannelPlugin | undefined> => {
    // Recovery must load the selected manifest owner, never a pre-registered same-id shadow.
    const existing = recoveringInvalidConfig ? undefined : getLoadedChannelPlugin(channelId);
    if (existing?.setup?.applyAccountConfig) {
      return existing;
    }
    const { loadChannelSetupPluginRegistrySnapshotForChannel } =
      await loadChannelSetupPluginInstall();
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: nextConfig,
      runtime,
      channel: channelId,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: true,
    });
    const scopedOwner =
      snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin ??
      snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin;
    return recoveringInvalidConfig
      ? scopedOwner
      : (scopedOwner ?? getBundledChannelSetupPlugin(channelId) ?? existing);
  };

  if (catalogEntry) {
    const workspaceDir = resolveWorkspaceDir();
    const { isCatalogChannelInstalled } = await import("../channel-setup/discovery.js");
    const registeredPlugin =
      channel && !recoveringInvalidConfig ? getLoadedChannelPlugin(channel) : undefined;
    const bundledSetupPlugin =
      channel && !recoveringInvalidConfig ? getBundledChannelSetupPlugin(channel) : undefined;
    if (
      !registeredPlugin &&
      !bundledSetupPlugin &&
      !isCatalogChannelInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        workspaceDir,
      })
    ) {
      const { ensureChannelSetupPluginInstalled } = await loadChannelSetupPluginInstall();
      const prompter = createClackPrompter();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
        promptInstall: false,
        ...(params?.beforePersistentEffect
          ? { beforePersistentEffect: params.beforePersistentEffect }
          : {}),
      });
      nextConfig = result.cfg;
      if (!result.installed) {
        return;
      }
      pluginRegistrySourceChanged = true;
      catalogEntry = {
        ...catalogEntry,
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      };
    }
    channel ??= normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install. Run openclaw doctor --fix, then retry openclaw channels add.`
      : formatUnknownChannelMessage({ channel: rawChannel });
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const plugin = await loadScopedPlugin(
    channel,
    recoveringInvalidConfig ? recoveryPluginId : catalogEntry?.pluginId,
  );
  if (!plugin?.setup?.applyAccountConfig) {
    runtime.error(
      `${formatUnsupportedChannelActionMessage({
        channel,
        action: "non-interactive add",
      })} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`,
    );
    runtime.exit(1);
    return;
  }
  let input = buildChannelSetupInput(opts);
  const accountId =
    plugin.setup.resolveAccountId?.({
      cfg: nextConfig,
      accountId: opts.account,
      input,
    }) ?? normalizeAccountId(opts.account);

  const initialValidationError = plugin.setup.validateInput?.({
    cfg: nextConfig,
    accountId,
    input,
  });
  if (initialValidationError) {
    runtime.error(initialValidationError);
    runtime.exit(1);
    return;
  }
  input =
    (await plugin.setup.prepareAccountConfigInput?.({
      cfg: nextConfig,
      accountId,
      input,
    })) ?? input;
  const preparedValidationError = plugin.setup.validateInput?.({
    cfg: nextConfig,
    accountId,
    input,
  });
  if (preparedValidationError) {
    runtime.error(preparedValidationError);
    runtime.exit(1);
    return;
  }

  const prevConfig = nextConfig;

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: channel,
    });
  }

  nextConfig = applyChannelAccountConfig({
    cfg: nextConfig,
    channel,
    accountId,
    input,
    plugin,
  });
  if (recoveringInvalidConfig) {
    const recoveredValidation = validateConfigObjectRawWithPlugins(nextConfig);
    if (!recoveredValidation.ok) {
      rejectInvalidConfigFileSnapshot(runtime, {
        ...configSnapshot,
        issues: recoveredValidation.issues,
      });
      return;
    }
  }
  if (plugin.lifecycle?.onAccountConfigChanged) {
    await params?.beforePersistentEffect?.();
    await plugin.lifecycle.onAccountConfigChanged({
      prevCfg: prevConfig,
      nextCfg: nextConfig,
      accountId,
      runtime,
    });
  }

  await params?.beforePersistentEffect?.();
  const committed = await commitConfigWithPendingPluginInstalls({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  const writtenConfig = committed.config;
  if (committed.movedInstallRecords || pluginRegistrySourceChanged) {
    await refreshPluginRegistryAfterConfigMutation({
      config: writtenConfig,
      reason: "source-changed",
      ...(committed.movedInstallRecords ? { installRecords: committed.installRecords } : {}),
      logger: { warn: (message) => runtime.log(message) },
    });
  }
  runtime.log(`Added ${plugin.meta.label ?? channelLabel(channel)} account "${accountId}".`);
  const afterAccountConfigWritten = plugin.setup?.afterAccountConfigWritten;
  if (afterAccountConfigWritten) {
    const { runCollectedChannelOnboardingPostWriteHooks } = await loadOnboardChannels();
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel,
          accountId,
          run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
            await afterAccountConfigWritten({
              previousCfg: cfg,
              cfg: writtenCfg,
              accountId,
              input,
              runtime: hookRuntime,
            }),
        },
      ],
      cfg: writtenConfig,
      runtime,
      ...(params?.beforePersistentEffect
        ? { beforePersistentEffect: params.beforePersistentEffect }
        : {}),
    });
  }
}
