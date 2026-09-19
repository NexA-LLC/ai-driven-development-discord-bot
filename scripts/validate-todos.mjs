import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "todos.jsonl";
const raw = readFileSync(path, "utf8");
const lines = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const errors = [];
const records = [];

for (let index = 0; index < lines.length; index += 1) {
  try {
    records.push(JSON.parse(lines[index]));
  } catch (error) {
    errors.push(`line ${index + 1}: invalid JSON (${error.message})`);
  }
}

const meta = records.find((record) => record?.kind === "meta");
const tasks = records.filter((record) => record?.kind === "task");

if (!meta) {
  errors.push("missing meta record");
}

const statusValues = new Set(
  meta?.status_values ?? [
    "done",
    "next",
    "planned",
    "blocked",
    "parked",
    "cancelled",
  ],
);
const priorityValues = new Set(
  meta?.priority_values ?? ["P0", "P1", "P2", "P3"],
);
const uuid7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = new Map();
const ids = new Map();

for (const task of tasks) {
  const label = task?.key ?? task?.id ?? "<unknown>";

  if (typeof task?.key !== "string" || !/^ADD-\d{3}$/.test(task.key)) {
    errors.push(`${label}: invalid key`);
  } else if (keys.has(task.key)) {
    errors.push(`${label}: duplicate key`);
  } else {
    keys.set(task.key, task);
  }

  if (typeof task?.id !== "string" || !uuid7Pattern.test(task.id)) {
    errors.push(`${label}: id is not UUIDv7`);
  } else if (ids.has(task.id)) {
    errors.push(`${label}: duplicate id`);
  } else {
    ids.set(task.id, task);
  }

  if (!statusValues.has(task?.status)) {
    errors.push(`${label}: invalid status ${JSON.stringify(task?.status)}`);
  }

  if (!priorityValues.has(task?.priority)) {
    errors.push(`${label}: invalid priority ${JSON.stringify(task?.priority)}`);
  }

  if (!Array.isArray(task?.depends_on)) {
    errors.push(`${label}: depends_on must be an array`);
  }

  if (!Array.isArray(task?.acceptance) || task.acceptance.length === 0) {
    errors.push(`${label}: acceptance must be a non-empty array`);
  }

  if (task?.status === "done") {
    if (!Array.isArray(task?.evidence) || task.evidence.length === 0) {
      errors.push(`${label}: done task requires evidence`);
    }
  }

  if (task?.status === "blocked" && !task?.blocker) {
    errors.push(`${label}: blocked task requires blocker`);
  }
}

for (const task of tasks) {
  for (const dependency of task.depends_on ?? []) {
    if (!keys.has(dependency)) {
      errors.push(`${task.key}: missing dependency ${dependency}`);
    }
  }
}

if (meta?.task_count !== undefined && meta.task_count !== tasks.length) {
  errors.push(
    `meta.task_count=${meta.task_count} but parsed ${tasks.length} tasks`,
  );
}

const nextCount = tasks.filter((task) => task.status === "next").length;
if (
  Number.isInteger(meta?.next_limit) &&
  nextCount > Number(meta.next_limit)
) {
  errors.push(
    `next task count ${nextCount} exceeds next_limit ${meta.next_limit}`,
  );
}

const visiting = new Set();
const visited = new Set();

function visit(key, trail = []) {
  if (visiting.has(key)) {
    errors.push(`dependency cycle: ${[...trail, key].join(" -> ")}`);
    return;
  }
  if (visited.has(key)) {
    return;
  }

  visiting.add(key);
  const task = keys.get(key);
  for (const dependency of task?.depends_on ?? []) {
    visit(dependency, [...trail, key]);
  }
  visiting.delete(key);
  visited.add(key);
}

for (const key of keys.keys()) {
  visit(key);
}

if (errors.length > 0) {
  console.error(`todos validation failed (${errors.length} errors)`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

const summary = Object.fromEntries(
  [...statusValues].map((status) => [
    status,
    tasks.filter((task) => task.status === status).length,
  ]),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      path,
      tasks: tasks.length,
      next: nextCount,
      by_status: summary,
    },
    null,
    2,
  ),
);
