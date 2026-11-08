import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	_getBinding,
	_setPaths,
	bindProject,
	buildMemoryContext,
	buildPreview,
	collectionNameForProject,
	forgetBlocks,
	isRetrieveEnabled,
	resolveMemoryDir,
	resolveProjectRoot,
	sanitizeSearchPrompt,
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
