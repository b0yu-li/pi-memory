/**
 * e2e case implementations. Each runs in its own child process — see the
 * driver header in test/e2e.ts for why (module-global extension state).
 */
import { execFile as execFileCb, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { collectionNameForProject } from "../index.ts";
import piMemoryDefault from "../index.ts";

const execFile = promisify(execFileCb);
const DEFAULT_MODEL = "openrouter/anthropic/claude-haiku-4.5";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
export type CaseOut = { status: "PASS" | "FAIL" | "SKIP"; note?: string };

function makeProject(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-e2e-"));
	fs.mkdirSync(path.join(root, ".git"));
	return root;
}

const ALL_TOOLS = ["read", "bash", "edit", "write", "memory_write", "memory_read", "memory_forget", "memory_restore", "memory_search", "memory_status"];

// Harness loader: no extension discovery at all (probed: other extensions
// inject tools like codemode's ctx_execute that defeat excludeTools), only
// our extension inline. Built-in fs tools are excluded via excludeTools.
async function makeSession(
	cwd: string,
	opts: { excludeTools?: string[] } = {},
): Promise<Session> {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: [piMemoryDefault as never],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		excludeTools: ["read", "bash", "edit", "write", ...(opts.excludeTools ?? [])],
	});
	await session.bindExtensions({});
	return session;
}

async function runTool(
	session: Session,
	name: string,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown>; isError?: boolean }> {
	const def: ToolDefinition | undefined = session.getToolDefinition(name);
	if (!def) throw new Error(`tool ${name} not registered`);
	const res = await def.execute(`e2e-${name}`, params, undefined, undefined, {
		sessionManager: session.sessionManager,
	} as never);
	const text = (res.content as { type: string; text?: string }[])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
	return { text, details: (res as { details?: Record<string, unknown> }).details ?? {}, isError: (res as { isError?: boolean }).isError === true };
}

async function qmdOk(): Promise<boolean> {
	try {
		await execFile("qmd", ["collection", "list"], { timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

async function qmdSync(collection: string): Promise<void> {
	await execFile("qmd", ["update", "-c", collection], { timeout: 60_000 });
}

function assert(cond: unknown, msg: string): void {
	if (!cond) throw new Error(msg);
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

async function ask(session: Session, prompt: string): Promise<string> {
	await session.prompt(prompt);
	return session.getLastAssistantText() ?? "";
}

async function seedMemoryFile(root: string, content: string): Promise<void> {
	const memDir = path.join(root, ".pi", "memory");
	fs.mkdirSync(memDir, { recursive: true });
	fs.writeFileSync(path.join(memDir, "MEMORY.md"), content, "utf-8");
}

type CaseFn = () => Promise<CaseOut>;

const cases: Record<string, CaseFn> = {
	// 1 — tools registered, no scratchpad
	"1": async () => {
		const root = makeProject();
		try {
			const session = await makeSession(root);
			const tools = session.getActiveToolNames();
			for (const t of ["memory_write", "memory_read", "memory_forget", "memory_restore", "memory_search", "memory_status"]) {
				assert(tools.includes(t), `missing tool ${t}`);
			}
			assert(!tools.some((t) => t.toLowerCase().includes("scratchpad")), "scratchpad must not exist");
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 2 — write/read round-trip under <project>/.pi/memory
	"2": async () => {
		const root = makeProject();
		try {
			const session = await makeSession(root);
			const w = await runTool(session, "memory_write", { target: "long_term", content: "#decision [[e2e-roundtrip]] the round trip token is POTAT0-9f3a" });
			assert(!w.isError, `write failed: ${w.text}`);
			const daily = await runTool(session, "memory_write", { target: "daily", content: "daily e2e note 42" });
			assert(!daily.isError, `daily write failed: ${daily.text}`);
			const r = await runTool(session, "memory_read", { target: "long_term" });
			assert(r.text.includes("POTAT0-9f3a"), `read back mismatch: ${r.text}`);
			const rd = await runTool(session, "memory_read", { target: "daily" });
			assert(rd.text.includes("daily e2e note 42"), `daily read mismatch: ${rd.text}`);
			assert(fs.existsSync(path.join(root, ".pi", "memory", "MEMORY.md")), "MEMORY.md must be under <project>/.pi/memory");
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 4 — forget → recovery ID → restore
	"4": async () => {
		const root = makeProject();
		try {
			const session = await makeSession(root);
			await runTool(session, "memory_write", { target: "long_term", content: "#decision [[keep-me]] keep this entry" });
			await runTool(session, "memory_write", { target: "long_term", content: "#preference [[drop-me]] delete this entry" });
			const fr = await runTool(session, "memory_forget", { match: "drop-me" });
			assert(!fr.isError, `forget failed: ${fr.text}`);
			const recoveryId = fr.details.recoveryId as string | undefined;
			assert(typeof recoveryId === "string" && recoveryId.length > 10, `no recovery id: ${fr.text}`);
			const afterForget = await runTool(session, "memory_read", { target: "long_term" });
			assert(!afterForget.text.includes("drop-me"), "entry not removed");
			assert(afterForget.text.includes("keep-me"), "unrelated entry must survive");
			const rs = await runTool(session, "memory_restore", { recovery_id: recoveryId! });
			assert(!rs.isError, `restore failed: ${rs.text}`);
			const afterRestore = await runTool(session, "memory_read", { target: "long_term" });
			assert(afterRestore.text.includes("drop-me"), "restored entry missing");
			const again = await runTool(session, "memory_restore", { recovery_id: recoveryId! });
			assert(again.text.includes("Already restored"), `double restore not guarded: ${again.text}`);
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 5 — memory_search graceful when qmd missing (real PATH simulation)
	"5": async () => {
		const root = makeProject();
		const prevPath = process.env.PATH ?? "";
		try {
			let qmdDir: string | null = null;
			try {
				qmdDir = path.dirname(execFileSync("which", ["qmd"]).toString().trim());
			} catch {
				/* qmd absent already */
			}
			if (qmdDir) process.env.PATH = prevPath.split(path.delimiter).filter((d) => d && d !== qmdDir).join(path.delimiter);
			const session = await makeSession(root);
			const s = await runTool(session, "memory_search", { query: "anything" });
			assert(s.isError, "expected error result");
			assert(s.text.includes("Install") && s.text.includes("qmd"), `not a graceful install hint: ${s.text}`);
			session.dispose();
			return { status: "PASS" };
		} finally {
			process.env.PATH = prevPath;
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 6 — memory_status reports project root, memory dir, collection
	"6": async () => {
		const root = makeProject();
		try {
			const session = await makeSession(root);
			const s = await runTool(session, "memory_status", {});
			assert(s.text.includes(`- Project root: ${root}`), "project root missing");
			assert(s.text.includes(path.join(root, ".pi", "memory")), "memory dir missing");
			assert(/pi-mem-[a-zA-Z0-9_-]+-[0-9a-f]{12}/.test(s.text), `collection name missing: ${s.text}`);
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 9 — tags and wiki-links via keyword search
	"9": async (): Promise<CaseOut> => {
		if (!(await qmdOk())) return { status: "SKIP", note: "qmd not on PATH" };
		const root = makeProject();
		try {
			const session = await makeSession(root);
			await runTool(session, "memory_write", {
				target: "long_term",
				content: "#decision [[database-choice]] Chose PostgreSQL for all backend services in e2e-tagproj.",
			});
			const st = await runTool(session, "memory_status", {});
			const collection = (st.details as { collectionName?: string }).collectionName!;
			await qmdSync(collection);
			const byTag = await runTool(session, "memory_search", { query: "#decision" });
			assert(!byTag.isError, `tag search error: ${byTag.text}`);
			assert(byTag.text.includes("PostgreSQL"), `tag search missed: ${byTag.text.slice(0, 200)}`);
			const bySlug = await runTool(session, "memory_search", { query: "database-choice" });
			assert(!bySlug.isError, `slug search error: ${bySlug.text}`);
			assert(bySlug.text.includes("PostgreSQL"), `slug search missed: ${bySlug.text.slice(0, 200)}`);
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 7 — memory_search hits for a known fact
	"7": async (): Promise<CaseOut> => {
		if (!(await qmdOk())) return { status: "SKIP", note: "qmd not on PATH" };
		const root = makeProject();
		try {
			const session = await makeSession(root);
			await runTool(session, "memory_write", {
				target: "long_term",
				content: "#fact [[e2e-fact-77b2]] The zephyr calibration constant for this project is 0.618.",
			});
			const st = await runTool(session, "memory_status", {});
			const collection = (st.details as { collectionName?: string }).collectionName!;
			await qmdSync(collection);
			const s = await runTool(session, "memory_search", { query: "zephyr calibration constant" });
			assert(!s.isError, `search error: ${s.text}`);
			assert(s.text.includes("0.618"), `expected hit with 0.618: ${s.text.slice(0, 200)}`);
			session.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 10 — cross-project isolation (A search must run before B rebinds)
	"10": async (): Promise<CaseOut> => {
		if (!(await qmdOk())) return { status: "SKIP", note: "qmd not on PATH" };
		const rootA = makeProject();
		const rootB = makeProject();
		try {
			const sessionA = await makeSession(rootA);
			await runTool(sessionA, "memory_write", {
				target: "long_term",
				content: "#fact [[isolated-token-5d1f]] Project A secret phrase: QUARTZ-LANTERN.",
			});
			const st = await runTool(sessionA, "memory_status", {});
			const collectionA = (st.details as { collectionName?: string }).collectionName!;
			await qmdSync(collectionA);
			// A's own collection finds it (query avoids echoing the secret token)
			const sa = await runTool(sessionA, "memory_search", { query: "project secret phrase" });
			assert(sa.text.includes("QUARTZ-LANTERN"), `project A should find its own entry: ${sa.text.slice(0, 200)}`);
			sessionA.dispose();

			const sessionB = await makeSession(rootB);
			const stB = await runTool(sessionB, "memory_status", {});
			const collectionB = (stB.details as { collectionName?: string }).collectionName!;
			assert(collectionB !== collectionA, "collections must differ per project");
			await qmdSync(collectionB);
			const s = await runTool(sessionB, "memory_search", { query: "project secret phrase" });
			assert(!s.text.includes("QUARTZ-LANTERN"), `cross-project bleed: ${s.text.slice(0, 200)}`);
			sessionB.dispose();
			return { status: "PASS" };
		} finally {
			fs.rmSync(rootA, { recursive: true, force: true });
			fs.rmSync(rootB, { recursive: true, force: true });
		}
	},

	// 3 — core injection: answer from injected MEMORY.md with zero tools
	"3": async (): Promise<CaseOut> => {
		const model = await availableModel();
		if (!model) return { status: "SKIP", note: "no model available" };
		const root = makeProject();
		try {
			await seedMemoryFile(root, "#fact [[launch-code]] The project launch code is 7391.\n");
			const session = await makeSession(root, { excludeTools: ALL_TOOLS });
			assert(session.getActiveToolNames().length === 0, "case 3 requires a genuinely tool-free session");
			const answer = await ask(session, "What is the project launch code? Reply with the code only.");
			assert(answer.includes("7391"), `model answer lacked the fact: ${answer.slice(0, 200)}`);
			session.dispose();
			return { status: "PASS", note: `model=${model}` };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},

	// 8 — hybrid turn retrieval: buried fact surfaces via turn message only
	"8": async (): Promise<CaseOut> => {
		if (!(await qmdOk())) return { status: "SKIP", note: "qmd not on PATH" };
		const model = await availableModel();
		if (!model) return { status: "SKIP", note: "no model available" };
		const root = makeProject();
		try {
			// Bury at the exact middle: the 4K core middle-truncates, so this
			// entry is provably absent from the system prompt.
			const half = Array.from({ length: 60 }, (_, i) => `#fact [[filler-${i}]] filler entry ${i} alpha bravo charlie delta echo.`).join("\n\n");
			const buried = "#fact [[buried-signal]] The buried retrieval signal word is TUNGSTEN-CRANE.";
			await seedMemoryFile(root, `${half}\n\n${buried}\n\n${half}\n`);
			const session = await makeSession(root, { excludeTools: ALL_TOOLS });
			assert(session.getActiveToolNames().length === 0, "case 8 requires a genuinely tool-free session");
			const collection = collectionNameForProject(root);
			await qmdSync(collection);
			// Keyword-style prompt: probed — qmd keyword search is conjunctive;
			// natural-language prompts with stopwords get zero hits, so the
			// retrieval-path guarantee is only claimed for content-word queries.
			const answer = await ask(session, "buried retrieval signal word");
			assert(answer.includes("TUNGSTEN-CRANE"), `retrieval failed to surface buried fact: ${answer.slice(0, 200)}`);
			session.dispose();
			return { status: "PASS", note: `model=${model}` };
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	},
};

export const CASE_NAMES = ["1", "2", "4", "5", "6", "9", "7", "10", "3", "8"];

export async function runSingleCase(name: string): Promise<CaseOut> {
	const fn = cases[name];
	if (!fn) return { status: "FAIL", note: `unknown case ${name}` };
	try {
		return await fn();
	} catch (e) {
		return { status: "FAIL", note: String(e).slice(0, 300) };
	}
}
