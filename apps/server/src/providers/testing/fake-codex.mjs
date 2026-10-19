// Fixture process standing in for `codex`: answers `--version` and speaks a scripted slice of the app-server protocol.
// Behaviour is selected with FAKE_CODEX_MODE so tests exercise real spawn, stdio and signal handling without any model call.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_CODEX_MODE ?? 'happy';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  console.error('unsupported invocation');
  process.exit(2);
}
if (process.env.FAKE_CODEX_PIDFILE) writeFileSync(process.env.FAKE_CODEX_PIDFILE, String(process.pid));
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => undefined);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('close', () => { if (mode !== 'ignore-sigterm' && mode !== 'ignore-stdin-eof') process.exit(0); });
const ids = { thread: 'thr_fixture', turn: 'turn_fixture' };
let nextServerId = 1000;

rl.on('line', (line) => {
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      if (mode === 'no-initialize') return;
      send({ id: message.id, result: { userAgent: 'fake-codex', codexHome: '/nonexistent', platformFamily: 'unix', platformOs: 'linux' } });
      break;
    case 'account/read':
      send({ id: message.id, result: process.env.FAKE_CODEX_ACCOUNT === 'none' ? { account: null, requiresOpenaiAuth: true } : { account: { type: 'chatgpt', email: 'x@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true } });
      break;
    case 'model/list':
      send({ id: message.id, result: { data: [
        { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', hidden: false, isDefault: true },
        { id: 'secret-model', model: 'secret-model', displayName: 'Hidden', hidden: true },
      ], nextCursor: null } });
      break;
    case 'thread/start':
      send({ id: message.id, result: { thread: { id: ids.thread }, model: message.params.model } });
      break;
    case 'turn/start':
      send({ id: message.id, result: { turn: { id: ids.turn, status: 'inProgress', items: [] } } });
      send({ method: 'turn/started', params: { threadId: ids.thread, turn: { id: ids.turn, status: 'inProgress', items: [] } } });
      if (mode === 'happy') {
        send({ method: 'item/agentMessage/delta', params: { threadId: ids.thread, turnId: ids.turn, itemId: 'msg1', delta: 'Hello ' } });
        send({ method: 'item/agentMessage/delta', params: { threadId: ids.thread, turnId: ids.turn, itemId: 'msg1', delta: 'world' } });
        send({ method: 'turn/completed', params: { threadId: ids.thread, turn: { id: ids.turn, status: 'completed', items: [] } } });
      } else if (mode === 'exit-mid-turn') {
        send({ method: 'item/agentMessage/delta', params: { threadId: ids.thread, turnId: ids.turn, itemId: 'msg1', delta: 'partial' } });
        console.error('fatal: ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop crashed the sandbox');
        setTimeout(() => process.exit(3), 20);
      } else if (mode === 'approval') {
        send({ id: nextServerId++, method: 'item/commandExecution/requestApproval', params: { threadId: ids.thread, turnId: ids.turn, itemId: 'cmd1', command: 'rm -rf build', cwd: '/work', reason: 'cleanup' } });
      }
      break;
    case 'turn/interrupt':
      if (mode === 'ignore-sigterm' || mode === 'ignore-interrupt') return;
      send({ id: message.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: ids.thread, turn: { id: ids.turn, status: 'interrupted', items: [] } } });
      break;
    default:
      if (message.id !== undefined && message.method === undefined) {
        // Response to a server request (approval decision): finish the turn accordingly.
        send({ method: 'item/completed', params: { threadId: ids.thread, turnId: ids.turn, item: { type: 'agentMessage', id: 'msg2', text: `decision=${message.result?.decision}` } } });
        send({ method: 'turn/completed', params: { threadId: ids.thread, turn: { id: ids.turn, status: 'completed', items: [] } } });
      }
  }
});
