const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Solana base58. The alphabet has no 0, O, I, or l. */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] ?? 0) << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let encoded = "";
  for (let index = 0; bytes[index] === 0 && index < bytes.length - 1; index += 1) encoded += "1";
  for (let index = digits.length - 1; index >= 0; index -= 1) encoded += ALPHABET[digits[index] ?? 0] ?? "";
  return encoded;
}

export function base58Decode(text: string): Uint8Array {
  if (text.length === 0 || text.length > 128) throw new Error("Invalid base58.");
  const bytes = [0];
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error("Invalid base58.");
    let carry = value;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] ?? 0) * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let index = 0; text[index] === "1" && index < text.length - 1; index += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
