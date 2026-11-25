import { describe, expect, it } from 'vitest';
import { hashPassword, resolveAuth } from './auth.ts';

describe('resolveAuth', () => {
  it('uses the login when AUTH_USER and AUTH_HASH are set', async () => {
    const hash = await hashPassword('correct horse battery', 1024);
    expect(resolveAuth({ AUTH_USER: 'u', AUTH_HASH: hash }, true)).toEqual({
      auth: { user: 'u', hash },
    });
  });

  it('refuses to start in production without a login', () => {
    expect(resolveAuth({}, true).error).toMatch(/required in production/);
  });

  it('rejects a mangled hash', () => {
    expect(resolveAuth({ AUTH_USER: 'u', AUTH_HASH: 'scrypt:1' }, true).error).toMatch(/not a valid/);
  });

  it('runs without a login in production when NO_LOGIN=true, even if a login is set', () => {
    for (const env of [{ NO_LOGIN: 'true' }, { NO_LOGIN: 'true', AUTH_USER: 'u', AUTH_HASH: 'x' }]) {
      const r = resolveAuth(env, true);
      expect(r.auth).toBeUndefined();
      expect(r.warning).toMatch(/no login/);
    }
  });

  it('treats NO_LOGIN=false as unset and rejects other values', () => {
    expect(resolveAuth({ NO_LOGIN: 'false' }, true).error).toMatch(/required in production/);
    expect(resolveAuth({ NO_LOGIN: 'yes' }, true).error).toMatch(/true or false/);
  });

  it('allows no login in dev', () => {
    expect(resolveAuth({}, false).warning).toMatch(/dev only/);
  });
});
