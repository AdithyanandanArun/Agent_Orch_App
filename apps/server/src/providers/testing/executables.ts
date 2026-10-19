import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_CODEX = join(dirname(fileURLToPath(import.meta.url)), 'fake-codex.mjs');
export const posixOnly = process.platform === 'win32';

export class Sandbox {
  private constructor(readonly root: string) {}
  static async create(): Promise<Sandbox> { return new Sandbox(await mkdtemp(join(tmpdir(), 'relay-providers-test-'))); }
  async script(relativePath: string, body: string): Promise<string> {
    const path = join(this.root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }
  /** A `codex` stand-in that runs the fixture process under the current Node binary. */
  fakeCodex(relativePath = 'bin/codex'): Promise<string> {
    return this.script(relativePath, `exec "${process.execPath}" "${FIXTURE_CODEX}" "$@"`);
  }
  async dispose(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}
