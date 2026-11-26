/**
 * Single-line field hygiene. Unicode line breaks and bidi controls are rejected
 * at parse time and stripped again before anything is written to the job summary.
 */

const EXTRA_LINE_BREAKS = new Set([0x0b, 0x0c, 0x85, 0x2028, 0x2029]);

export function isUnsafeSingleLineCode(code: number): boolean {
  if (EXTRA_LINE_BREAKS.has(code)) return true;
  if (code >= 0x202a && code <= 0x202e) return true;
  if (code >= 0x2066 && code <= 0x2069) return true;
  return false;
}

export function hasUnsafeSingleLine(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isUnsafeSingleLineCode(value.charCodeAt(i))) return true;
  }
  return false;
}

export function stripUnsafeSingleLine(value: string): string {
  let out = "";
  for (const char of value) {
    if (!isUnsafeSingleLineCode(char.charCodeAt(0))) out += char;
  }
  return out;
}
