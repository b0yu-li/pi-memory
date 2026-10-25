import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	_getBinding,
	bindProject,
	collectionNameForProject,
	forgetBlocks,
	parseScratchpad,
	resolveMemoryDir,
	resolveProjectRoot,
	scratchpadAdd,
	scratchpadToggle,
	_setPaths,
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

	it("scratchpad add/toggle", () => {
		let c = scratchpadAdd("", "fix auth", "<!-- 2026-01-01 10:00:00 [abcd] -->");
		assert.ok(c.includes("- [ ] fix auth"));
		const toggled = scratchpadToggle(c, "auth", true);
		assert.equal(toggled.matched, true);
		assert.ok(toggled.content.includes("- [x] fix auth"));
		const items = parseScratchpad(toggled.content);
		assert.equal(items.filter((i) => i.done).length, 1);
	});

	it("_setPaths for tests", () => {
		_setPaths("/tmp/x-project", "/tmp/x-mem");
		const b = _getBinding();
		assert.equal(b.projectRoot, path.resolve("/tmp/x-project"));
		assert.equal(b.memoryDir, path.resolve("/tmp/x-mem"));
	});
});
