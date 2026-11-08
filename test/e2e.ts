/**
 * Level 2 e2e — real pi session with the pi-memory extension loaded.
 * See design.md "Testing & eval".
 *
 * Driver/child structure: each case runs in its OWN child process
 * (`node test/e2e.ts --case=<name>`), because probed facts:
 * - the extension keeps module-global bindings; a second session's
 *   session_start rebinds paths and silently redirects the first
 *   session's tool calls (broke cross-project isolation in-process)
 * - the pi resource loader loads index.ts as a separate module instance,
 *   so in-process test hooks do not reach the extension under test
 * - other auto-discovered extensions (codemode's ctx_execute) defeat
 *   excludeTools — the harness loader therefore uses noExtensions and
 *   loads only our extension inline
 *
 * Tool cases run keyless by invoking tool handlers directly. Case 3 (core
 * injection) and case 8 (hybrid turn retrieval) need a model; skipped when
 * none is available. Model pinned via PI_E2E_MODEL (default: cheap haiku).
 *
 * Run: npm run test:e2e
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const CASE_SCRIPT = path.resolve("test/e2e.ts");

interface CaseOut {
	status: "PASS" | "FAIL" | "SKIP";
	note?: string;
}

async function main() {
	const caseArg = process.argv.find((a) => a.startsWith("--case="));
	if (caseArg) {
		const { runSingleCase } = await import("./e2e-cases.ts");
		const name = caseArg.slice("--case=".length);
		const out = await runSingleCase(name);
		console.log(`RESULT ${name} ${out.status}${out.note ? ` ${out.note}` : ""}`);
		process.exit(0);
	}

	const { CASE_NAMES } = await import("./e2e-cases.ts");
	const results: { name: string; status: string; note?: string }[] = [];
	for (const name of CASE_NAMES) {
		const res = spawnSync(process.execPath, ["--experimental-strip-types", CASE_SCRIPT, `--case=${name}`], {
			encoding: "utf8",
			timeout: 300_000,
		});
		const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
		if (!line) {
			const errTail = (res.stderr ?? "").split("\n").slice(-3).join(" | ").slice(0, 300);
			results.push({ name, status: "FAIL", note: `no result (exit ${res.status ?? "?"}) ${errTail}` });
			console.log(`✖ ${name} — crashed: ${errTail}`);
			continue;
		}
		const [, , status, ...noteParts] = line.split(" ");
		const note = noteParts.join(" ");
		results.push({ name, status, note });
		console.log(`${status === "PASS" ? "✔" : status === "SKIP" ? "↷" : "✖"} ${name}${note ? ` — ${note}` : ""}`);
	}
	const failed = results.filter((r) => r.status === "FAIL");
	console.log(`\ne2e: ${results.filter((r) => r.status === "PASS").length} pass, ${results.filter((r) => r.status === "SKIP").length} skip, ${failed.length} fail`);
	if (failed.length > 0) process.exit(1);
	process.exit(0);
}

await main();
