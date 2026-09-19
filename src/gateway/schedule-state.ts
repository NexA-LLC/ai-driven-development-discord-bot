import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const directory = process.env.SU_STATE_DIR ?? join(homedir(), '.local/state/su-gateway');
export function readSlot(name: string): string {
  try { return readFileSync(join(directory, name), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export function writeSlot(name: string, value: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  writeFileSync(path + '.tmp', value, { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
