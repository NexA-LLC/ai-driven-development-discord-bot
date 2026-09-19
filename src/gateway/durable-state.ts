import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ZodType } from "zod";

export const statePath = (name: string): string => join(process.env.SU_STATE_DIR ?? join(homedir(), ".local/state/su-gateway"), name);

/** One Gateway owns each file. A damaged file is never silently overwritten. */
export class DurableState<T> {
  value: T;
  readonly available: boolean;
  constructor(private path: string, schema: ZodType<T>, initial: T) {
    this.value = initial;
    try {
      this.value = schema.parse(JSON.parse(readFileSync(path, "utf8")));
      this.available = true;
    } catch (error) {
      this.available = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!this.available) console.error(`state unavailable: ${path.split("/").at(-1)}`);
    }
  }
  save(): void {
    if (!this.available) throw new Error("Persistent state unavailable");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    writeFileSync(this.path + ".tmp", JSON.stringify(this.value), { mode: 0o600 });
    chmodSync(this.path + ".tmp", 0o600);
    renameSync(this.path + ".tmp", this.path);
  }
}
