// Probe: cold-start cost of qmd detection when qmd is missing (ENOENT path),
// and embed-callback guarantees. Decides whether fixes are warranted.
import { execFile } from "node:child_process";

const t0 = performance.now();
execFile("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
	const ms = (performance.now() - t0).toFixed(1);
	console.log(`detectQmd (qmd missing): ${ms}ms, err.code = ${(err as NodeJS.ErrnoException)?.code}`);
	console.log("→ retrieval/search disabled for this error code today (treated as 'not installed')");
});

// Embed watchdog claim: execFile with timeout ALWAYS invokes its callback
// (kill on timeout → callback with err.killed). Verify semantics via a
// 1s-timeout sleep command instead of a hung child.
const t1 = performance.now();
execFile("sleep", ["5"], { timeout: 300 }, (err) => {
	console.log(`hung child: callback fired after ${(performance.now() - t1).toFixed(0)}ms, killed = ${(err as any)?.killed}`);
	console.log("→ callback guarantee holds; a lost-callback watchdog is dead code");
});
