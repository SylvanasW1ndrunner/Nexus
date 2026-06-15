import type { AuthCapabilities } from '@dbagent/shared';

export type AuthFormMode = 'login' | 'register' | 'code-login' | 'reset-password';

export function inferAuthChannel(target: string): 'email' | 'phone' {
  return target.includes('@') ? 'email' : 'phone';
}

export function isValidAuthTarget(target: string): boolean {
  const value = target.trim();
  if (!value) return false;
  if (inferAuthChannel(value) === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return /^\+?[0-9]{8,20}$/.test(value.replace(/[\s-]/g, ''));
}

export function authCodePurpose(mode: AuthFormMode): 'register' | 'login' | 'reset-password' {
  if (mode === 'register') return 'register';
  if (mode === 'reset-password') return 'reset-password';
  return 'login';
}

export function canRequestAuthCode(input: { mode: AuthFormMode; target: string; busy: boolean }): boolean {
  return input.mode !== 'login' && isValidAuthTarget(input.target) && !input.busy;
}

export function availableAuthModes(capabilities?: AuthCapabilities): AuthFormMode[] {
  const modes: AuthFormMode[] = [];
  if (capabilities?.passwordLogin !== false) modes.push('login');
  if (capabilities?.verificationLogin) modes.push('code-login');
  if (capabilities?.registration) modes.push('register');
  if (capabilities?.passwordReset) modes.push('reset-password');
  return modes.length ? modes : ['login'];
}

export function isAuthModeAvailable(mode: AuthFormMode, capabilities?: AuthCapabilities): boolean {
  return availableAuthModes(capabilities).includes(mode);
}

export function canSubmitAuthForm(input: {
  mode: AuthFormMode;
  target: string;
  password: string;
  code: string;
  busy: boolean;
  capabilities?: AuthCapabilities | undefined;
}): boolean {
  if (input.busy) return false;
  if (!isAuthModeAvailable(input.mode, input.capabilities)) return false;
  if (input.mode === 'login') return Boolean(input.target.trim()) && Boolean(input.password);
  if (!isValidAuthTarget(input.target)) return false;
  if (input.mode === 'code-login') return Boolean(input.code.trim());
  return isValidNewPassword(input.password) && Boolean(input.code.trim());
}

export function isValidNewPassword(password: string): boolean {
  return password.length >= 8;
}
