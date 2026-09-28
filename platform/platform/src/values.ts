/** Merge administrator overrides, then enforce platform-owned security settings. */
export function platformValues(
  overrides: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result = merge(defaults, overrides);
  const operator =
    result.operator && typeof result.operator === 'object' && !Array.isArray(result.operator)
      ? (result.operator as Record<string, unknown>)
      : {};
  result.operator = operator;
  operator.allowSharedHosts = false;
  operator.hostNamespaces = (defaults.operator as Record<string, unknown>).hostNamespaces;
  return result;
}
function merge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error(`Invalid values key: ${key}`);
    const original = result[key];
    result[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      original &&
      typeof original === 'object' &&
      !Array.isArray(original)
        ? merge(original as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return result;
}
