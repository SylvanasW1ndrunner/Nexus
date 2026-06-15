export function shouldInitializeIdeShell(input: { authenticated: boolean; initialized: boolean }): boolean {
  return input.authenticated && !input.initialized;
}

export function shouldCloseAuthDialog(input: { authenticated: boolean }): boolean {
  return input.authenticated;
}
