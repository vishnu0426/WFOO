import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { checkPassword, hashPassword, hashStats } from '../src/passwordHash.ts';

describe('password hashing off the main thread', () => {
  it('hashes so that bcryptjs verifies it, and verifies hashes bcryptjs made', async () => {
    const h = await hashPassword('correct horse', 10);
    assert.match(h, /^\$2[aby]\$10\$/);
    assert.equal(await bcrypt.compare('correct horse', h), true);
    assert.equal(await checkPassword('correct horse', h), true);
    assert.equal(await checkPassword('wrong', h), false);
    assert.equal(await checkPassword('x', await bcrypt.hash('x', 10)), true, 'a hash made elsewhere still verifies');
  });
  it('keeps the main thread free while many are checked at once', async () => {
    const h = bcrypt.hashSync('pw', 12);
    let worst = 0, last = Date.now();
    const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 10);
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 12 }, () => checkPassword('pw', h)));
    clearInterval(timer);
    assert.ok(results.every(Boolean));
    assert.ok(worst < 150, `the main thread was held up for ${worst} ms while 12 passwords were checked (${Date.now() - t0} ms in all)`);
    assert.equal(hashStats.inline, 0, 'the work did run on the worker threads');
  });
  it('a malformed hash is a wrong password, not a crash', async () => {
    assert.equal(await checkPassword('pw', 'not-a-hash'), false);
  });
});
