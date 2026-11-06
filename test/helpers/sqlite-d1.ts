import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const program = `
import { DatabaseSync } from 'node:sqlite';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const db = new DatabaseSync(request.path);
db.exec('PRAGMA busy_timeout = 10000');
try {
  if (request.script) { db.exec(request.script); console.log('null'); }
  else {
    if (request.transaction) db.exec('BEGIN IMMEDIATE');
    try {
      const results = request.statements.map(({sql, params}) => {
        const statement = db.prepare(sql);
        let rows = statement.all(...params);
        // Deliberately scramble RETURNING rows: SQLite gives no ordering guarantee.
        if (/RETURNING/i.test(sql)) rows = rows.reverse();
        const changes = db.prepare('SELECT changes() AS changes').get().changes;
        return { success: true, results: rows, meta: { changes } };
      });
      if (request.transaction) db.exec('COMMIT');
      console.log(JSON.stringify(results));
    } catch (error) { if (request.transaction) db.exec('ROLLBACK'); throw error; }
  }
} finally { db.close(); }
`;
type Statement = { sql: string; params: unknown[] };
export class SqliteD1 {
  private directory = mkdtempSync(join(tmpdir(), "combined-work-test-"));
  private path = join(this.directory, "db.sqlite");
  batchCalls = 0;
  failBatchStatement: number | undefined;
  constructor() {
    this.script(["0002_ai_jobs.sql", "0004_gateway_commands.sql"].map(name => readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")).join("\n"));
  }
  close() { rmSync(this.directory, { recursive: true, force: true }); }
  private sync(request: object): any {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-sqlite", "--input-type=module", "-e", program], {
      input: JSON.stringify({ path: this.path, ...request }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }));
  }
  script(script: string) { this.sync({ script }); }
  rows(sql: string, ...params: unknown[]): any[] {
    return this.sync({ statements: [{ sql, params }] })[0].results;
  }
  prepare(sql: string): any {
    const make = (params: unknown[]) => ({ sql, params,
      bind: (...values: unknown[]) => make(values),
      run: async () => this.sync({ statements: [{ sql, params }] })[0],
      all: async () => this.sync({ statements: [{ sql, params }] })[0],
    });
    return make([]);
  }
  async batch(statements: Statement[]): Promise<any[]> {
    this.batchCalls++;
    const requests = statements.map((s, i) => ({ sql: i === this.failBatchStatement ? "SELECT * FROM deliberately_missing_table" : s.sql, params: i === this.failBatchStatement ? [] : s.params }));
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-sqlite", "--input-type=module", "-e", program], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "", error = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { error += chunk; });
      child.on("error", reject);
      child.on("close", code => { if (code !== 0) reject(new Error(error)); else { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } } });
      child.stdin.end(JSON.stringify({ path: this.path, statements: requests, transaction: true }));
    });
  }
}
