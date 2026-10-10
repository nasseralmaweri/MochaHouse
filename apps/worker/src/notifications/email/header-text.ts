// Security 4A — text that is safe inside an email header (Subject, From
// display name): every control character (so no CR/LF header injection)
// becomes a space, whitespace is collapsed and the ends are trimmed.
export function headerText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out.replace(/\s+/g, ' ').trim();
}
