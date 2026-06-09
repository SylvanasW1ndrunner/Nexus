import { describe, expect, it } from 'vitest';
import { authCodePurpose, canRequestAuthCode, canSubmitAuthForm, inferAuthChannel } from './auth-form.js';

describe('auth form user flows', () => {
  it('infers email and phone channels from the target input', () => {
    expect(inferAuthChannel('analyst@example.com')).toBe('email');
    expect(inferAuthChannel('+86 138-0000-0000')).toBe('phone');
  });

  it('maps form mode to verification code purpose', () => {
    expect(authCodePurpose('register')).toBe('register');
    expect(authCodePurpose('reset-password')).toBe('reset-password');
    expect(authCodePurpose('code-login')).toBe('login');
  });

  it('prevents requesting codes without a target or while busy', () => {
    expect(canRequestAuthCode({ mode: 'login', target: 'user@example.com', busy: false })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: '', busy: false })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: 'user@example.com', busy: true })).toBe(false);
    expect(canRequestAuthCode({ mode: 'register', target: 'user@example.com', busy: false })).toBe(true);
  });

  it('enables submit only when the selected login flow has required fields', () => {
    expect(canSubmitAuthForm({ mode: 'login', target: 'user@example.com', password: '', code: '', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'login', target: 'user@example.com', password: 'password-123', code: '', busy: false })).toBe(true);
    expect(canSubmitAuthForm({ mode: 'code-login', target: 'user@example.com', password: '', code: '123456', busy: false })).toBe(true);
    expect(canSubmitAuthForm({ mode: 'reset-password', target: 'user@example.com', password: 'password-123', code: '', busy: false })).toBe(false);
    expect(canSubmitAuthForm({ mode: 'register', target: 'user@example.com', password: 'password-123', code: '123456', busy: true })).toBe(false);
  });
});
