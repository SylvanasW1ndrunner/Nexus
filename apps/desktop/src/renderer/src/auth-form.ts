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

export function canSubmitAuthForm(input: {
  mode: AuthFormMode;
  target: string;
  password: string;
  code: string;
  busy: boolean;
}): boolean {
  if (input.busy || !isValidAuthTarget(input.target)) return false;
  if (input.mode === 'login') return Boolean(input.password);
  if (input.mode === 'code-login') return Boolean(input.code.trim());
  return Boolean(input.password) && Boolean(input.code.trim());
}
