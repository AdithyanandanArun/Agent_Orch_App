import { mkdirSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listDirectory, normalizeRelative, readTextFile, resolveInside, writeTextFile } from './paths.ts';
import { tmpDir } from './test-utils.ts';

let root: string;
let outside: string;

beforeAll(() => {
  root = tmpDir('relay-root-');
  outside = tmpDir('relay-outside-');
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, 'src/app.ts'), 'export {}\n');
  writeFileSync(path.join(root, '.env'), 'KEY=1');
  writeFileSync(path.join(root, '.env.example'), 'KEY=');
  writeFileSync(path.join(root, '.git/config'), '[core]');
  writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  symlinkSync(outside, path.join(root, 'link-out'));
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret-link'));
  symlinkSync(path.join(root, 'src/app.ts'), path.join(root, 'inner-link'));
  symlinkSync(path.join(root, '.git/config'), path.join(root, 'git-config-link'));
  symlinkSync(path.join(root, 'missing-target'), path.join(root, 'dangling'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('path scoping', () => {
  it('normalises benign paths and rejects traversal, absolute and odd inputs', () => {
    expect(normalizeRelative('./src//app.ts')).toBe('src/app.ts');
    expect(normalizeRelative('')).toBe('');
    for (const bad of ['../x', 'src/../../x', '/etc/passwd', 'C:/Windows', 'a\\b', 'a\0b']) expect(() => normalizeRelative(bad), bad).toThrow();
  });

  it('refuses .git, secrets and key files but allows .env.example', () => {
    for (const bad of ['.git/config', '.env', '.env.local', 'keys/server.pem', 'id_rsa', '.ssh/config', '.npmrc']) expect(() => normalizeRelative(bad), bad).toThrow(/not allowed/);
    expect(normalizeRelative('.env.example')).toBe('.env.example');
  });

  it('reads files inside the root and lists without leaking denied or escaping entries', async () => {
    expect((await readTextFile(root, 'src/app.ts')).content).toBe('export {}\n');
    const names = (await listDirectory(root, '')).map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('inner-link');
    expect(names).toContain('.env.example');
    for (const hidden of ['.git', '.env', 'link-out', 'secret-link', 'git-config-link', 'dangling']) expect(names).not.toContain(hidden);
  });

  it('blocks symlinks that escape the root or point at denied files', async () => {
    await expect(readTextFile(root, 'secret-link')).rejects.toMatchObject({ status: 403 });
    await expect(readTextFile(root, 'link-out/secret.txt')).rejects.toMatchObject({ status: 403 });
    await expect(listDirectory(root, 'link-out')).rejects.toMatchObject({ status: 403 });
    await expect(readTextFile(root, 'git-config-link')).rejects.toMatchObject({ status: 403 });
    await expect(resolveInside(root, 'dangling', { allowMissing: true })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses writes through escaping symlinks and never touches outside files', async () => {
    await expect(writeTextFile(root, 'secret-link', 'pwned')).rejects.toMatchObject({ status: 403 });
    await expect(writeTextFile(root, 'link-out/new.txt', 'pwned')).rejects.toMatchObject({ status: 403 });
    expect(existsSync(path.join(outside, 'new.txt'))).toBe(false);
    expect(readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
  });

  it('writes new and existing files inside the root', async () => {
    await writeTextFile(root, 'src/new.ts', 'x');
    expect(readFileSync(path.join(root, 'src/new.ts'), 'utf8')).toBe('x');
    await writeTextFile(root, 'inner-link', 'edited'); // symlink inside root resolves to a real in-root file
    expect(readFileSync(path.join(root, 'src/app.ts'), 'utf8')).toBe('edited');
    await expect(writeTextFile(root, 'nodir/file.ts', 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('rejects binary and oversized content', async () => {
    await expect(readTextFile(root, 'bin.dat')).rejects.toMatchObject({ status: 415 });
    await expect(writeTextFile(root, 'big.txt', 'x'.repeat(2 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
  });
});
