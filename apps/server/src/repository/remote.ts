export interface ParsedRemote {
  host: string | null;
  /** owner/name, only for github.com remotes in the canonical two-segment shape. */
  repository: string | null;
  /** The URL embeds a password or token (for example https://token@host/...). */
  credentials: boolean;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_ALIASES = new Set(['github.com', 'www.github.com', 'ssh.github.com']);
const NONE: ParsedRemote = { host: null, repository: null, credentials: false };

function githubRepository(pathname: string): string | null {
  const segments = pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments as [string, string];
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..' || name.toLowerCase().endsWith('.git')) return null;
  return `${owner}/${name}`;
}

/** Derives host and (for github.com only) owner/name from a configured remote URL. The URL itself is never returned or logged. */
export function parseRemoteUrl(input: string): ParsedRemote {
  const url = input.trim();
  if (!url || url.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(url) || url.includes('%')) return NONE;
  const finish = (hostname: string, pathname: string, credentials: boolean): ParsedRemote => {
    const lower = hostname.toLowerCase().replace(/\.$/, '');
    if (!lower) return NONE;
    if (!GITHUB_ALIASES.has(lower)) return { host: lower, repository: null, credentials };
    return { host: 'github.com', repository: githubRepository(pathname), credentials };
  };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return NONE; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return NONE;
    const web = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    return finish(parsed.hostname, parsed.pathname, Boolean(parsed.password) || (web && Boolean(parsed.username)));
  }
  if (/^[A-Za-z]:[\\/]/.test(url)) return NONE; // Windows drive path
  const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) return finish(scp[1]!, scp[2]!, false);
  return NONE;
}
