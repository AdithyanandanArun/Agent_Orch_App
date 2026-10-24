/** Implicit-TLS Gmail submission. The caller supplies a verified TLS connection. */
export interface SmtpConnection {
  read(buffer: Uint8Array): Promise<number | null>;
  write(buffer: Uint8Array): Promise<number>;
  close(): void;
}

export interface GmailInvitation {
  user: string;
  password: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
}

const encoder = new TextEncoder();
const mailbox = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;

function base64(value: string): string {
  return btoa(Array.from(encoder.encode(value), byte => String.fromCharCode(byte)).join(''));
}

function encodedBody(value: string): string {
  return base64(value).match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function encodedSubject(value: string): string {
  const words: string[] = [];
  let word = '';
  for (const character of value) {
    if (encoder.encode(word + character).length > 42) {
      words.push(`=?UTF-8?B?${base64(word)}?=`);
      word = '';
    }
    word += character;
  }
  if (word) words.push(`=?UTF-8?B?${base64(word)}?=`);
  return words.join('\r\n ');
}

function mimeMessage(input: GmailInvitation): string {
  const boundary = `mingle_${crypto.randomUUID().replaceAll('-', '')}`;
  const subject = encodedSubject(input.subject);
  return [
    `From: Mingle <${input.user}>`, `To: <${input.to}>`, `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${input.messageId}@mingle.local>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody(input.text),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody(input.html),
    `--${boundary}--`, '', '.', '',
  ].join('\r\n');
}

/** Resolves only after Gmail accepts DATA; never retries an uncertain submission. */
export async function sendGmailInvitation(input: GmailInvitation, options: {
  connect: () => Promise<SmtpConnection>;
  timeoutMs?: number;
}): Promise<void> {
  if (!mailbox.test(input.user) || input.user.length > 254 || !/@gmail\.com$/i.test(input.user)
    || !mailbox.test(input.to) || input.to.length > 254
    || !/^[A-Za-z0-9._-]{1,100}$/.test(input.messageId)
    || !input.subject || encoder.encode(input.subject).length > 400 || /[\r\n\u0000]/.test(input.subject)
    || encoder.encode(input.text).length + encoder.encode(input.html).length > 128 * 1024) {
    throw new Error('Invalid invitation email fields.');
  }
  const password = input.password.replace(/ /g, '');
  if (!/^[a-zA-Z0-9]{16}$/.test(password)) throw new Error('Configure a valid Gmail app password.');
  const timeoutMs = options.timeoutMs ?? 35_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid SMTP timeout.');
  let socket: SmtpConnection | undefined;
  let stopped = false;
  let phase = 'connection';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      try { socket?.close(); } catch { /* Already closed. */ }
      reject(new Error('Gmail invitation submission timed out; delivery may be uncertain.'));
    }, timeoutMs);
  });

  const submit = async () => {
    socket = await options.connect();
    if (stopped) { socket.close(); throw new Error('SMTP stopped.'); }
    let pending = '';
    let received = 0;
    async function line(): Promise<string> {
      for (;;) {
        const end = pending.indexOf('\r\n');
        if (end >= 0) {
          const result = pending.slice(0, end);
          pending = pending.slice(end + 2);
          return result;
        }
        if (pending.length > 8192 || received > 64 * 1024 || stopped) throw new Error('Invalid SMTP response.');
        const buffer = new Uint8Array(2048);
        const count = await socket!.read(buffer);
        if (count === null || count <= 0 || count > buffer.length) throw new Error('SMTP connection closed.');
        received += count;
        pending += new TextDecoder().decode(buffer.subarray(0, count));
      }
    }
    async function reply(expected: number[]): Promise<{ code: number; lines: string[] }> {
      const lines: string[] = [];
      let code: number | undefined;
      for (let count = 0; count < 100; count++) {
        const value = await line();
        const match = /^(\d{3})([ -])(.*)$/.exec(value);
        if (!match || (code !== undefined && code !== Number(match[1]))) throw new Error('Invalid SMTP reply.');
        code = Number(match[1]);
        lines.push(match[3]);
        if (match[2] === ' ') {
          if (!expected.includes(code)) throw new Error('SMTP request rejected.');
          return { code, lines };
        }
      }
      throw new Error('SMTP reply limit exceeded.');
    }
    async function write(value: string): Promise<void> {
      const bytes = encoder.encode(value);
      for (let offset = 0; offset < bytes.length;) {
        if (stopped) throw new Error('SMTP stopped.');
        const count = await socket!.write(bytes.subarray(offset));
        if (count <= 0 || count > bytes.length - offset) throw new Error('SMTP write failed.');
        offset += count;
      }
    }
    phase = 'greeting';
    await reply([220]);
    phase = 'capabilities';
    await write('EHLO mingle.local\r\n');
    const capabilities = await reply([250]);
    if (!capabilities.lines.some(value => /^AUTH(?:=|\s).*\bPLAIN\b/i.test(value))) throw new Error('Gmail PLAIN authentication is unavailable.');
    phase = 'authentication';
    const auth = base64(`\0${input.user}\0${password}`);
    await write(`AUTH PLAIN ${auth}\r\n`);
    if ((await reply([235, 334])).code === 334) { await write(`${auth}\r\n`); await reply([235]); }
    phase = 'sender';
    await write(`MAIL FROM:<${input.user}>\r\n`); await reply([250]);
    phase = 'recipient';
    await write(`RCPT TO:<${input.to}>\r\n`); await reply([250, 251]);
    phase = 'submission';
    await write('DATA\r\n'); await reply([354]);
    await write(mimeMessage(input)); await reply([250]);
    // Receipt of DATA 250 is authoritative even if the peer closes before QUIT.
  };
  try {
    await Promise.race([submit(), timeout]);
  } catch {
    // Never propagate provider replies or socket errors that can contain secrets.
    throw new Error(`Gmail invitation submission failed during ${phase}; review sender setup before retrying.`);
  } finally {
    stopped = true;
    clearTimeout(timer);
    try { socket?.close(); } catch { /* Already closed. */ }
  }
}
