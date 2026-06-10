export function shouldForwardTerminalData(data: string): boolean {
  if (!data) return false;
  return !isGeneratedTerminalReport(data);
}

function isGeneratedTerminalReport(data: string): boolean {
  if (data.charCodeAt(0) !== 27) return false;
  if (data[1] === ']') return true;
  if (data[1] !== '[') return false;
  if (isCommonInteractiveKey(data)) return false;
  const body = data.slice(2);
  if (body.startsWith('?') && body.endsWith('c')) return body.slice(1, -1).split(';').every(isDigits);
  if (body.startsWith('?') && (body.endsWith('h') || body.endsWith('l'))) return body.slice(1, -1).split(';').every(isDigits);
  if (body.endsWith('n')) return body.slice(0, -1).split(';').every(isDigits);
  if (body.endsWith('t')) return body.slice(0, -1).split(';').every(isDigits);
  if (body.endsWith('R')) return body.slice(0, -1).split(';').every(isDigits);
  return false;
}

function isCommonInteractiveKey(data: string): boolean {
  return (
    data === '\x1b[A' ||
    data === '\x1b[B' ||
    data === '\x1b[C' ||
    data === '\x1b[D' ||
    data === '\x1b[H' ||
    data === '\x1b[F' ||
    data === '\x1b[1~' ||
    data === '\x1b[4~' ||
    data === '\x1b[3~' ||
    data === '\x1b[5~' ||
    data === '\x1b[6~'
  );
}

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char >= '0' && char <= '9');
}
