// Command line: `setpassword` and `logout-all`, run on the server (in Docker:
// docker exec -it somaari-trip somaari-trip <command>). They work whether the server is running
// or not; a running server picks up the change on its next request.
import path from 'path';
import readline from 'readline';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth.ts';
import { DEFAULT_USER, randomPassword } from './authSetup.ts';
import { AUTH_FILE, logoutAll, readAuthFile, validUser, writeAuthFile } from './authStore.ts';

export const USAGE = `Usage:
  somaari-trip setpassword [--user NAME] [--random]
      Set the password (asked twice, at least ${MIN_PASSWORD_LENGTH} characters; or one line on stdin).
      --user NAME  also change the user name (default: keep it, or "${DEFAULT_USER}")
      --random     make a random password and print it once
  somaari-trip logout-all
      End every session and keep the password
Both log everyone out.`;

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
        if (c === '\u0003') {
          process.stderr.write('\n');
          process.exit(130); // Ctrl-C
        }
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1);
        else input += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function readLine(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) return line;
  return '';
}

/** Runs a command; returns the exit code */
export async function runCli(args: string[], dataDir: string): Promise<number> {
  const file = path.join(dataDir, AUTH_FILE);
  const [cmd, ...rest] = args;
  try {
    if (cmd === 'logout-all' && rest.length === 0) {
      logoutAll(file);
      console.log('Everyone is logged out. The password is unchanged.');
      return 0;
    }
    if (cmd !== 'setpassword') {
      console.error(USAGE);
      return cmd === 'help' || cmd === '--help' ? 0 : 2;
    }

    let user: string | undefined;
    let random = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--random') random = true;
      else if (rest[i] === '--user' && rest[i + 1] !== undefined) user = rest[++i];
      else {
        console.error(USAGE);
        return 2;
      }
    }
    user ??= readAuthFile(file)?.user ?? DEFAULT_USER;
    if (!validUser(user)) {
      console.error('User name must be 1-64 characters, without spaces or ":"');
      return 1;
    }

    let password: string;
    if (random) {
      password = randomPassword();
    } else if (process.stdin.isTTY) {
      password = await readHidden(`New password for ${user}: `);
      if ((await readHidden('Repeat it: ')) !== password) {
        console.error('The passwords do not match. Nothing was changed.');
        return 1;
      }
    } else {
      password = await readLine();
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(`Use at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
      return 1;
    }

    writeAuthFile(file, user, await hashPassword(password));
    console.log(`Password set for ${user}. Everyone is logged out.`);
    if (random) console.log(`  password: ${password}\nIt is shown only this once.`);
    return 0;
  } catch (err: any) {
    console.error(err.message);
    return 1;
  }
}
