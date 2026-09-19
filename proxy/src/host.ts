export function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
}

export function slugFromHost(hostHeader: string | undefined): string | null {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return null;

  if (hostname.endsWith(".localhost")) {
    const slug = hostname.slice(0, -".localhost".length);
    return slug || null;
  }

  const base = process.env.PREVIEW_BASE_DOMAIN?.toLowerCase();
  if (base && hostname.endsWith(`.${base}`)) {
    const slug = hostname.slice(0, -(base.length + 1));
    return slug || null;
  }

  return null;
}
