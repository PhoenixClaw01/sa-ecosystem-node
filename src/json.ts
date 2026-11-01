/** JSON clone that renders bigint as a decimal string. */
export function toJsonSafe(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "bigint" ? inner.toString() : inner,
  );
  if (text === undefined) return null;
  return JSON.parse(text) as unknown;
}
