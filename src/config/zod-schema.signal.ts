import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { ExecutableTokenSchema } from "./zod-schema.core.js";

export const SIGNAL_RETIRED_TRANSPORT_KEYS = [
  "apiMode",
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

const SIGNAL_TRANSPORT_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const SIGNAL_TRANSPORT_URL_MESSAGE =
  "Signal transport URL must be a valid http:// or https:// URL without embedded credentials";

export type SignalTransportUrlIssue = {
  path: string;
  message: string;
};

export function collectSignalTransportUrlIssues(value: unknown): SignalTransportUrlIssue[] {
  if (!isRecord(value)) {
    return [];
  }

  const issues: SignalTransportUrlIssue[] = [];
  const validateTransport = (transport: unknown, pathValue: string) => {
    if (!isRecord(transport) || typeof transport.url !== "string") {
      return;
    }
    try {
      const parsed = new URL(transport.url);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password
      ) {
        issues.push({ path: pathValue, message: SIGNAL_TRANSPORT_URL_MESSAGE });
      }
    } catch {
      issues.push({ path: pathValue, message: SIGNAL_TRANSPORT_URL_MESSAGE });
    }
  };

  validateTransport(value.transport, "channels.signal.transport.url");
  if (isRecord(value.accounts)) {
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (isRecord(account)) {
        validateTransport(account.transport, `channels.signal.accounts.${accountId}.transport.url`);
      }
    }
  }
  return issues;
}

const SignalTransportUrlSchema = z
  .string()
  .url()
  // Keep this as a regex so the HTTP-only and credential-free contract survives JSON Schema
  // generation. Runtime URL parsing remains the final canonicalization boundary.
  .regex(
    SIGNAL_TRANSPORT_URL_PATTERN,
    "Expected http:// or https:// URL without embedded credentials",
  );

export function projectSignalConfigForUpdateValidation(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || !isRecord(value)) {
    return value;
  }
  const next = { ...value };
  for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
    delete next[key];
  }
  if (isRecord(value.accounts)) {
    next.accounts = Object.fromEntries(
      Object.entries(value.accounts).map(([accountId, account]) => {
        if (!isRecord(account)) {
          return [accountId, account];
        }
        const nextAccount = { ...account };
        for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
          delete nextAccount[key];
        }
        return [accountId, nextAccount];
      }),
    );
  }
  return next;
}

export function restoreSignalUpdateValidationSource(params: {
  source: unknown;
  validated: unknown;
  env: NodeJS.ProcessEnv;
}): unknown {
  if (
    params.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" ||
    !isRecord(params.source) ||
    !isRecord(params.validated)
  ) {
    return params.validated;
  }
  const next = { ...params.validated };
  for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
    if (Object.hasOwn(params.source, key)) {
      next[key] = params.source[key];
    }
  }
  if (isRecord(params.source.accounts) && isRecord(params.validated.accounts)) {
    const accounts = { ...params.validated.accounts };
    for (const [accountId, sourceAccount] of Object.entries(params.source.accounts)) {
      const validatedAccount = accounts[accountId];
      if (!isRecord(sourceAccount) || !isRecord(validatedAccount)) {
        continue;
      }
      const nextAccount = { ...validatedAccount };
      for (const key of SIGNAL_RETIRED_TRANSPORT_KEYS) {
        if (Object.hasOwn(sourceAccount, key)) {
          nextAccount[key] = sourceAccount[key];
        }
      }
      accounts[accountId] = nextAccount;
    }
    next.accounts = accounts;
  }
  return next;
}

export const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      url: SignalTransportUrlSchema.optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().min(1).max(65_535).optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);
