const SAMPLE_SIZE = 16 * 1024;
const MAX_CONTROL_CHARACTER_RATIO = 0.1;

function isSuspiciousControlCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 0 && codePoint < 8) ||
    (codePoint > 13 && codePoint < 32) ||
    codePoint === 127
  );
}

export function isBinaryBuffer(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, SAMPLE_SIZE);
  if (sample.length === 0) {
    return false;
  }

  if (sample.includes(0)) {
    return true;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return true;
  }

  let suspicious = 0;
  let total = 0;
  for (const character of decoded) {
    total += 1;
    if (isSuspiciousControlCharacter(character.codePointAt(0) ?? 0)) {
      suspicious += 1;
    }
  }

  return total > 0 && suspicious / total > MAX_CONTROL_CHARACTER_RATIO;
}
