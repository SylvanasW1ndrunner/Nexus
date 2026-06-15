import { describe, expect, it } from 'vitest';
import {
  availableAuthModes,
  authCodePurpose,
  canRequestAuthCode,
  canSubmitAuthForm,
  inferAuthChannel,
  isValidAuthTarget,
  isValidNewPassword,
} from './auth-form.js';

describe('auth form user flows', () => {
  const postgresCapabilities = {
    mode: 'postgres' as const,
    passwordLogin: true,
    verificationLogin: true,
    registration: true,
    passwordReset: true,
    testAccount: false,
  };

  const localTestCapabilities = {
    mode: 'local-test' as const,
    passwordLogin: true,
    verificationLogin: false,
    registration: false,
    passwordReset: false,
    testAccount: true,
  };

  it('infers email and phone channels from the target input', () => {
    expect(inferAuthChannel('analyst@example.com')).toBe('email');
    expect(inferAuthChannel('+86 138-0000-0000')).toBe('phone');
  });

  it('validates email and phone targets before enabling auth actions', () => {
    expect(isValidAuthTarget('analyst@example.com')).toBe(true);
    expect(isValidAuthTarget('bad-email@')).toBe(false);
    expect(isValidAuthTarget('+86 138-0000-0000')).toBe(true);
    expect(isValidAuthTarget('abc123')).toBe(false);
  });

  it('maps form mode to verification code purpose', () => {
    expect(authCodePurpose('register')).toBe('register');
    expect(authCodePurpose('reset-password')).toBe('reset-password');
    expect(authCodePurpose('code-login')).toBe('login');
  });

  it('exposes only available authentication modes for the configured auth backend', () => {
    expect(availableAuthModes(postgresCapabilities)).toEqual(['login', 'code-login', 'register', 'reset-password']);
    expect(availableAuthModes(localTestCapabilities)).toEqual(['login']);
    expect(availableAuthModes(undefined)).toEqual(['login']);
  });

  it('prevents requesting codes without a target or while busy', () => {
    expect(canRequestAuthCode({ mode: 'login', target: 'user@example.com', busy: false })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: '', busy: false })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: 'bad-email@', busy: false })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: 'user@example.com', busy: true })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: 'user@example.com', busy: false })).toBe(true);
  });

  it('enables submit only when the selected login flow has required fields', () => {
    expect(canSubmitAuthForm({ mode: 'login', target: 'user@example.com', password: '', code: '', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'login', target: 'test', password: 'test', code: '', busy: false })).toBe(true);
    expect(canSubmitAuthForm({ mode: 'login', target: 'user@example.com', password: 'password-123', code: '', busy: false })).toBe(true);
    expect(canSubmitAuthForm({ mode: 'code-login', target: 'test', password: '', code: '123456', busy: false })).toBe(false);
    expect(
      canSubmitAuthForm({
        mode: 'code-login',
        target: 'user@example.com',
        password: '',
        code: '123456',
        busy: false,
        capabilities: postgresCapabilities,
      }),
    ).toBe(true);
    expect(canSubmitAuthForm({ mode: 'reset-password', target: 'user@example.com', password: 'password-123', code: '', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'register', target: 'user@example.com', password: 'short', code: '123456', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'reset-password', target: 'user@example.com', password: 'short', code: '123456', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'register', target: 'user@example.com', password: 'password-123', code: '123456', busy: true })).toBe(false);
    expect(
      canSubmitAuthForm({
        mode: 'register',
        target: 'user@example.com',
        password: 'password-123',
        code: '123456',
        busy: false,
        capabilities: localTestCapabilities,
      }),
    ).toBe(false);
  });

  it('requires new passwords to match backend minimum length while keeping test login possible', () => {
    expect(isValidNewPassword('short')).toBe(false);
    expect(isValidNewPassword('password')).toBe(true);
    expect(canSubmitAuthForm({ mode: 'login', target: 'test', password: 'test', code: '', busy: false })).toBe(true);
  });
});
