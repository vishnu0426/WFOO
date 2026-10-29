/**
 * CLI command to create or update a Super Admin account.
 * Interactive: asks for email and password.
 * Never prints or hardcodes credentials.
 */
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { config } from '../src/config.ts';

let nonTtyLines: string[] | null = null;
let nonTtyIndex = 0;

async function ask(query: string, hidden = false): Promise<string> {
  if (process.stdin.isTTY) {
    if (hidden) {
      return new Promise((resolve) => {
        process.stdout.write(query);
        let input = '';
        const onData = (char: Buffer) => {
          const c = char.toString();
          if (c === '\n' || c === '\r' || c === '\u0004') {
            process.stdin.removeListener('data', onData);
            process.stdin.setRawMode?.(false);
            process.stdout.write('\n');
            resolve(input.trim());
          } else if (c === '\u0008' || c === '\x7f') {
            if (input.length > 0) {
              input = input.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (c === '\u0003') {
            process.exit(1);
          } else {
            input += c;
            process.stdout.write('*');
          }
        };
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
      });
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(query, (ans) => {
          rl.close();
          resolve(ans.trim());
        });
      });
    }
  }

  // Non-TTY (piped / automated stdin)
  if (!nonTtyLines) {
    const fs = await import('node:fs');
    const content = fs.readFileSync(0, 'utf-8');
    nonTtyLines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  }

  process.stdout.write(query);
  const ans = nonTtyLines[nonTtyIndex++] || '';
  process.stdout.write(hidden ? '********\n' : `${ans}\n`);
  return ans;
}

async function main() {
  console.log('--- WFM Platform Super Admin Creation ---');
  const email = (await ask('Super Admin Email: ')).toLowerCase().trim();
  if (!email || !email.includes('@') || !email.includes('.')) {
    console.error('Error: A valid email address is required.');
    process.exit(1);
  }

  const password = await ask('Super Admin Password (min 8 characters): ', true);
  if (!password || password.length < 8) {
    console.error('Error: Password must be at least 8 characters long.');
    process.exit(1);
  }

  const confirm = await ask('Confirm Password: ', true);
  if (password !== confirm) {
    console.error('Error: Passwords do not match.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: config.databaseUrl });
  try {
    await client.connect();
    // Ensure table exists in case migration hasn't been run through the gateway yet
    await client.query(`
      CREATE TABLE IF NOT EXISTS wfm.platform_admins (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email         text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    const hash = await bcrypt.hash(password, 12);
    const res = await client.query(
      `INSERT INTO wfm.platform_admins (email, password_hash, status)
       VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'ACTIVE', updated_at = now()
       RETURNING id, email, status`,
      [email, hash]
    );

    console.log(`\nSuper Admin account for "${res.rows[0].email}" provisioned successfully.`);
  } catch (err: any) {
    console.error('Database error provisioning superadmin:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
