import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLE_CONTRACT_SESSION_ID, EXAMPLE_PROJECT_ID } from './example.ts';
import { makeRepo, runGit, startTestApp, tmpDir, type TestApp } from './test-utils.ts';
import { gitStatus, parsePorcelain } from './git.ts';

const apps: TestApp[] = [];
const boot = async (options: Parameters<typeof startTestApp>[0] = {}) => { const t = await startTestApp(options); apps.push(t); return t; };
afterEach(async () => { while (apps.length) await apps.pop()!.cleanup(); });

describe('files API', () => {
  it('lists, reads and saves inside the project and refuses escapes, secrets and .git', async () => {
    const outside = tmpDir();
    writeFileSync(path.join(outside, 'loot.txt'), 'loot');
    const repo = makeRepo({ 'README.md': '# r', 'src/a.ts': 'a', '.env': 'SECRET=1', '.env.example': 'SECRET=' });
    symlinkSync(outside, path.join(repo, 'escape'));
    const t = await boot({ exampleWorkspace: false });
    const project = (await t.api('POST', '/api/projects', { name: 'p', path: repo })).json;
    const base = `/api/projects/${project.id}`;
    const names = (await t.api('GET', `${base}/files`)).json.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(['src', 'README.md', '.env.example']));
    expect(names).not.toEqual(expect.arrayContaining(['.git']));
    expect(names).not.toContain('.env');
    expect(names).not.toContain('escape');
    expect((await t.api('GET', `${base}/file?path=src/a.ts`)).json).toEqual({ content: 'a', path: 'src/a.ts' });
    for (const bad of ['../x', '.env', '.git/HEAD', 'escape/loot.txt', '/etc/passwd', '%2e%2e/x']) {
      const res = await t.api('GET', `${base}/file?path=${bad}`);
      expect([400, 403, 404], bad).toContain(res.status);
      expect(JSON.stringify(res.json)).not.toContain('loot');
    }
    expect((await t.api('PUT', `${base}/file?path=src/b.ts`, { content: 'b' })).json).toEqual({ content: 'b', path: 'src/b.ts' });
    expect((await t.api('GET', `${base}/file?path=src/b.ts`)).json.content).toBe('b');
    expect((await t.api('PUT', `${base}/file?path=escape/pwn.txt`, { content: 'x' })).status).toBe(403);
    expect((await t.api('PUT', `${base}/file?path=.env`, { content: 'x' })).status).toBe(403);
    expect((await t.api('GET', `${base}/file`)).status).toBe(400);
    expect((await t.api('GET', '/api/projects/missing/files')).status).toBe(404);
  });

  it('scopes file access to a session worktree', async () => {
    const t = await boot();
    const s = (await t.api('GET', '/api/bootstrap')).json.sessions.find((x: any) => x.id === EXAMPLE_CONTRACT_SESSION_ID);
    writeFileSync(path.join(s.worktreePath, 'only-here.md'), 'worktree file');
    const base = `/api/projects/${EXAMPLE_PROJECT_ID}`;
    expect((await t.api('GET', `${base}/file?path=only-here.md&sessionId=${s.id}`)).json.content).toBe('worktree file');
    expect((await t.api('GET', `${base}/file?path=only-here.md`)).status).toBe(404);
    expect((await t.api('GET', `${base}/files?sessionId=nope`)).status).toBe(404);
    const other = (await t.api('POST', '/api/projects', { name: 'o', path: makeRepo() })).json;
    expect((await t.api('GET', `/api/projects/${other.id}/files?sessionId=${s.id}`)).status).toBe(404); // session of another project
  });
});

describe('git status and diff', () => {
  it('shows staged, unstaged and untracked changes of the session worktree only', async () => {
    const t = await boot();
    const s = (await t.api('GET', '/api/bootstrap')).json.sessions.find((x: any) => x.id === EXAMPLE_CONTRACT_SESSION_ID);
    const base = `/api/projects/${EXAMPLE_PROJECT_ID}/git`;
    const clean = (await t.api('GET', `${base}?sessionId=${s.id}`)).json;
    expect(clean).toMatchObject({ isRepo: true, files: [], diff: '', branch: 'mingle/example-contract-author' });

    writeFileSync(path.join(s.worktreePath, 'README.md'), '# changed staged\n');
    runGit(s.worktreePath, 'add', 'README.md');
    writeFileSync(path.join(s.worktreePath, 'docs/CONTRACT.md'), 'unstaged edit\n');
    writeFileSync(path.join(s.worktreePath, 'notes.txt'), 'brand new\n');
    writeFileSync(path.join(s.worktreePath, '.env'), 'TOPSECRET=1\n');
    const scoped = (await t.api('GET', `${base}?sessionId=${s.id}`)).json;
    const status = Object.fromEntries(scoped.files.map((f: any) => [f.path, f.status]));
    expect(status).toMatchObject({ 'README.md': 'M', 'docs/CONTRACT.md': 'M', 'notes.txt': '??' });
    expect(scoped.diff).toContain('+# changed staged');
    expect(scoped.diff).toContain('+unstaged edit');
    expect(scoped.diff).toContain('+brand new');
    expect(scoped.diff).not.toContain('TOPSECRET');

    const project = (await t.api('GET', base)).json; // main project folder is untouched by the session's edits
    expect(project).toMatchObject({ isRepo: true, files: [], diff: '' });
  });

  it('reports non-repositories and unborn repositories', async () => {
    const t = await boot({ exampleWorkspace: false });
    const plain = (await t.api('POST', '/api/projects', { name: 'plain', path: tmpDir() })).json;
    expect((await t.api('GET', `/api/projects/${plain.id}/git`)).json).toEqual({ branch: '', files: [], diff: '', isRepo: false });
    const unborn = tmpDir();
    runGit(unborn, 'init', '-q', '--initial-branch=trunk');
    writeFileSync(path.join(unborn, 'a.txt'), 'a\n');
    runGit(unborn, 'add', 'a.txt');
    const status = await gitStatus(unborn);
    expect(status).toMatchObject({ isRepo: true, branch: 'trunk' });
    expect(status.diff).toContain('+a');
  });

  it('keeps a project in a repository subdirectory scoped to that directory', async () => {
    const repo = makeRepo({ 'pkg/a.txt': 'a\n', 'other/b.txt': 'b\n' });
    writeFileSync(path.join(repo, 'pkg/a.txt'), 'a2\n');
    writeFileSync(path.join(repo, 'other/b.txt'), 'b2\n');
    mkdirSync(path.join(repo, 'pkg/new'));
    writeFileSync(path.join(repo, 'pkg/new/c.txt'), 'c\n');
    const status = await gitStatus(path.join(repo, 'pkg'));
    expect(status.diff).toContain('a2');
    expect(status.diff).toContain('+c');
    expect(status.diff).not.toContain('b2');
  });

  it('parses porcelain status records', () => {
    expect(parsePorcelain(' M a.txt\0M  b.txt\0MM c.txt\0?? d.txt\0R  new.txt\0old.txt\0A  e.txt\0')).toEqual([
      { path: 'a.txt', status: 'M' }, { path: 'b.txt', status: 'M' }, { path: 'c.txt', status: 'M' }, { path: 'd.txt', status: '??' }, { path: 'new.txt', status: 'R' }, { path: 'e.txt', status: 'A' },
    ]);
  });
});
