export function shouldForwardTerminalData(data: string): boolean {
  if (!data) return false;
  return !isGeneratedTerminalReport(data);
}

function isGeneratedTerminalReport(data: string): boolean {
  if (data.charCodeAt(0) !== 27 || data[1] !== '[') return false;
  const body = data.slice(2);
  if (body.startsWith('?') && body.endsWith('c')) return body.slice(1, -1).split(';').every(isDigits);
  if (body.endsWith('t')) return body.slice(0, -1).split(';').every(isDigits);
  if (body.endsWith('R')) return body.slice(0, -1).split(';').every(isDigits);
  return false;
}

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char >= '0' && char <= '9');
}
