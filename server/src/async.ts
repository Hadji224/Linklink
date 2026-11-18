/** Équivalents asynchrones des méthodes de tableau (les callbacks `async` de .map/.filter ne sont pas attendus par JavaScript). */
export const mapA = <T, U>(arr: readonly T[], fn: (x: T, i: number) => Promise<U> | U): Promise<U[]> => Promise.all(arr.map(fn));

export async function filterA<T>(arr: readonly T[], fn: (x: T, i: number) => Promise<boolean> | boolean): Promise<T[]> {
  const keep = await Promise.all(arr.map(fn));
  return arr.filter((_, i) => keep[i]);
}

export async function someA<T>(arr: readonly T[], fn: (x: T, i: number) => Promise<boolean> | boolean): Promise<boolean> {
  for (let i = 0; i < arr.length; i++) if (await fn(arr[i] as T, i)) return true;
  return false;
}

export async function everyA<T>(arr: readonly T[], fn: (x: T, i: number) => Promise<boolean> | boolean): Promise<boolean> {
  for (let i = 0; i < arr.length; i++) if (!(await fn(arr[i] as T, i))) return false;
  return true;
}

export async function forEachA<T>(arr: readonly T[], fn: (x: T, i: number) => unknown): Promise<void> {
  for (let i = 0; i < arr.length; i++) await fn(arr[i] as T, i);
}
