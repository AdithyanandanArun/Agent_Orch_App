import { git } from './git-run.ts';

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OID_LIKE = /^[0-9a-f]{40,64}$/i;

export const isSafeRemoteName = (name: string) => REMOTE_NAME.test(name);

/** Validates a local branch name: Git ref rules plus no option-looking, HEAD-like or object-id-like names. */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.length > 200 || name.startsWith('-') || name === 'HEAD' || OID_LIKE.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return false;
  const result = await git(cwd, ['check-ref-format', `refs/heads/${name}`], { allowFailure: true });
  return result.code === 0;
}
