// Prints AUTH_USER / AUTH_HASH lines for .env. Usage: npm run -s hash-password [-- <user>] >> .env
// Reads the password from the terminal (not echoed), or from stdin when piped.
import readline from 'readline';
import { hashPassword } from '../server/auth.ts';

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(input);
        }
        if (c === '\u0003') process.exit(130); // Ctrl-C
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1);
        else input += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) return line;
  return '';
}

const user = process.argv[2] || 'admin';
if (user.includes(':')) {
  console.error('User name cannot contain ":"');
  process.exit(1);
}
let password: string;
if (process.stdin.isTTY) {
  password = await readHidden('Password: ');
  if ((await readHidden('Repeat: ')) !== password) {
    console.error('Passwords do not match');
    process.exit(1);
  }
} else {
  password = await readPiped();
}
if (password.length < 12) {
  console.error('Use at least 12 characters');
  process.exit(1);
}

console.log(`AUTH_USER=${user}`);
console.log(`AUTH_HASH=${await hashPassword(password)}`);
