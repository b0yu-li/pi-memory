// Probe: writeFileSync on an existing store file under a file-size limit
// (models disk-full / SIGXFSZ). If the store file is left truncated/empty,
// the corruption window is proven.
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-crash-"));
const store = path.join(dir, "MEMORY.md");
fs.writeFileSync(store, "Decisions: A\nB\nC\nD\nE\n", "utf-8"); // existing memory

const script = path.join(dir, "probe.cjs");
fs.writeFileSync(
	script,
	`
const fs = require("fs");
const store = ${JSON.stringify(store)};
console.log("before write:", JSON.stringify(fs.readFileSync(store, "utf-8")));
try {
	fs.writeFileSync(store, "X".repeat(1024 * 1024), "utf-8");
	console.log("write ok");
} catch (e) {
	console.log("write failed:", e.code ?? e.message);
}
const after = fs.readFileSync(store, "utf-8");
console.log("after write length:", after.length, "head:", JSON.stringify(after.slice(0, 40)));
`,
	"utf-8",
);

try {
	console.log(execSync(`ulimit -f 1; node ${JSON.stringify(script)}`, { shell: "/bin/bash", encoding: "utf8" }));
} catch (e: any) {
	console.log((e.stdout ?? "") + (e.stderr ?? "").split("\n").slice(-4).join("\n"));
}
fs.rmSync(dir, { recursive: true, force: true });
