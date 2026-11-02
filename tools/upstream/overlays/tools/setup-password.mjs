import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { emitKeypressEvents } from 'node:readline';

if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdout.write('New login password (12+ characters): ');
let password = '';
process.stdin.on('keypress', async (text, key) => {
  if (key?.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.exit(130); }
  if (key?.name === 'backspace') { password = Array.from(password).slice(0, -1).join(''); return; }
  if (key?.name !== 'return' && key?.name !== 'enter') { if (text && !key?.ctrl && !key?.meta) password += text; return; }
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\n');
  if (password.length < 12 || password.length > 256) { console.error('Use between 12 and 256 characters.'); process.exit(1); }
  const salt = randomBytes(16).toString('hex');
  const hash = await promisify(scrypt)(password, salt, 64);
  password = '';
  console.log(`ASSISTANT_WEB_PASSWORD_HASH=scrypt:${salt}:${hash.toString('hex')}`);
  process.exit(0);
});
