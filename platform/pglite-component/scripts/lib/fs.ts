/** Small filesystem predicates shared by the build scripts. */
import { stat } from 'node:fs/promises';

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isExecutable(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}
