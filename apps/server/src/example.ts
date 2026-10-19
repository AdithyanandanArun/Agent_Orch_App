import fsp from 'node:fs/promises';
import path from 'node:path';
import { addWorktree, git } from './git.ts';
import type { Store } from './store.ts';
import type { Logger } from './types.ts';
import { errorMessage } from './util.ts';

export const EXAMPLE_PROJECT_ID = 'prj_example';
export const EXAMPLE_CONTRACT_SESSION_ID = 'ses_example_contract';
export const EXAMPLE_CLIENT_SESSION_ID = 'ses_example_client';
export const EXAMPLE_ARTIFACT_PATH = 'api/users.v1.openapi.json';
const SEED_KEY = 'example_workspace_v1';

const README = `# Relay example workspace

> **This is an example workspace** created by Relay so you can explore the interface. It is not one of your projects,
> no model has been run in it, and every task here is sample data you can change freely.

The folder is a small Git repository. Relay created two example sessions (both idle) in separate Git worktrees:

- **Example · Contract author** works on the versioned API artifact \`${EXAMPLE_ARTIFACT_PATH}\`.
- **Example · Client builder** consumes that artifact. Use *handoff* to send it a committed revision of the contract.

Nothing runs until you send a message to a session, and that uses your own installed provider and credentials.
`;

const CONTRACT = `# Users API contract (example)

Version: **v1**. The machine-readable artifact lives in \`${EXAMPLE_ARTIFACT_PATH}\`.

Rules for contributors (human or agent):

1. Changes to the artifact are committed on the author's branch before they are handed off.
2. The version in the file name only changes for breaking changes.
3. Consumers never edit the artifact; they request changes through the task board.
`;

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Example Users API', version: '1.0.0', description: 'Sample contract for the Relay example workspace.' },
  paths: {
    '/users': {
      get: { summary: 'List users', operationId: 'listUsers', responses: { '200': { description: 'A page of users', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } } },
      post: { summary: 'Create a user', operationId: 'createUser', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewUser' } } } }, responses: { '201': { description: 'Created' } } },
    },
    '/users/{id}': {
      get: { summary: 'Fetch a user', operationId: 'getUser', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'The user' }, '404': { description: 'Unknown user' } } },
    },
  },
  components: {
    schemas: {
      User: { type: 'object', required: ['id', 'email'], properties: { id: { type: 'string' }, email: { type: 'string', format: 'email' }, displayName: { type: 'string' } } },
      NewUser: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, displayName: { type: 'string' } } },
    },
  },
};

const GITIGNORE = 'node_modules/\n.env\n.env.*\n';

const SAMPLE_IDENTITY = ['user.name=Relay Example', 'user.email=example@relay.invalid', 'commit.gpgsign=false'];

/**
 * Creates the clearly labelled example workspace once per data directory: a real Git repository under the data dir, two
 * idle sessions in their own worktrees and a small task DAG. It never calls a model provider.
 */
export async function seedExampleWorkspace(store: Store, dataDir: string, log: Logger): Promise<boolean> {
  if (store.getMeta(SEED_KEY)) return false;
  const projectDir = path.join(dataDir, 'example-workspace');
  try {
    await fsp.mkdir(path.join(projectDir, 'api'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(projectDir, 'docs'), { recursive: true });
    await fsp.writeFile(path.join(projectDir, 'README.md'), README);
    await fsp.writeFile(path.join(projectDir, 'docs/CONTRACT.md'), CONTRACT);
    await fsp.writeFile(path.join(projectDir, EXAMPLE_ARTIFACT_PATH), `${JSON.stringify(OPENAPI, null, 2)}\n`);
    await fsp.writeFile(path.join(projectDir, '.gitignore'), GITIGNORE);
    const real = await fsp.realpath(projectDir);
    const hasRepo = (await git(real, ['rev-parse', '--git-dir'], { allowFailure: true })).code === 0 && (await fsp.stat(path.join(real, '.git')).catch(() => null));
    if (!hasRepo) await git(real, ['init', '--quiet', '--initial-branch=main']);
    const head = await git(real, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true });
    if (head.code !== 0) {
      await git(real, ['add', '--', '.']);
      await git(real, ['commit', '--quiet', '--no-verify', '-m', 'Initial example workspace'], { extraConfig: SAMPLE_IDENTITY });
    }
    const worktrees = path.join(dataDir, 'worktrees', EXAMPLE_PROJECT_ID);
    const make = async (id: string, branch: string) => {
      const target = path.join(worktrees, id);
      const exists = await fsp.stat(target).catch(() => null);
      if (!exists) await addWorktree(real, target, branch).catch(async (error) => {
        // Branch left over from a partially failed earlier seed: reuse it.
        if (!/already exists/.test(errorMessage(error))) throw error;
        await git(real, ['worktree', 'add', '--', target, branch]);
      });
      return fsp.realpath(target);
    };
    const contractTree = await make(EXAMPLE_CONTRACT_SESSION_ID, 'relay/example-contract-author');
    const clientTree = await make(EXAMPLE_CLIENT_SESSION_ID, 'relay/example-client-builder');

    store.tx(() => {
      const project = store.insertProject({ id: EXAMPLE_PROJECT_ID, name: 'Relay example workspace', path: real, isExample: true });
      const note = (id: string) => store.insertMessage({ sessionId: id, role: 'system', kind: 'info', content: 'Example session. No model has run here; it is idle until you send a message. Messages use your own installed provider and credentials.' });
      const a = store.insertSession({ id: EXAMPLE_CONTRACT_SESSION_ID, projectId: project.id, name: 'Example · Contract author', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', policy: 'supervised', isolated: true, worktreePath: contractTree, branch: 'relay/example-contract-author' });
      const b = store.insertSession({ id: EXAMPLE_CLIENT_SESSION_ID, projectId: project.id, name: 'Example · Client builder', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', policy: 'supervised', isolated: true, worktreePath: clientTree, branch: 'relay/example-client-builder' });
      note(a.id);
      note(b.id);
      const t1 = store.insertTask({ id: 'tsk_example_contract', projectId: project.id, title: 'Review and tighten the users API v1 contract', description: `[Example task] Review ${EXAMPLE_ARTIFACT_PATH}, add missing error responses and commit the result.`, acceptanceCriteria: 'Every operation documents its error responses; the file is committed.', sessionId: a.id, dependsOn: [], status: 'ready' });
      const t2 = store.insertTask({ id: 'tsk_example_client', projectId: project.id, title: 'Implement a typed client for the v1 contract', description: '[Example task] Build a small client that follows the committed contract revision handed off by the author.', acceptanceCriteria: 'Client covers listUsers, createUser and getUser.', sessionId: b.id, dependsOn: [t1.id], status: 'blocked' });
      const t3 = store.insertTask({ id: 'tsk_example_tests', projectId: project.id, title: 'Add client contract tests', description: '[Example task] Test the client against the contract examples.', acceptanceCriteria: 'Tests fail if the client drifts from the contract.', sessionId: b.id, dependsOn: [t2.id], status: 'blocked' });
      store.insertTask({ id: 'tsk_example_review', projectId: project.id, title: 'Review the integration and update the README', description: '[Example task] Human review of both branches before anything is merged.', acceptanceCriteria: 'Branches reviewed; README documents the final API.', sessionId: null, dependsOn: [t2.id, t3.id], status: 'blocked' });
      store.recordEvent({ projectId: project.id, type: 'workspace.example.created', summary: 'Example workspace created (sample data, no model runs)', payload: { example: true, path: real } });
      store.setMeta(SEED_KEY, new Date().toISOString());
    });
    return true;
  } catch (error) {
    log('error', `Could not create the example workspace: ${errorMessage(error)}`);
    return false;
  }
}
