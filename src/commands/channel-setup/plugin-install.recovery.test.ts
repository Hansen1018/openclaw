// Channel setup recovery tests cover executable owner package and root binding.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { PluginDiscoveryResult } from "../../plugins/discovery.js";
import { makeRuntime } from "../setup/__tests__/test-utils.js";

const applyPluginAutoEnable = vi.fn((params: { config: unknown }) => ({
  config: params.config,
  changes: [],
  autoEnabledReasons: {},
}));
const discoverOpenClawPlugins = vi.fn(
  (_args?: unknown): PluginDiscoveryResult => ({ candidates: [], diagnostics: [] }),
);
const loadPluginManifestRegistry = vi.fn();
const loadOpenClawPlugins = vi.fn((_options?: { discovery?: PluginDiscoveryResult }) => ({
  channels: [],
  channelSetups: [],
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: unknown }) => applyPluginAutoEnable(params),
}));
vi.mock("../../plugins/discovery.js", () => ({
  discoverOpenClawPlugins: (params: unknown) => discoverOpenClawPlugins(params),
}));
vi.mock("../../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: () => ({}),
}));
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (params: unknown) => loadPluginManifestRegistry(params),
}));
vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: (params: { discovery?: PluginDiscoveryResult }) =>
    loadOpenClawPlugins(params),
}));

import { loadChannelSetupPluginRegistrySnapshotForChannel } from "./plugin-install.js";

describe("channel setup recovery owner binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds a trusted recovery snapshot to the approved package root", () => {
    const shadowRoot = "/tmp/config-shadow/signal";
    const bundledRoot = "/tmp/openclaw/extensions/signal";
    const bundledEntry: ChannelPluginCatalogEntry = {
      id: "signal",
      pluginId: "signal",
      origin: "bundled",
      meta: { id: "signal", label: "Signal", selectionLabel: "Signal" },
      install: { npmSpec: "@openclaw/signal", defaultChoice: "npm" },
    };
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "signal",
          source: `${shadowRoot}/index.js`,
          rootDir: shadowRoot,
          origin: "config",
          packageName: "@openclaw/signal",
        },
        {
          idHint: "signal",
          source: `${bundledRoot}/index.js`,
          rootDir: bundledRoot,
          origin: "bundled",
          packageName: "@openclaw/signal",
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "signal",
          packageName: "@openclaw/signal",
          origin: "bundled",
          rootDir: bundledRoot,
        },
      ],
      diagnostics: [],
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: {},
      runtime: makeRuntime(),
      channel: "signal",
      pluginId: "signal",
      trustedCatalogOwner: bundledEntry,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    const loadOptions = loadOpenClawPlugins.mock.calls[0]?.[0];
    expect(loadOptions?.discovery?.candidates).toEqual([
      expect.objectContaining({ rootDir: bundledRoot, origin: "bundled" }),
    ]);
  });
});
