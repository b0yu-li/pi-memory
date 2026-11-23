import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	_clearQmdStatusCaches,
	_getBinding,
	_setExecFileForTest,
	_resetExecFileForTest,
	_setPaths,
	archiveAgingDailyLogs,
	bindProject,
	buildMemoryContext,
	buildPreview,
	collectionListIncludes,
	collectionNameForProject,
	deriveQueryCandidates,
	detectQmd,
	ensureDirs,
	extractDeduplicationKey,
	forgetBlocks,
	getMemoryInventory,
	isRetrieveEnabled,
	knowledgePath,
	parseMemoryEntries,
	previewMemoryContent,
	readTelemetry,
	recordCompactionTelemetry,
	recordRetrievalTelemetry,
	recordSearchTelemetry,
	resolveMemoryDir,
	resolveProjectRoot,
	runAutonomousCompaction,
	sanitizeSearchPrompt,
	sanitizeTopicName,
	shouldCompactMemory,
	telemetryPath,
	writeFileAtomic,
} from "../index.ts";

describe("project binding", () => {
	it("resolveProjectRoot walks to .git", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-"));
		const nested = path.join(root, "apps", "web");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(root, ".git"));
		assert.equal(resolveProjectRoot(nested), root);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("resolveMemoryDir defaults to .pi/memory under project", () => {
		const empty = {} as NodeJS.ProcessEnv;
		assert.equal(resolveMemoryDir("/tmp/myproj", empty), path.join("/tmp/myproj", ".pi", "memory"));
		assert.equal(
			resolveMemoryDir("/tmp/myproj", { PI_MEMORY_DIR: "/custom/mem" } as NodeJS.ProcessEnv),
			path.resolve("/custom/mem"),
		);
	});

	it("collectionNameForProject is stable and project-specific", () => {
		const a = collectionNameForProject("/tmp/proj-a");
		const b = collectionNameForProject("/tmp/proj-b");
		assert.notEqual(a, b);
		assert.match(a, /^pi-mem-/);
		const hash = createHash("sha256").update(path.resolve("/tmp/proj-a")).digest("hex").slice(0, 12);
		assert.ok(a.includes(hash));
	});

	it("bindProject updates paths away from global home memory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-"));
		fs.mkdirSync(path.join(root, ".git"));
		const nested = path.join(root, "src");
		fs.mkdirSync(nested);
		const prev = process.env.PI_MEMORY_DIR;
		delete process.env.PI_MEMORY_DIR;
		try {
			const bound = bindProject(nested);
			assert.equal(bound.projectRoot, root);
			assert.equal(bound.memoryDir, path.join(root, ".pi", "memory"));
			assert.ok(!bound.memoryDir.includes(path.join(".pi", "agent", "memory")));
			const b = _getBinding();
			assert.equal(b.memoryFile, path.join(root, ".pi", "memory", "MEMORY.md"));
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_DIR;
			else process.env.PI_MEMORY_DIR = prev;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("store helpers", () => {
	it("forgetBlocks removes stamped entries by substring", () => {
		const content = [
			"<!-- 2026-01-01 10:00:00 [abcd1234] -->",
			"#preference Always use pnpm",
			"",
			"<!-- 2026-01-02 10:00:00 [abcd1234] -->",
			"#decision Chose postgres",
			"",
		].join("\n");
		const { content: next, removed } = forgetBlocks(content, "pnpm");
		assert.equal(removed.length, 1);
		assert.ok(removed[0].includes("pnpm"));
		assert.ok(next.includes("postgres"));
		assert.ok(!next.includes("pnpm"));
	});

	it("tagged entries survive forget of unrelated match", () => {
		const content = [
			"<!-- 2026-01-01 10:00:00 [abcd1234] -->",
			"#decision [[database-choice]] Chose PostgreSQL",
			"",
		].join("\n");
		const { content: next, removed } = forgetBlocks(content, "mysql");
		assert.equal(removed.length, 0);
		assert.ok(next.includes("#decision [[database-choice]]"));
	});

	it("forgetBlocks does not delete unstamped text after a stamped entry", () => {
		const content = [
			"<!-- 2026-01-01 10:00:00 [abcd1234] -->",
			"#preference Always use pnpm",
			"",
			"Unstamped scratch note that must survive.",
			"",
			"<!-- 2026-01-02 10:00:00 [abcd1234] -->",
			"#decision Chose postgres",
			"",
		].join("\n");
		const { content: next, removed } = forgetBlocks(content, "pnpm");
		assert.equal(removed.length, 1);
		assert.ok(next.includes("Unstamped scratch note that must survive."));
		assert.ok(next.includes("postgres"));
		assert.ok(!next.includes("pnpm"));
	});

	it("ensureDirs migrates legacy recovery/ to .recovery/ (not qmd-indexed)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-rec-"));
		const mem = path.join(root, ".pi", "memory");
		fs.mkdirSync(path.join(mem, "recovery"), { recursive: true });
		fs.writeFileSync(
			path.join(mem, "recovery", "11111111-2222-4333-8444-555555555555.json"),
			"{}",
			"utf-8",
		);
		_setPaths(root, mem);
		ensureDirs();
		const b = _getBinding();
		assert.equal(b.recoveryDir, path.join(mem, ".recovery"));
		assert.ok(fs.existsSync(path.join(mem, ".recovery", "11111111-2222-4333-8444-555555555555.json")));
		assert.ok(!fs.existsSync(path.join(mem, "recovery")));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("_setPaths for tests", () => {
		_setPaths("/tmp/x-project", "/tmp/x-mem");
		const b = _getBinding();
		assert.equal(b.projectRoot, path.resolve("/tmp/x-project"));
		assert.equal(b.memoryDir, path.resolve("/tmp/x-mem"));
	});
});

describe("injection helpers", () => {
	it("sanitizeSearchPrompt strips controls and caps length", () => {
		assert.equal(sanitizeSearchPrompt("  hello\x00world  "), "hello world");
		assert.equal(sanitizeSearchPrompt("x".repeat(300)).length, 200);
	});

	it("isRetrieveEnabled defaults on", () => {
		const prev = process.env.PI_MEMORY_RETRIEVE;
		delete process.env.PI_MEMORY_RETRIEVE;
		try {
			assert.equal(isRetrieveEnabled(), true);
			process.env.PI_MEMORY_RETRIEVE = "off";
			assert.equal(isRetrieveEnabled(), false);
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_RETRIEVE;
			else process.env.PI_MEMORY_RETRIEVE = prev;
		}
	});

	it("buildMemoryContext uses today + MEMORY only (no scratchpad)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-ctx-"));
		const mem = path.join(root, ".pi", "memory");
		fs.mkdirSync(path.join(mem, "daily"), { recursive: true });
		_setPaths(root, mem);
		fs.writeFileSync(path.join(mem, "MEMORY.md"), "#decision [[x]] fact one\n", "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(ctx.includes("MEMORY.md"));
		assert.ok(ctx.includes("fact one"));
		assert.ok(!ctx.toLowerCase().includes("scratchpad"));
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("surrogate-safe truncation (no garbled CJK/emoji)", () => {
	const hasLoneSurrogate = (s: string): boolean => {
		for (let i = 0; i < s.length; i++) {
			const c = s.charCodeAt(i);
			const hi = c >= 0xd800 && c <= 0xdbff;
			const lo = c >= 0xdc00 && c <= 0xdfff;
			if (hi && !(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return true;
			if (lo && !(i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return true;
		}
		return false;
	};

	it("start mode never splits a surrogate pair (odd boundary)", () => {
		const text = "a" + "🧠".repeat(3000);
		const r = buildPreview(text, { maxLines: Number.POSITIVE_INFINITY, maxChars: 4000, mode: "start" });
		assert.ok(!hasLoneSurrogate(r.preview), "lone surrogate in start-mode preview");
	});

	it("end mode never splits a surrogate pair", () => {
		const text = "ab" + "🧠".repeat(3000);
		const r = buildPreview(text, { maxLines: Number.POSITIVE_INFINITY, maxChars: 4000, mode: "end" });
		assert.ok(!hasLoneSurrogate(r.preview), "lone surrogate in end-mode preview");
	});

	it("middle mode never splits a surrogate pair", () => {
		const text = "a" + "🧠".repeat(3000);
		const r = buildPreview(text, { maxLines: 150, maxChars: 4000, mode: "middle" });
		assert.ok(!hasLoneSurrogate(r.preview), "lone surrogate in middle-mode preview");
	});

	it("middle mode keeps whole CJK characters", () => {
		const text = "记忆点".repeat(2000);
		const r = buildPreview(text, { maxLines: 150, maxChars: 4000, mode: "middle" });
		assert.ok(r.preview.includes("... (truncated) ..."));
		assert.ok(!hasLoneSurrogate(r.preview));
	});

	it("sanitizeSearchPrompt never ends inside a surrogate pair", () => {
		const prompt = "🧠".repeat(150); // 300 UTF-16 units > 200 cap
		const s = sanitizeSearchPrompt(prompt);
		assert.equal(s.length <= 200, true);
		assert.ok(!hasLoneSurrogate(s), "lone surrogate at sanitize cut");
	});
});

const hasLoneSurrogateIn = (s: string): boolean => {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const hi = c >= 0xd800 && c <= 0xdbff;
		const lo = c >= 0xdc00 && c <= 0xdfff;
		if (hi && !(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff)) return true;
		if (lo && !(i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff)) return true;
	}
	return false;
};

describe("store durability (proven probes)", () => {
	it("writeFileAtomic leaves the original intact when the write fails (EFBIG)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-atomic-"));
		const store = path.join(root, "MEMORY.md");
		const original = "Decisions: A\nB\nC\nD\nE\n";
		fs.writeFileSync(store, original, "utf-8");

		const child = path.join(root, "atomic-child.mjs");
		fs.writeFileSync(
			child,
			[
				`import { writeFileAtomic } from "${path.resolve("index.ts")}";`,
				`import fs from "node:fs";`,
				`try { writeFileAtomic(${JSON.stringify(store)}, "X".repeat(1024 * 1024)); console.log("ok"); }`,
				`catch (e) { console.log("failed:", e.code); }`,
				`console.log("intact:", fs.readFileSync(${JSON.stringify(store)}, "utf-8") === ${JSON.stringify(original)});`,
				`console.log("tmp leftovers:", fs.readdirSync(${JSON.stringify(root)}).filter((f) => f.includes(".tmp-")).length);`,
			].join("\n"),
			"utf-8",
		);
		const { execFileSync } = await import("node:child_process");
		let out = "";
		try {
			out = execFileSync("/bin/bash", ["-c", `ulimit -f 1; node ${JSON.stringify(child)}`], { encoding: "utf8" });
		} catch (e: any) {
			out = String(e.stdout ?? "");
		}
		assert.ok(out.includes("failed: EFBIG"), `expected EFBIG, got: ${out}`);
		assert.ok(out.includes("intact: true"), `store must survive: ${out}`);
		assert.ok(out.includes("tmp leftovers: 0"), `no tmp files may remain: ${out}`);
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("previewMemoryContent passes small content through untouched", () => {
		const content = "#decision [[x]] keep this exact line\n";
		const r = previewMemoryContent(content);
		assert.equal(r.text, content.trim());
		assert.equal(r.truncated, false);
	});

	it("previewMemoryContent caps large content instead of flooding context", () => {
		const big = Array.from({ length: 5000 }, (_, i) => `entry line ${i} with some text`).join("\n");
		const r = previewMemoryContent(big);
		assert.equal(r.truncated, true);
		assert.ok(r.text.length <= 24_000 + 200, `capped text was ${r.text.length}`);
		assert.ok(r.text.includes("[truncated:"));
		assert.ok(!hasLoneSurrogateIn(r.text));
	});
});

describe("qmd detection diagnostics (proven: EACCES mislabeled as 'not installed')", () => {
	it("non-ENOENT spawn errors mean qmd exists (present but failing)", async () => {
		_clearQmdStatusCaches();
		_setExecFileForTest(((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
			const err = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
			cb(err, "", "");
		}) as never);
		try {
			assert.equal(await detectQmd(), true, "qmd present but failing must not read as 'not installed'");
		} finally {
			_resetExecFileForTest();
			_clearQmdStatusCaches();
		}
	});

	it("ENOENT still means qmd is not installed", async () => {
		_clearQmdStatusCaches();
		_setExecFileForTest(((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
			const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
			cb(err, "", "");
		}) as never);
		try {
			assert.equal(await detectQmd(), false);
		} finally {
			_resetExecFileForTest();
			_clearQmdStatusCaches();
		}
	});
});

describe("collectionListIncludes (extracted from checkCollection, fallback dedup)", () => {
	it("matches string entries", () => {
		assert.equal(collectionListIncludes("pi-mem-x-abc", JSON.stringify(["pi-mem-x-abc", "other"])), true);
		assert.equal(collectionListIncludes("pi-mem-x-abc", JSON.stringify(["other"])), false);
	});

	it("matches object entries by name", () => {
		assert.equal(
			collectionListIncludes("pi-mem-x-abc", JSON.stringify([{ name: "pi-mem-x-abc" }, { name: "o" }])),
			true,
		);
		assert.equal(collectionListIncludes("pi-mem-x-abc", JSON.stringify([{ name: "o" }])), false);
		assert.equal(collectionListIncludes("pi-mem-x-abc", JSON.stringify([null, 5])), false);
	});

	it("falls back to substring match for non-array JSON and broken output", () => {
		assert.equal(collectionListIncludes("pi-mem-x-abc", JSON.stringify({ name: "pi-mem-x-abc" })), true);
		assert.equal(collectionListIncludes("pi-mem-x-abc", "name: pi-mem-x-abc\nstatus: ok"), true);
		assert.equal(collectionListIncludes("pi-mem-x-abc", "{broken json"), false);
	});
});

describe("deriveQueryCandidates (conjunctive BM25 fix)", () => {
	it("starts with the raw prompt and falls back to content words", () => {
		const c = deriveQueryCandidates("What database did we choose for backend services?");
		assert.equal(c[0], "What database did we choose for backend services?");
		assert.ok(c[1].includes("database"));
		assert.ok(!c[1].split(" ").some((t) => ["what", "did", "we", "for"].includes(t)), `stopwords must be stripped: ${c[1]}`);
	});

	it("produces adjacent pairs and long tokens as later candidates", () => {
		const c = deriveQueryCandidates("Should the retry budget use jitter always");
		const pairs = c.filter((x) => x.split(" ").length === 2);
		assert.ok(pairs.includes("retry budget"), `pairs missing: ${JSON.stringify(c)}`);
		assert.ok(c.includes("jitter"));
	});

	it("is deduplicated and bounded", () => {
		const c = deriveQueryCandidates("jitter jitter jitter what what");
		const set = new Set(c.map((x) => x.toLowerCase()));
		assert.equal(c.length, set.size);
		assert.ok(c.length <= 8);
	});

	it("filters conversational inquiry terms and prevents conversational pair leaks", () => {
		const c = deriveQueryCandidates("I want to know how the memory extension performs with naive question");
		// Ensure conversational verbs and inquiry markers are not in content words
		const contentWords = c[1] ? c[1].split(" ") : [];
		assert.ok(!contentWords.includes("want"), "should strip 'want'");
		assert.ok(!contentWords.includes("know"), "should strip 'know'");
		assert.ok(!contentWords.includes("question"), "should strip 'question'");
		assert.ok(!contentWords.includes("naive"), "should strip 'naive'");
		assert.ok(!c.some((x) => x === "want know"), "must not produce 'want know' pair");
	});
});

describe("knowledge and archive topology", () => {
	it("sanitizes topic names cleanly", () => {
		assert.equal(sanitizeTopicName("Architecture & Design!"), "architecture-design");
		assert.equal(sanitizeTopicName("Billing_Ledger"), "billing_ledger");
		assert.equal(sanitizeTopicName(""), "general");
	});

	it("creates knowledge and archive directories in ensureDirs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-top-"));
		_setPaths(root);
		ensureDirs();
		const binding = _getBinding();
		assert.ok(fs.existsSync(binding.knowledgeDir));
		assert.ok(fs.existsSync(binding.archiveDir));
		assert.ok(fs.existsSync(binding.archiveDailyDir));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("reports knowledge and archived files in getMemoryInventory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-inv-"));
		_setPaths(root);
		ensureDirs();
		const binding = _getBinding();
		fs.writeFileSync(path.join(binding.knowledgeDir, "billing.md"), "# Billing Dossier\n");
		fs.writeFileSync(path.join(binding.archiveDailyDir, "2026-01-01.md"), "# Old Log\n");

		const inv = getMemoryInventory();
		assert.equal(inv.knowledgeCount, 1);
		assert.deepEqual(inv.knowledgeFiles, ["billing.md"]);
		assert.equal(inv.archivedDailyCount, 1);
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("autonomous compaction engine", () => {
	it("extracts deduplication keys from markdown blocks", () => {
		assert.equal(extractDeduplicationKey("#decision [[database-choice]] PostgreSQL"), "database-choice");
		assert.equal(extractDeduplicationKey("#preference [[package-manager]] pnpm"), "package-manager");
		assert.equal(extractDeduplicationKey("## Contact Details: Xiaoyu"), "contact details: xiaoyu");
		assert.equal(extractDeduplicationKey("Regular plain text without tags or headers"), null);
	});

	it("evaluates shouldCompactMemory thresholds correctly", () => {
		assert.equal(shouldCompactMemory(""), false);
		assert.equal(shouldCompactMemory("Short note\n"), false);
		const lines600 = Array.from({ length: 600 }, (_, i) => `Line ${i}`).join("\n");
		assert.equal(shouldCompactMemory(lines600), true);
		const chars25000 = "a".repeat(25_000);
		assert.equal(shouldCompactMemory(chars25000), true);
	});

	it("archives aging daily logs older than threshold", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-age-"));
		_setPaths(root);
		ensureDirs();
		const binding = _getBinding();

		// Write a recent log (today) and an old log (20 days ago)
		const today = new Date().toISOString().slice(0, 10);
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 20);
		const oldDateStr = oldDate.toISOString().slice(0, 10);

		fs.writeFileSync(path.join(binding.dailyDir, `${today}.md`), "# Today's log\n");
		fs.writeFileSync(path.join(binding.dailyDir, `${oldDateStr}.md`), "# Old log\n");

		const moved = archiveAgingDailyLogs(14);
		assert.ok(moved.includes(`${oldDateStr}.md`));
		assert.ok(!moved.includes(`${today}.md`));

		assert.ok(fs.existsSync(path.join(binding.archiveDailyDir, `${oldDateStr}.md`)));
		assert.ok(fs.existsSync(path.join(binding.dailyDir, `${today}.md`)));
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("deduplicates superseded invariants and creates recovery record", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-compact-"));
		_setPaths(root);
		ensureDirs();
		const binding = _getBinding();

		// Create a large MEMORY.md (> 500 lines) with duplicate keys
		const entry1 = "<!-- 2026-10-01 10:00:00 [00000001] -->\n#decision [[database-choice]] Chose MySQL for alpha.\n";
		const filler = Array.from({ length: 550 }, (_, i) => `<!-- 2026-10-02 10:00:00 [00000002] -->\n#fact [[fact-${i}]] Detail ${i}\n`).join("\n");
		const entry2 = "<!-- 2026-11-20 10:00:00 [00000003] -->\n#decision [[database-choice]] Migrated to PostgreSQL for prod.\n";

		fs.writeFileSync(binding.memoryFile, `${entry1}\n\n${filler}\n\n${entry2}`);

		const result = await runAutonomousCompaction("test");
		assert.equal(result.triggered, true);
		assert.ok(result.supersededCount >= 1);
		assert.ok(result.recoveryId);

		const updatedMemory = fs.readFileSync(binding.memoryFile, "utf-8");
		// Entry 2 (latest) must be retained
		assert.ok(updatedMemory.includes("Migrated to PostgreSQL"));
		// Entry 1 (superseded) must be purged from MEMORY.md
		assert.ok(!updatedMemory.includes("Chose MySQL for alpha"));

		// Archived superseded file must contain the old entry
		const archived = fs.readFileSync(binding.archiveSupersededFile, "utf-8");
		assert.ok(archived.includes("Chose MySQL for alpha"));

		// Recovery snapshot must exist
		const recPath = path.join(binding.recoveryDir, `${result.recoveryId}.json`);
		assert.ok(fs.existsSync(recPath));

		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("telemetry and metrics ledger", () => {
	it("records and updates retrieval telemetry correctly", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-tel-"));
		_setPaths(root);
		ensureDirs();

		recordRetrievalTelemetry({
			promptSnippet: "what database do we use",
			winnerCandidate: "database",
			hits: 2,
			durationMs: 85,
		});

		recordRetrievalTelemetry({
			promptSnippet: "unknown query",
			winnerCandidate: null,
			hits: 0,
			durationMs: 110,
		});

		const state = readTelemetry();
		assert.equal(state.retrievalStats.totalTurns, 2);
		assert.equal(state.retrievalStats.hits, 1);
		assert.equal(state.retrievalStats.misses, 1);
		assert.equal(state.retrievalStats.avgDurationMs, Math.round((85 + 110) / 2));
		assert.equal(state.retrievalStats.recentSearches.length, 2);

		fs.rmSync(root, { recursive: true, force: true });
	});

	it("records compaction and search telemetry cleanly", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-tel2-"));
		_setPaths(root);
		ensureDirs();

		recordCompactionTelemetry({
			reason: "lifecycle",
			durationMs: 15,
			beforeChars: 50_000,
			afterChars: 18_000,
			supersededCount: 5,
			archivedDailiesCount: 3,
			knowledgeCreatedCount: 2,
		});

		recordSearchTelemetry({
			mode: "keyword",
			querySnippet: "database-choice",
			hits: 1,
			durationMs: 45,
		});

		const state = readTelemetry();
		assert.equal(state.compactionHistory.length, 1);
		assert.equal(state.compactionHistory[0].supersededCount, 5);
		assert.equal(state.searchStats.totalSearches, 1);
		assert.equal(state.searchStats.byMode.keyword, 1);

		fs.rmSync(root, { recursive: true, force: true });
	});
});
