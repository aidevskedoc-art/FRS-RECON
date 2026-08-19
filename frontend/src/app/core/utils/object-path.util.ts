/** Reads a dot-notation path (e.g. 'premium.gst', 'members.0.age') off an object. */
export function getAtPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/** Immutably sets a dot-notation path, cloning only the objects/arrays along the way. */
export function setAtPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  return setAtKeys(obj, keys, value) as T;
}

function setAtKeys(obj: unknown, keys: string[], value: unknown): unknown {
  const [key, ...rest] = keys;
  const isArray = Array.isArray(obj);
  const source = (obj ?? (isArray ? [] : {})) as Record<string, unknown>;

  if (rest.length === 0) {
    if (isArray) {
      const clone = [...(source as unknown as unknown[])];
      clone[Number(key)] = value;
      return clone;
    }
    return { ...source, [key]: value };
  }

  const childValue = setAtKeys(source[key], rest, value);
  if (isArray) {
    const clone = [...(source as unknown as unknown[])];
    clone[Number(key)] = childValue;
    return clone;
  }
  return { ...source, [key]: childValue };
}
