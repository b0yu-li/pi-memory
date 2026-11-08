/**
 * Level 3 — recall eval (design.md "Testing & eval").
 *
 * Harness discipline (all probed, see test/probe.*.ts and e2e-cases.ts):
 * - Isolated loader: noExtensions + inline factory, so no other extension's
 *   tools (e.g. codemode ctx_execute) and no fs tools leak into sessions.
 * - Mode A is TRUE retrieval-only: every tool excluded, facts buried at the
 *   exact center of MEMORY.md (provably cut from the 4K middle-truncated
 *   core), so a correct answer can only come from the retrieval turn message.
 * - Mode B has memory tools only: the model must find facts via
 *   memory_search.
 * - Target entities are asserted absent from the extension source (tool
 *   descriptions leak example entries into the system prompt).
 * - One session per prompt, one project per run; the extension keeps
 *   module-global bindings, so sessions are never interleaved across
 *   projects.
 *
 * Run: npm run test:eval   (EVAL_RUNS for repeats, PI_E2E_MODEL to pin model)
 */
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import piMemory from "../index.ts";

const execFile = promisify(execFileCb);
const DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-4.5";

interface EvalCase {
	id: string;
	question: string;
	/** Entity that must appear in a correct answer; must not occur in index.ts source. */
	expect: string;
	entry: string;
	/** Content-word query expected to match the entry (diagnostic). */
	keywordQuery: string;
}

const CASES: EvalCase[] = [
	{
		id: "nl-queue",
		question: "What message queue did we choose for ingest? Answer with the product name only.",
		expect: "NATS",
		entry: "#decision [[queue-choice]] The ingest message queue is NATS JetStream with at-least-once delivery.",
		keywordQuery: "ingest message queue",
	},
	{
		id: "nl-runtime",
		question: "What JavaScript runtime must this repo use? Answer with the tool name only.",
		expect: "Bun",
		entry: "#preference [[js-runtime]] This repo runs on Bun, never Node, for all scripts and tests.",
		keywordQuery: "javascript runtime repo",
	},
	{
		id: "nl-retry-lesson",
		question: "What lesson did we record about retrying failed jobs? One short sentence.",
		expect: "jitter",
		entry: "#lesson [[retry-budgets]] Retries need capped attempts plus jitter to avoid thundering herds.",
		keywordQuery: "retries jitter",
	},
];

const FILLER_LINE = (i: number) => `#fact [[filler-${i}]] filler entry ${i} with alpha bravo charlie delta echo words for padding.`;

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

function makeProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-eval-"));
	fs.mkdirSync(path.join(root, ".git"));
	return root;
}

async function makeSession(cwd: string, excludeTools: string[]): Promise<Session> {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [piMemory as never],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		excludeTools: ["read", "bash", "edit", "write", ...excludeTools],
	});
	await session.bindExtensions({});
	return session;
}

const MEMORY_TOOLS = ["memory_write", "memory_read", "memory_forget", "memory_restore", "memory_search", "memory_status"];
const NO_TOOLS = [...MEMORY_TOOLS]; // plus fs tools always excluded in makeSession

async function runTool(
	session: Session,
	name: string,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const def: ToolDefinition | undefined = session.getToolDefinition(name);
	if (!def) throw new Error(`tool ${name} not registered`);
	const res = await def.execute(`eval-${name}`, params, undefined, undefined, {
		sessionManager: session.sessionManager,
	} as never);
	const text = (res.content as { type: string; text?: string }[])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
	return { text, details: (res as { details?: Record<string, unknown> }).details ?? {} };
}

function toolCallCount(session: Session): number {
	return session.messages.reduce((n, m) => {
		const content = (m as { content?: { type?: string; name?: string }[] }).content;
		return n + (Array.isArray(content) ? content.filter((c) => c.type === "toolCall").length : 0);
	}, 0);
}

function buryTargets(fillersPerHalf: number, targets: string[]): string {
	const half = Array.from({ length: fillersPerHalf }, (_, i) => FILLER_LINE(i)).join("\n\n");
	return `${half}\n\n${targets.join("\n\n")}\n\n${half}`;
}

async function ask(session: Session, prompt: string): Promise<string> {
	await session.prompt(prompt);
	return session.getLastAssistantText() ?? "";
}

async function availableModel(): Promise<string | null> {
	const wanted = process.env.PI_E2E_MODEL ?? DEFAULT_MODEL;
	const [provider, ...rest] = wanted.split("/");
	try {
		const rt = await ModelRuntime.create();
		const models = await rt.getAvailable();
		const hit = models.find((m) => m.provider === provider && m.id === rest.join("/")) ?? models[0];
		return hit ? `${hit.provider}/${hit.id}` : null;
	} catch {
		return null;
	}
}

async function main() {
	const extSource = fs.readFileSync(path.resolve("index.ts"), "utf-8");
	for (const c of CASES) {
		if (extSource.includes(c.expect)) {
			console.log(`eval: FAIL — target entity "${c.expect}" appears in extension source; corpus is not isolated`);
			process.exit(1);
		}
	}

	const model = await availableModel();
	if (!model) {
		console.log("eval: SKIP — no model available (auth not configured)");
		process.exit(0);
	}
	const runs = Math.max(1, Number(process.env.EVAL_RUNS ?? 1));
	console.log(`eval: model=${model} runs=${runs}`);

	const root = makeProject();
	let collection: string | null = null;
	try {
		// Seed: one session, tools available; write buried corpus; index it.
		const seed = await makeSession(root, []);
		const st = await runTool(seed, "memory_status", {});
		collection = (st.details as { collectionName?: string }).collectionName!;
		await runTool(seed, "memory_write", {
			target: "long_term",
			mode: "overwrite",
			content: buryTargets(40, CASES.map((c) => c.entry)),
		});
		seed.dispose();
		await execFile("qmd", ["update", "-c", collection], { timeout: 60_000 });

		// Diagnostics: raw-prompt vs content-word qmd hits per case.
		for (const c of CASES) {
			const raw = await execFile("qmd", ["search", "--json", "-c", collection, "-n", "3", c.question], { timeout: 30_000 }).then(
				(o) => JSON.parse(o.stdout).length,
				() => -1,
			);
			const kw = await execFile("qmd", ["search", "--json", "-c", collection, "-n", "3", c.keywordQuery], { timeout: 30_000 }).then(
				(o) => JSON.parse(o.stdout).length,
				() => -1,
			);
			console.log(`  diag [${c.id}] raw-prompt hits=${raw}  keyword hits=${kw}`);
		}

		const score = new Map<string, { aHit: number; bHit: number; aCalls: number; bCalls: number }>(
			CASES.map((c) => [c.id, { aHit: 0, bHit: 0, aCalls: 0, bCalls: 0 }]),
		);
		let bothMiss = 0;

		for (let run = 0; run < runs; run++) {
			for (const c of CASES) {
				// Mode A — TRUE retrieval-only: no tools at all.
				process.env.PI_MEMORY_RETRIEVE = "on";
				const sessionA = await makeSession(root, NO_TOOLS);
				const answerA = await ask(sessionA, c.question);
				const aHit = answerA.includes(c.expect);
				const aCalls = toolCallCount(sessionA);
				sessionA.dispose();

				// Mode B — retrieval off, memory tools only (fs tools are excluded
				// inside makeSession; pass [] so memory tools stay active).
				process.env.PI_MEMORY_RETRIEVE = "off";
				const sessionB = await makeSession(root, []);
				const answerB = await ask(sessionB, c.question);
				const bHit = answerB.includes(c.expect);
				const bCalls = toolCallCount(sessionB);
				sessionB.dispose();
				process.env.PI_MEMORY_RETRIEVE = "on";

				const s = score.get(c.id)!;
				s.aHit += aHit ? 1 : 0;
				s.bHit += bHit ? 1 : 0;
				s.aCalls += aCalls;
				s.bCalls += bCalls;
				if (!aHit && !bHit) bothMiss++;
				console.log(
					`  [${c.id}] A=${aHit ? "HIT" : "miss"} (calls:${aCalls})  B=${bHit ? "HIT" : "miss"} (calls:${bCalls})` +
						`  | A: ${JSON.stringify(answerA.slice(0, 50))} | B: ${JSON.stringify(answerB.slice(0, 50))}`,
				);
			}
		}

		console.log(`\nRecall (hit rate, runs=${runs}; retrieval-only A vs memory-tools-only B):`);
		console.log("case            A(hybrid)  B(core+tools)");
		for (const c of CASES) {
			const s = score.get(c.id)!;
			const a = (s.aHit / runs) * 100;
			const b = (s.bHit / runs) * 100;
			console.log(`${c.id.padEnd(15)} ${a.toFixed(0).padStart(5)}%  ${b.toFixed(0).padStart(9)}%`);
		}
		const totA = CASES.reduce((n, c) => n + score.get(c.id)!.aHit, 0);
		const totB = CASES.reduce((n, c) => n + score.get(c.id)!.bHit, 0);
		const total = CASES.length * runs;
		console.log(`\nTOTAL A: ${totA}/${total}  B: ${totB}/${total}`);
		if (bothMiss > 0) {
			console.log(`NOTE: ${bothMiss} case-runs missed in BOTH modes (keyword search does not match the raw NL prompt — probed conjunctive semantics).`);
		}
	} finally {
		if (collection) {
			try {
				await execFile("qmd", ["collection", "remove", collection], { timeout: 30_000 });
			} catch {
				/* best effort */
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
	process.exit(0);
}

await main();
