// Signal transport URLs are canonicalized before config writes and network use.
export function normalizeSignalTransportUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Signal transport URL is required");
  }
  if (/^https?:/i.test(trimmed) && !/^https?:\/\/[^/]/i.test(trimmed)) {
    throw new Error("Signal transport URL has a malformed HTTP scheme");
  }
  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (explicitScheme && explicitScheme !== "http" && explicitScheme !== "https") {
    throw new Error(`Signal transport URL unsupported protocol: ${explicitScheme}:`);
  }
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Signal transport URL unsupported protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Signal transport URL must not include credentials");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function buildSignalTransportHttpUrl(host: string, port: number): string {
  const normalizedHost = host.trim().replace(/^\[|\]$/g, "");
  const authorityHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return normalizeSignalTransportUrl(`http://${authorityHost}:${port}`);
}
