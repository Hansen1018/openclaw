// Signal tests cover setup adapter integration with account-owned transport policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalCliPathTextInput,
  prepareSignalSetupInput,
  signalSetupAdapter,
} from "./setup-core.js";
import { signalSetupWizard } from "./setup-surface.js";

describe("signalSetupAdapter", () => {
  it("keeps canonical default account ownership at the channel root", () => {
    expect(signalSetupAdapter.skipSingleAccountPromotion).toBe(true);
  });

  it("repairs a duplicate explicit managed port before runtime resolution", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            accounts: {
              personal: {
                account: "+15555550123",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
              work: {
                account: "+15555550124",
                transport: { kind: "managed-native", httpPort: 8181 },
              },
            },
          },
        },
      },
      accountId: "work",
      input: { httpPort: "8282" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8282,
    });
  });

  it("realigns an existing managed connection URL after a partial bind update", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: {
                account: "+15555550124",
                transport: {
                  kind: "managed-native",
                  url: "http://127.0.0.1:8181",
                  httpHost: "127.0.0.1",
                  httpPort: 8181,
                },
              },
            },
          },
        },
      },
      accountId: "work",
      input: { httpHost: "127.0.0.2", httpPort: "8282" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.2:8282",
      httpHost: "127.0.0.2",
      httpPort: 8282,
    });
  });

  it("uses the setup transport allocator for a second managed account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: { kind: "managed-native", httpPort: 8080 },
          accounts: { work: { account: "+15555550124" } },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { signalNumber: "+15555550124" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      httpHost: "127.0.0.1",
      httpPort: 8081,
    });
  });

  it("preserves managed transport options during a partial setup update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            work: {
              account: "+15555550124",
              transport: {
                kind: "managed-native",
                cliPath: "/opt/old-signal-cli",
                configPath: "/var/lib/signal-work",
                httpHost: "127.0.0.2",
                httpPort: 8181,
                receiveMode: "manual",
                ignoreStories: true,
              },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "work",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      configPath: "/var/lib/signal-work",
      httpHost: "127.0.0.2",
      httpPort: 8181,
      receiveMode: "manual",
      ignoreStories: true,
    });
  });

  it("makes a new default transport update authoritative over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "external-native", url: "http://old-signal:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { cliPath: "/opt/new-signal-cli" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "managed-native",
      cliPath: "/opt/new-signal-cli",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("keeps the canonical root transport during a default account-only update", () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          transport: { kind: "external-native", url: "http://canonical-signal:8080" },
          accounts: {
            default: {
              account: "+15555550124",
              transport: { kind: "container", url: "http://stale-container:8080" },
            },
          },
        },
      },
    };

    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg,
      accountId: "default",
      input: { signalNumber: "+15555550125" },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://canonical-signal:8080",
    });
    expect(next?.channels?.signal?.accounts?.default).not.toHaveProperty("transport");
  });

  it("migrates and preserves an explicit legacy transport during an account-only update", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            account: "+15555550124",
            apiMode: "container",
            httpUrl: "http://signal-container:8080",
          },
        },
      } as never,
      accountId: "default",
      input: { signalNumber: "+15555550125" },
    });

    expect(next?.channels?.signal?.account).toBe("+15555550125");
    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal).not.toHaveProperty("httpUrl");
  });

  it("refuses an ambiguous legacy transport during an account-only update", () => {
    expect(() =>
      signalSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            signal: {
              account: "+15555550124",
              apiMode: "auto",
              httpUrl: "http://offline:8080",
            },
          },
        } as never,
        accountId: "default",
        input: { signalNumber: "+15555550125" },
      }),
    ).toThrow(
      "Signal has other ambiguous legacy account endpoints. Resolve each endpoint explicitly or bring them online and run openclaw doctor --fix.",
    );
  });

  it("stores an explicitly selected container endpoint", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input: {
        signalNumber: "+15555550124",
        httpUrl: "http://signal-container:8080/",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
  });

  it("resolves an offline legacy auto endpoint through explicit setup selection", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            httpUrl: "http://offline:8080",
            account: "+15555550124",
          },
        },
      } as never,
      accountId: "default",
      input: {
        httpUrl: "http://offline:8080",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://offline:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal).not.toHaveProperty("httpUrl");
  });

  it("replaces a malformed legacy endpoint through explicit setup selection", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            httpUrl: "http://[bad",
            account: "+15555550124",
          },
        },
      } as never,
      accountId: "default",
      input: {
        httpUrl: "http://signal-container:8080",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal).not.toHaveProperty("httpUrl");
  });

  it("replaces an invalid legacy managed port through explicit setup selection", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "native",
            autoStart: true,
            httpPort: 70_000,
            account: "+15555550124",
          },
        },
      } as never,
      accountId: "default",
      input: {
        httpUrl: "http://signal-native:8080",
        signalTransport: "external-native",
      },
    });

    expect(next?.channels?.signal?.transport).toEqual({
      kind: "external-native",
      url: "http://signal-native:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("httpPort");
  });

  it("keeps explicit recovery blocked by an unrelated malformed sibling", () => {
    expect(() =>
      signalSetupAdapter.applyAccountConfig?.({
        cfg: {
          channels: {
            signal: {
              apiMode: "auto",
              accounts: {
                work: { account: "+15555550124", httpUrl: "http://[bad" },
                personal: { account: "+15555550125", httpUrl: "http://[also-bad" },
              },
            },
          },
        } as never,
        accountId: "work",
        input: {
          httpUrl: "http://signal-work:8080",
          signalTransport: "external-native",
        },
      }),
    ).toThrow(
      "Signal has other ambiguous legacy account endpoints. Resolve each endpoint explicitly or bring them online and run openclaw doctor --fix.",
    );
  });

  it("atomically recovers distinct offline endpoints from an account transport map", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            accounts: {
              work: { account: "+15555550124", httpUrl: "http://work-native:8080" },
              personal: {
                account: "+15555550125",
                httpUrl: "http://personal-container:8080",
              },
            },
          },
        },
      } as never,
      accountId: "work",
      input: {
        signalTransports: JSON.stringify({
          work: { kind: "external-native", url: "http://work-native:8080" },
          personal: { kind: "container", url: "http://personal-container:8080" },
        }),
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://work-native:8080",
    });
    expect(next?.channels?.signal?.accounts?.personal?.transport).toEqual({
      kind: "container",
      url: "http://personal-container:8080",
    });
    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal?.accounts?.work).not.toHaveProperty("httpUrl");
    expect(next?.channels?.signal?.accounts?.personal).not.toHaveProperty("httpUrl");
  });

  it("validates the account transport recovery map", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "default",
        input: { signalTransports: '{"work":{"kind":"auto"}}' },
      }),
    ).toBe('Signal transport selection for account "work" must use external-native or container.');
  });

  it("atomically recovers every legacy account from an explicit transport selection", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            httpUrl: "http://offline:8080",
            accounts: {
              work: { account: "+15555550124" },
              personal: { account: "+15555550125" },
            },
          },
        },
      } as never,
      accountId: "work",
      input: {
        httpUrl: "http://offline:8080",
        signalTransport: "container",
      },
    });

    expect(next?.channels?.signal).not.toHaveProperty("apiMode");
    expect(next?.channels?.signal).not.toHaveProperty("httpUrl");
    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://offline:8080",
    });
    expect(next?.channels?.signal?.accounts?.personal?.transport).toEqual({
      kind: "container",
      url: "http://offline:8080",
    });
  });

  it("matches canonical endpoint spellings while recovering inherited legacy accounts", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            autoStart: false,
            httpHost: "LOCALHOST",
            httpPort: 80,
            accounts: {
              work: { account: "+15555550124" },
              personal: { account: "+15555550125" },
            },
          },
        },
      } as never,
      accountId: "work",
      input: {
        httpUrl: "http://localhost",
        signalTransport: "external-native",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://localhost",
    });
    expect(next?.channels?.signal?.accounts?.personal?.transport).toEqual({
      kind: "external-native",
      url: "http://localhost",
    });
  });

  it("formats inherited IPv6 endpoints while recovering legacy accounts", () => {
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {
        channels: {
          signal: {
            apiMode: "auto",
            autoStart: false,
            httpHost: "::1",
            httpPort: 8080,
            accounts: {
              work: { account: "+15555550124" },
              personal: { account: "+15555550125" },
            },
          },
        },
      } as never,
      accountId: "work",
      input: {
        httpUrl: "http://[::1]:8080",
        signalTransport: "external-native",
      },
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "external-native",
      url: "http://[::1]:8080",
    });
    expect(next?.channels?.signal?.accounts?.personal?.transport).toEqual({
      kind: "external-native",
      url: "http://[::1]:8080",
    });
  });

  it("refuses to apply one account's explicit protocol to a different sibling endpoint", () => {
    const cfg = {
      channels: {
        signal: {
          apiMode: "auto",
          accounts: {
            work: { account: "+15555550124", httpUrl: "http://work-native:8080" },
            personal: { account: "+15555550125", httpUrl: "http://personal-container:8080" },
          },
        },
      },
    } as never;

    expect(() =>
      signalSetupAdapter.applyAccountConfig?.({
        cfg,
        accountId: "work",
        input: {
          httpUrl: "http://work-native:8080",
          signalTransport: "external-native",
        },
      }),
    ).toThrow(
      "Signal has other ambiguous legacy account endpoints. Resolve each endpoint explicitly or bring them online and run openclaw doctor --fix.",
    );
    expect(cfg.channels.signal.accounts.personal.httpUrl).toBe("http://personal-container:8080");
  });

  it("detects and persists an omitted HTTP transport kind", async () => {
    const input = await prepareSignalSetupInput({
      input: {
        signalNumber: "+15555550124",
        httpUrl: "signal-container:8080",
      },
      detect: vi.fn().mockResolvedValue({
        kind: "container",
        url: "http://signal-container:8080",
      }),
    });
    const next = signalSetupAdapter.applyAccountConfig?.({
      cfg: {},
      accountId: "work",
      input,
    });

    expect(next?.channels?.signal?.accounts?.work?.transport).toEqual({
      kind: "container",
      url: "http://signal-container:8080",
    });
  });

  it("uses the configured account while detecting an omitted HTTP transport kind", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal-container:8080",
    });

    await prepareSignalSetupInput({
      cfg: {
        channels: {
          signal: {
            accounts: {
              work: { account: "+15555550124" },
            },
          },
        },
      },
      accountId: "work",
      input: { httpUrl: "signal-container:8080" },
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "signal-container:8080",
      account: "+15555550124",
    });
  });

  it("uses the inherited root account while detecting a named account transport", async () => {
    const detect = vi.fn().mockResolvedValue({
      kind: "container",
      url: "http://signal-container:8080",
    });

    await prepareSignalSetupInput({
      cfg: {
        channels: {
          signal: { account: "+15555550123" },
        },
      },
      accountId: "work",
      input: { httpUrl: "signal-container:8080" },
      detect,
    });

    expect(detect).toHaveBeenCalledWith({
      url: "signal-container:8080",
      account: "+15555550123",
    });
  });

  it("rejects a transport kind without an HTTP URL", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { signalTransport: "container" },
      }),
    ).toBe("Signal --signal-transport requires --http-url.");
  });

  it.each(["0", "abc", "65536"])("rejects invalid managed HTTP port %s", (httpPort) => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: { httpPort },
      }),
    ).toBe("Signal --http-port must be an integer between 1 and 65535.");
  });

  it("rejects a fresh container transport without a Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {},
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBe("Signal container transport requires --signal-number or an existing account.");
  });

  it("allows a container transport to reuse the configured Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: {
              accounts: { work: { account: "+15555550124" } },
            },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBeNull();
  });

  it("allows a named container transport to inherit the root Signal account", () => {
    expect(
      signalSetupAdapter.validateInput?.({
        cfg: {
          channels: {
            signal: { account: "+15555550123" },
          },
        },
        accountId: "work",
        input: {
          httpUrl: "http://signal-container:8080",
          signalTransport: "container",
        },
      }),
    ).toBeNull();
  });

  it("does not materialize a CLI path for an external transport", async () => {
    const input = createSignalCliPathTextInput(async () => false);
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "container", url: "http://signal:8080" },
        },
      },
    };

    expect(
      await input.currentValue?.({ cfg, accountId: "default", credentialValues: {} }),
    ).toBeUndefined();
    const wizardInput = signalSetupWizard.textInputs?.find((entry) => entry.inputKey === "cliPath");
    expect(
      await wizardInput?.shouldPrompt?.({
        cfg,
        accountId: "default",
        credentialValues: {},
      }),
    ).toBe(false);
  });

  it("reports an external transport as configured without checking signal-cli", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        signal: {
          account: "+15555550124",
          transport: { kind: "external-native", url: "http://signal:8080" },
        },
      },
    };
    const configured = await signalSetupWizard.status.resolveConfigured({
      cfg,
      accountId: "default",
    });
    const params = { cfg, accountId: "default", configured };

    await expect(signalSetupWizard.status.resolveStatusLines?.(params)).resolves.toEqual([
      "Signal: configured",
    ]);
    await expect(signalSetupWizard.status.resolveSelectionHint?.(params)).resolves.toBe(
      "configured",
    );
    await expect(signalSetupWizard.status.resolveQuickstartScore?.(params)).resolves.toBe(1);
  });
});
