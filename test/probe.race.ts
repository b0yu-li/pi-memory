// Probe A v2: true interleaving — A reads, B reads, B writes, A writes.
// With two processes on the same project this schedule is common (both
// sessions start a write "at the same time" around a user turn).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-race-"));
const file = path.join(dir, "2026-11-08.md");

// Current memory_write implementation shape
const writeCurrent = (id: string) => {
	const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
	fs.writeFileSync(file, existing + (existing.trim() ? "\n\n" : "") + `<!-- [${id}] -->\n${id}-entry`, "utf-8");
};
// O_APPEND shape
const writeAppend = (id: string) => {
	fs.appendFileSync(file, `<!-- [${id}] -->\n${id}-entry\n`, "utf-8");
};

const interleaved = (write: (id: string) => void) => {
	fs.writeFileSync(file, "", "utf-8");
	const a = () => fs.readFileSync(file, "utf-8"); // A: read phase
	const b = () => fs.readFileSync(file, "utf-8"); // B: read phase
	a();
	b();
	write("B"); // B commits first
	write("A"); // A commits with its stale snapshot
	return (fs.readFileSync(file, "utf-8").match(/-->/g)?.length ?? 0);
};

console.log("read-modify-write, interleaved schedule → entries in file:", interleaved(writeCurrent), "(expected 2)");
console.log("appendFileSync,   interleaved schedule → entries in file:", interleaved(writeAppend), "(expected 2)");

fs.rmSync(dir, { recursive: true, force: true });
