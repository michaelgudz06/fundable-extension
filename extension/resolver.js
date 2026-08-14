// ⚠️ TEMPORARY STUB — DELETE THIS FILE AT MERGE.
//
// extension/resolver.js belongs to another crewmate. This placeholder exists
// only so the shell loads unpacked and background.js is importable in tests. It
// has no deny list, which the real one must have. Replace it wholesale.

export function resolveIdentifier(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.replace(/^www\./, '');
  if (host.endsWith('linkedin.com')) {
    const slug = parsed.pathname.match(/^\/company\/([^/]+)/)?.[1];
    return slug ? { kind: 'linkedin', value: slug } : null;
  }
  if (host.endsWith('crunchbase.com')) {
    const slug = parsed.pathname.match(/^\/organization\/([^/]+)/)?.[1];
    return slug ? { kind: 'crunchbase', value: slug } : null;
  }
  return { kind: 'domain', value: host };
}
