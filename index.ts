/**
 * PoC: project-scoped memory for pi.
 * Storage: <projectRoot>/.pi/memory/
 * Injection: stable system core (today + MEMORY) + turn-message qmd retrieval
 * No scratchpad. Tags/links are content conventions (#tag, [[wiki-link]]).
 * See design.md.
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Job 1 — Project binding
// ---------------------------------------------------------------------------

type MemoryEnv = NodeJS.ProcessEnv;

/** Walk up from cwd until a .git directory (or file) is found; else return cwd. */
export function resolveProjectRoot(cwd: string, env: MemoryEnv = process.env): string {
	const override = env.PI_MEMORY_PROJECT_ROOT?.trim();
	if (override) return path.resolve(override);

	let dir = path.resolve(cwd);
	for (;;) {
		const gitPath = path.join(dir, ".git");
		try {
			if (fs.existsSync(gitPath)) return dir;
		} catch {
			/* ignore */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(cwd);
}

export function resolveMemoryDir(projectRoot: string, env: MemoryEnv = process.env): string {
	const override = env.PI_MEMORY_DIR?.trim();
	if (override) return path.resolve(override);
	return path.join(projectRoot, ".pi", "memory");
}

/** Stable, collision-resistant qmd collection name for a project root. */
export function collectionNameForProject(projectRoot: string): string {
	const abs = path.resolve(projectRoot);
	const hash = createHash("sha256").update(abs).digest("hex").slice(0, 12);
	const base = path.basename(abs).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 24) || "project";
	return `pi-mem-${base}-${hash}`;
}

let PROJECT_ROOT = resolveProjectRoot(process.cwd());
let MEMORY_DIR = resolveMemoryDir(PROJECT_ROOT);
let COLLECTION_NAME = collectionNameForProject(PROJECT_ROOT);
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let KNOWLEDGE_DIR = path.join(MEMORY_DIR, "knowledge");
let ARCHIVE_DIR = path.join(MEMORY_DIR, "archive");
let ARCHIVE_DAILY_DIR = path.join(ARCHIVE_DIR, "daily");
let ARCHIVE_SUPERSEDED_FILE = path.join(ARCHIVE_DIR, "superseded.md");
let RECOVERY_DIR = path.join(MEMORY_DIR, ".recovery");

export function bindProject(
	cwd: string,
	env: MemoryEnv = process.env,
): { projectRoot: string; memoryDir: string; collectionName: string } {
	PROJECT_ROOT = resolveProjectRoot(cwd, env);
	MEMORY_DIR = resolveMemoryDir(PROJECT_ROOT, env);
	COLLECTION_NAME = collectionNameForProject(PROJECT_ROOT);
	MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
	DAILY_DIR = path.join(MEMORY_DIR, "daily");
	KNOWLEDGE_DIR = path.join(MEMORY_DIR, "knowledge");
	ARCHIVE_DIR = path.join(MEMORY_DIR, "archive");
	ARCHIVE_DAILY_DIR = path.join(ARCHIVE_DIR, "daily");
	ARCHIVE_SUPERSEDED_FILE = path.join(ARCHIVE_DIR, "superseded.md");
	RECOVERY_DIR = path.join(MEMORY_DIR, ".recovery");
	return { projectRoot: PROJECT_ROOT, memoryDir: MEMORY_DIR, collectionName: COLLECTION_NAME };
}

/** Test helper — force paths. */
export function _setPaths(projectRoot: string, memoryDir?: string) {
	PROJECT_ROOT = path.resolve(projectRoot);
	MEMORY_DIR = memoryDir ? path.resolve(memoryDir) : path.join(PROJECT_ROOT, ".pi", "memory");
	COLLECTION_NAME = collectionNameForProject(PROJECT_ROOT);
	MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
	DAILY_DIR = path.join(MEMORY_DIR, "daily");
	KNOWLEDGE_DIR = path.join(MEMORY_DIR, "knowledge");
	ARCHIVE_DIR = path.join(MEMORY_DIR, "archive");
	ARCHIVE_DAILY_DIR = path.join(ARCHIVE_DIR, "daily");
	ARCHIVE_SUPERSEDED_FILE = path.join(ARCHIVE_DIR, "superseded.md");
	RECOVERY_DIR = path.join(MEMORY_DIR, ".recovery");
}

export function _getBinding() {
	return {
		projectRoot: PROJECT_ROOT,
		memoryDir: MEMORY_DIR,
		collectionName: COLLECTION_NAME,
		memoryFile: MEMORY_FILE,
		dailyDir: DAILY_DIR,
		knowledgeDir: KNOWLEDGE_DIR,
		archiveDir: ARCHIVE_DIR,
		archiveDailyDir: ARCHIVE_DAILY_DIR,
		archiveSupersededFile: ARCHIVE_SUPERSEDED_FILE,
		recoveryDir: RECOVERY_DIR,
	};
}

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
	fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
	fs.mkdirSync(ARCHIVE_DAILY_DIR, { recursive: true });
	// Recovery records live in a dot-directory so qmd does not index deleted
	// (forgotten) content back into search results. Migrate the legacy layout.
	const legacyRecovery = path.join(MEMORY_DIR, "recovery");
	try {
		if (fs.existsSync(legacyRecovery)) {
			fs.mkdirSync(RECOVERY_DIR, { recursive: true });
			for (const file of fs.readdirSync(legacyRecovery)) {
				fs.renameSync(path.join(legacyRecovery, file), path.join(RECOVERY_DIR, file));
			}
			fs.rmdirSync(legacyRecovery);
		}
	} catch {
		/* keep legacy dir if migration fails */
	}
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
}

export function sanitizeTopicName(raw: string): string {
	return (
		raw
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "general"
	);
}

export function knowledgePath(topic: string): string {
	const clean = sanitizeTopicName(topic);
	return path.join(KNOWLEDGE_DIR, `${clean}.md`);
}

function dailyPath(date: string): string {
	return path.join(DAILY_DIR, `${date}.md`);
}

function isValidDailyDate(d: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(d);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function localDateStr(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr(): string {
	return localDateStr(new Date());
}

export function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return localDateStr(d);
}

export function nowTimestamp(): string {
	const d = new Date();
	return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortSessionId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Replace a file atomically (tmp file + rename in the same directory).
 * Direct writeFileSync truncates the target first, so a failure mid-write
 * (ENOSPC/EFBIG, SIGKILL) destroys the previous content. Verified by probe:
 * under a file-size limit the whole store was lost. With tmp+rename the
 * original stays intact on any failure.
 */
export function writeFileAtomic(filePath: string, content: string): void {
	const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${randomUUID()}`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(tmp, "w", 0o644);
		fs.writeFileSync(fd, content, "utf-8");
		fs.fsyncSync(fd);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* tmp may not exist */
		}
		throw err;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	try {
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
}

const RESPONSE_PREVIEW_MAX_CHARS = 24_000;
const RESPONSE_PREVIEW_MAX_LINES = 500;
const CONTEXT_LONG_TERM_MAX_CHARS = 24_000;
const CONTEXT_LONG_TERM_MAX_LINES = 500;
const CONTEXT_DAILY_MAX_CHARS = 4_000;
const CONTEXT_DAILY_MAX_LINES = 150;
const CONTEXT_MAX_CHARS = 32_000;
const CONTEXT_SEARCH_MAX_CHARS = 3_000;

type TruncateMode = "start" | "end" | "middle";

/**
 * Adjust a UTF-16 index so a cut never lands inside a surrogate pair
 * (slicing mid-pair yields a lone surrogate → garbled CJK/emoji in previews
 * and injected context, even though the stored file is intact).
 * If `index` points at the low half of a pair, step back so the full
 * character is kept.
 */
function safeCutIndex(text: string, index: number): number {
	const clamped = Math.max(0, Math.min(index, text.length));
	if (clamped === 0 || clamped >= text.length) return clamped;
	const c = text.charCodeAt(clamped);
	if (
		c >= 0xdc00 &&
		c <= 0xdfff &&
		text.charCodeAt(clamped - 1) >= 0xd800 &&
		text.charCodeAt(clamped - 1) <= 0xdbff
	) {
		return clamped - 1;
	}
	return clamped;
}

/** slice(0, n) that never splits a surrogate pair. */
function sliceStart(text: string, maxChars: number): string {
	return text.slice(0, safeCutIndex(text, maxChars));
}

/** slice(-n) that never splits a surrogate pair. */
function sliceEnd(text: string, maxChars: number): string {
	if (maxChars >= text.length) return text;
	return text.slice(safeCutIndex(text, text.length - maxChars));
}

interface PreviewResult {
	preview: string;
	truncated: boolean;
	totalLines: number;
	totalChars: number;
	previewLines: number;
	previewChars: number;
}

function normalizeContent(content: string): string {
	return content.trim();
}

function truncateLines(lines: string[], maxLines: number, mode: TruncateMode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}
	if (mode === "end") return { lines: lines.slice(-maxLines), truncated: true };
	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		return {
			lines: [...lines.slice(0, headCount), marker, ...(tailCount > 0 ? lines.slice(-tailCount) : [])],
			truncated: true,
		};
	}
	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text: string, maxChars: number, mode: TruncateMode) {
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	if (mode === "end") return { text: sliceEnd(text, maxChars), truncated: true };
	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: sliceStart(text, headCount) + marker + sliceEnd(text, tailCount),
				truncated: true,
			};
		}
	}
	return { text: sliceStart(text, maxChars), truncated: true };
}

export function buildPreview(
	content: string,
	options: { maxLines: number; maxChars: number; mode: TruncateMode },
): PreviewResult {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return { preview: "", truncated: false, totalLines: 0, totalChars: 0, previewLines: 0, previewChars: 0 };
	}
	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;
	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	let preview = lineResult.lines.join("\n");
	const textResult = truncateText(preview, options.maxChars, options.mode);
	preview = textResult.text;
	const truncated = lineResult.truncated || textResult.truncated;
	return {
		preview,
		truncated,
		totalLines,
		totalChars,
		previewLines: preview ? preview.split("\n").length : 0,
		previewChars: preview.length,
	};
}

/** Tool-response body for memory_read: capped, with a truncation note. */
export function previewMemoryContent(content: string): { text: string; truncated: boolean } {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode: "middle",
	});
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars — use memory_search for targeted recall]`
		: "";
	return { text: `${result.preview}${note}`, truncated: result.truncated };
}

function formatPreviewBlock(label: string, content: string, mode: TruncateMode): string {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});
	const note = result.truncated
		? `\n[truncated: showing ${result.previewLines}/${result.totalLines} lines]`
		: "";
	return `${label}:${note}\n${result.preview}`;
}

function formatContextSection(
	label: string,
	content: string,
	mode: TruncateMode,
	maxLines: number,
	maxChars: number,
): string {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) return "";
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

// ---------------------------------------------------------------------------
// Job 2/3 — Forget/restore helpers
// ---------------------------------------------------------------------------

const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryTarget = "long_term" | "daily" | "compaction";

interface RecoveryRecord {
	version: 1;
	id: string;
	createdAt: string;
	target: MemoryTarget;
	date?: string;
	removedContent: string[];
	restoredAt?: string;
	originalMemory?: string;
	archivedDailies?: string[];
}

export function forgetBlocks(content: string, match: string): { content: string; removed: string[] } {
	const needle = match.trim().toLowerCase();
	if (!needle) return { content, removed: [] };
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedContent = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");

	const blocks: string[] = [];
	let currentLines: string[] = [];
	let currentIsStamped = false;
	const flushCurrent = () => {
		const current = currentLines.join("\n").trim();
		if (!current) return;
		if (currentIsStamped) {
			blocks.push(current);
		} else {
			blocks.push(
				...current
					.split(/\n{2,}/)
					.map((b) => b.trim())
					.filter(Boolean),
			);
		}
	};

	for (const line of normalizedContent.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flushCurrent();
			currentLines = [line];
			currentIsStamped = true;
		} else if (currentIsStamped && line.trim() === "") {
			// A blank line ends a stamped entry. Without this, any unstamped
			// paragraphs after it would be glued to the entry and deleted
			// together by memory_forget (over-deletion).
			flushCurrent();
			currentLines = [];
			currentIsStamped = false;
		} else {
			currentLines.push(line);
		}
	}
	flushCurrent();

	const kept: string[] = [];
	const removed: string[] = [];
	for (const block of blocks) {
		if (block.toLowerCase().includes(needle)) removed.push(block);
		else kept.push(block);
	}
	if (removed.length === 0) return { content, removed };
	const joined = kept.join("\n\n").trim();
	return {
		content: joined ? `${joined}\n`.replace(/\n/g, newline) : "",
		removed: removed.map((b) => b.replace(/\n/g, newline)),
	};
}

function recoveryPath(recoveryId: string): string | null {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(RECOVERY_DIR, `${recoveryId}.json`);
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<RecoveryRecord>;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		RECOVERY_ID_REGEX.test(record.id) &&
		(record.target === "long_term" || record.target === "daily" || record.target === "compaction") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.every((e) => typeof e === "string")
	);
}

function writeRecoveryRecord(target: MemoryTarget, date: string | undefined, removedContent: string[]): RecoveryRecord {
	const record: RecoveryRecord = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

function readRecoveryRecord(recoveryId: string): { record: RecoveryRecord; filePath: string } | null {
	const filePath = recoveryPath(recoveryId);
	if (!filePath) return null;
	const content = readFileSafe(filePath);
	if (!content) return null;
	try {
		const record: unknown = JSON.parse(content);
		if (!isRecoveryRecord(record) || record.id !== recoveryId) return null;
		return { record, filePath };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Autonomous Zero-Touch Compaction Engine
// ---------------------------------------------------------------------------

export const COMPACTION_MEMORY_MAX_CHARS = 24_000;
export const COMPACTION_MEMORY_MAX_LINES = 500;
export const COMPACTION_DAILY_MAX_DAYS = 14;

export function shouldCompactMemory(content: string): boolean {
	if (!content.trim()) return false;
	const lines = content.split("\n");
	return lines.length > COMPACTION_MEMORY_MAX_LINES || content.length > COMPACTION_MEMORY_MAX_CHARS;
}

export function extractDeduplicationKey(block: string): string | null {
	// Look for [[tag-link]] first
	const linkMatch = block.match(/\[\[([a-zA-Z0-9_-]+)\]\]/);
	if (linkMatch) return linkMatch[1].toLowerCase();

	const headerMatch = block.match(/^(?:#|##|###)\s+([^\n\r]+)/m);
	if (headerMatch) return headerMatch[1].trim().toLowerCase();

	return null;
}

export function parseMemoryEntries(content: string): Array<{ raw: string; key: string | null; stamped: boolean }> {
	const normalized = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
	const entries: Array<{ raw: string; key: string | null; stamped: boolean }> = [];
	let currentLines: string[] = [];
	let isStamped = false;

	const flush = () => {
		const raw = currentLines.join("\n").trim();
		if (!raw) return;
		entries.push({
			raw,
			key: extractDeduplicationKey(raw),
			stamped: isStamped,
		});
		currentLines = [];
		isStamped = false;
	};

	for (const line of normalized.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line.trim())) {
			flush();
			currentLines.push(line);
			isStamped = true;
		} else if (isStamped && line.trim() === "" && currentLines.length > 1) {
			currentLines.push(line);
		} else if (!isStamped && line.trim() === "" && currentLines.length > 0) {
			flush();
		} else {
			currentLines.push(line);
		}
	}
	flush();
	return entries;
}

export function archiveAgingDailyLogs(daysToKeep = COMPACTION_DAILY_MAX_DAYS): string[] {
	ensureDirs();
	const moved: string[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(DAILY_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}

	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
	const cutoffStr = localDateStr(cutoffDate);

	for (const f of files) {
		const datePart = f.replace(/\.md$/, "");
		if (isValidDailyDate(datePart) && datePart < cutoffStr) {
			const src = path.join(DAILY_DIR, f);
			const dst = path.join(ARCHIVE_DAILY_DIR, f);
			try {
				fs.renameSync(src, dst);
				moved.push(f);
			} catch {
				/* ignore if rename fails */
			}
		}
	}
	return moved;
}

let qmdCleanupTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleQmdCleanup(delayMs = 2_000) {
	if (!qmdAvailable) return;
	if (qmdCleanupTimer) clearTimeout(qmdCleanupTimer);
	qmdCleanupTimer = setTimeout(() => {
		execFileFn("qmd", ["cleanup"], { timeout: 15_000 }, () => {
			/* fire and forget */
		});
	}, delayMs);
}

export interface CompactionResult {
	triggered: boolean;
	reason?: string;
	recoveryId?: string;
	supersededCount: number;
	archivedDailiesCount: number;
	knowledgeCreatedCount: number;
	beforeChars: number;
	afterChars: number;
	beforeLines: number;
	afterLines: number;
}

let isCompacting = false;

export async function runAutonomousCompaction(reason = "lifecycle"): Promise<CompactionResult> {
	if (isCompacting) {
		return {
			triggered: false,
			supersededCount: 0,
			archivedDailiesCount: 0,
			knowledgeCreatedCount: 0,
			beforeChars: 0,
			afterChars: 0,
			beforeLines: 0,
			afterLines: 0,
		};
	}
	isCompacting = true;
	const compStartTime = Date.now();
	try {
		ensureDirs();
		const originalMemory = readFileSafe(MEMORY_FILE) ?? "";
		const memoryOverThreshold = shouldCompactMemory(originalMemory);
		const agingDailies = archiveAgingDailyLogs(COMPACTION_DAILY_MAX_DAYS);

		if (!memoryOverThreshold && agingDailies.length === 0) {
			return {
				triggered: false,
				supersededCount: 0,
				archivedDailiesCount: 0,
				knowledgeCreatedCount: 0,
				beforeChars: originalMemory.length,
				afterChars: originalMemory.length,
				beforeLines: originalMemory.split("\n").length,
				afterLines: originalMemory.split("\n").length,
			};
		}

		const beforeChars = originalMemory.length;
		const beforeLines = originalMemory.split("\n").length;
		let recoveryId: string | undefined;

		let supersededCount = 0;
		let knowledgeCreatedCount = 0;
		let newMemory = originalMemory;

		if (memoryOverThreshold) {
			const entries = parseMemoryEntries(originalMemory);
			// 1. Invariant deduplication: keep latest entry for each key
			const keyToLatestIndex = new Map<string, number>();
			entries.forEach((e, idx) => {
				if (e.key) keyToLatestIndex.set(e.key, idx);
			});

			const activeEntries: typeof entries = [];
			const supersededEntries: typeof entries = [];

			entries.forEach((e, idx) => {
				if (e.key && keyToLatestIndex.get(e.key) !== idx) {
					supersededEntries.push(e);
				} else {
					activeEntries.push(e);
				}
			});

			supersededCount = supersededEntries.length;

			// Append superseded entries to ARCHIVE_SUPERSEDED_FILE
			if (supersededEntries.length > 0) {
				const existingArchive = readFileSafe(ARCHIVE_SUPERSEDED_FILE) ?? "";
				const ts = nowTimestamp();
				const archivedBlocks = supersededEntries.map(
					(e) => `<!-- superseded archived ${ts} -->\n${e.raw}`,
				);
				const sep = existingArchive.trim() ? "\n\n" : "";
				writeFileAtomic(ARCHIVE_SUPERSEDED_FILE, existingArchive + sep + archivedBlocks.join("\n\n"));
			}

			// 2. If active entries still exceed threshold, migrate large blocks (>800 chars or >25 lines) to knowledge/
			const finalEntries: string[] = [];

			for (const e of activeEntries) {
				const isLarge = e.raw.length > 800 || e.raw.split("\n").length > 25;
				if (isLarge && e.key) {
					const topic = sanitizeTopicName(e.key);
					const kPath = knowledgePath(topic);
					const existingK = readFileSafe(kPath) ?? "";
					const sep = existingK.trim() ? "\n\n" : "";
					writeFileAtomic(kPath, existingK + sep + e.raw);
					knowledgeCreatedCount++;
					const contentLines = e.raw
						.split("\n")
						.map((l) => l.trim())
						.filter((l) => l && !l.startsWith("<!--"));
					const summary = contentLines.slice(0, 2).join(" ");
					finalEntries.push(
						`<!-- migrated to knowledge/${topic}.md -->\n${summary ? `${summary}\n` : ""}#fact [[${topic}]] Full dossier preserved in knowledge/${topic}.md`,
					);
				} else {
					finalEntries.push(e.raw);
				}
			}

			newMemory = finalEntries.join("\n\n");

			// Write recovery record
			const rec: RecoveryRecord = {
				version: 1,
				id: randomUUID(),
				createdAt: new Date().toISOString(),
				target: "compaction" as MemoryTarget,
				removedContent: supersededEntries.map((e) => e.raw),
				originalMemory,
				archivedDailies: agingDailies,
			};
			const recPath = recoveryPath(rec.id);
			if (recPath) {
				fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`, "utf-8");
				recoveryId = rec.id;
			}

			writeFileAtomic(MEMORY_FILE, newMemory);
			refreshMemorySnapshot("autonomous_compaction");
		}

		scheduleQmdCleanup();
		scheduleQmdUpdate();

		const compDurationMs = Date.now() - compStartTime;
		recordCompactionTelemetry({
			reason,
			durationMs: compDurationMs,
			beforeChars,
			afterChars: newMemory.length,
			supersededCount,
			archivedDailiesCount: agingDailies.length,
			knowledgeCreatedCount,
		});
		logDebug(
			`autonomous compaction (${reason}): ${beforeChars} -> ${newMemory.length} chars (${supersededCount} superseded, ${knowledgeCreatedCount} knowledge, ${agingDailies.length} dailies) in ${compDurationMs}ms`,
		);

		return {
			triggered: true,
			reason,
			recoveryId,
			supersededCount,
			archivedDailiesCount: agingDailies.length,
			knowledgeCreatedCount,
			beforeChars,
			afterChars: newMemory.length,
			beforeLines,
			afterLines: newMemory.split("\n").length,
		};
	} finally {
		isCompacting = false;
	}
}

export function maybeTriggerAutonomousCompaction(triggerReason: string) {
	// Run non-blocking in background
	setImmediate(() => {
		runAutonomousCompaction(triggerReason).catch(() => {
			/* fail soft */
		});
	});
}

// ---------------------------------------------------------------------------
// Telemetry & Metrics Ledger (persisted in .recovery/telemetry.json)
// ---------------------------------------------------------------------------

export interface TelemetryState {
	version: 1;
	retrievalStats: {
		totalTurns: number;
		hits: number;
		misses: number;
		timeouts: number;
		totalDurationMs: number;
		avgDurationMs: number;
		recentSearches: Array<{
			timestamp: string;
			promptSnippet: string;
			winnerCandidate: string | null;
			hits: number;
			durationMs: number;
		}>;
	};
	compactionHistory: Array<{
		timestamp: string;
		reason: string;
		durationMs: number;
		beforeChars: number;
		afterChars: number;
		supersededCount: number;
		archivedDailiesCount: number;
		knowledgeCreatedCount: number;
	}>;
	searchStats: {
		totalSearches: number;
		byMode: {
			keyword: number;
			semantic: number;
			deep: number;
		};
		avgDurationMs: number;
		recentQueries: Array<{
			timestamp: string;
			mode: string;
			querySnippet: string;
			hits: number;
			durationMs: number;
			error?: string;
		}>;
	};
}

function initialTelemetryState(): TelemetryState {
	return {
		version: 1,
		retrievalStats: {
			totalTurns: 0,
			hits: 0,
			misses: 0,
			timeouts: 0,
			totalDurationMs: 0,
			avgDurationMs: 0,
			recentSearches: [],
		},
		compactionHistory: [],
		searchStats: {
			totalSearches: 0,
			byMode: { keyword: 0, semantic: 0, deep: 0 },
			avgDurationMs: 0,
			recentQueries: [],
		},
	};
}

export function telemetryPath(): string {
	return path.join(RECOVERY_DIR, "telemetry.json");
}

export function readTelemetry(): TelemetryState {
	ensureDirs();
	const content = readFileSafe(telemetryPath());
	if (!content) return initialTelemetryState();
	try {
		const parsed = JSON.parse(content);
		if (parsed && parsed.version === 1) return parsed as TelemetryState;
	} catch {
		/* ignore */
	}
	return initialTelemetryState();
}

export function writeTelemetryAtomic(state: TelemetryState) {
	try {
		ensureDirs();
		writeFileAtomic(telemetryPath(), JSON.stringify(state, null, 2));
	} catch {
		/* non-critical telemetry failure must never break execution */
	}
}

export function isDebugEnabled(): boolean {
	const envVal = (process.env.PI_MEMORY_DEBUG ?? process.env.DEBUG ?? "").toLowerCase();
	return envVal === "1" || envVal === "true" || envVal.includes("pi-memory");
}

export function logDebug(msg: string, ...args: unknown[]) {
	if (!isDebugEnabled()) return;
	const ts = new Date().toISOString().slice(11, 19);
	console.error(`[pi-memory ${ts}] ${msg}`, ...args);
}

export function recordRetrievalTelemetry(entry: {
	promptSnippet: string;
	winnerCandidate: string | null;
	hits: number;
	durationMs: number;
	timedOut?: boolean;
}) {
	const state = readTelemetry();
	const r = state.retrievalStats;
	r.totalTurns++;
	if (entry.timedOut) r.timeouts++;
	if (entry.hits > 0) r.hits++;
	else r.misses++;
	r.totalDurationMs += entry.durationMs;
	r.avgDurationMs = Math.round(r.totalDurationMs / r.totalTurns);

	r.recentSearches.unshift({
		timestamp: nowTimestamp(),
		promptSnippet: entry.promptSnippet.slice(0, 80),
		winnerCandidate: entry.winnerCandidate,
		hits: entry.hits,
		durationMs: entry.durationMs,
	});
	if (r.recentSearches.length > 50) r.recentSearches = r.recentSearches.slice(0, 50);

	writeTelemetryAtomic(state);
}

export function recordCompactionTelemetry(entry: {
	reason: string;
	durationMs: number;
	beforeChars: number;
	afterChars: number;
	supersededCount: number;
	archivedDailiesCount: number;
	knowledgeCreatedCount: number;
}) {
	const state = readTelemetry();
	state.compactionHistory.unshift({
		timestamp: nowTimestamp(),
		...entry,
	});
	if (state.compactionHistory.length > 50) {
		state.compactionHistory = state.compactionHistory.slice(0, 50);
	}
	writeTelemetryAtomic(state);
}

export function recordSearchTelemetry(entry: {
	mode: "keyword" | "semantic" | "deep";
	querySnippet: string;
	hits: number;
	durationMs: number;
	error?: string;
}) {
	const state = readTelemetry();
	const s = state.searchStats;
	s.totalSearches++;
	s.byMode[entry.mode] = (s.byMode[entry.mode] || 0) + 1;
	const prevTotal = s.avgDurationMs * (s.totalSearches - 1);
	s.avgDurationMs = Math.round((prevTotal + entry.durationMs) / s.totalSearches);

	s.recentQueries.unshift({
		timestamp: nowTimestamp(),
		mode: entry.mode,
		querySnippet: entry.querySnippet.slice(0, 80),
		hits: entry.hits,
		durationMs: entry.durationMs,
		error: entry.error,
	});
	if (s.recentQueries.length > 50) s.recentQueries = s.recentQueries.slice(0, 50);

	writeTelemetryAtomic(state);
}

// ---------------------------------------------------------------------------
// Job 4 — Context injection (hybrid: stable core + turn retrieval)
// ---------------------------------------------------------------------------

/** Always-on core: today daily + MEMORY.md (no yesterday, no scratchpad). */
export function buildMemoryContext(): string {
	ensureDirs();
	const sections: string[] = [];
	const today = todayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) return "";

	const context = `# Memory (project: ${path.basename(PROJECT_ROOT)})\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}
	return context;
}

type SnapshotMode = "stable" | "refresh";

function getSnapshotMode(): SnapshotMode {
	const v = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").trim().toLowerCase();
	return v === "refresh" ? "refresh" : "stable";
}

/** Turn-message qmd retrieval (default on). Set PI_MEMORY_RETRIEVE=off to disable. */
export function isRetrieveEnabled(): boolean {
	const v = (process.env.PI_MEMORY_RETRIEVE ?? "on").trim().toLowerCase();
	return !(v === "0" || v === "off" || v === "false" || v === "no");
}

export function sanitizeSearchPrompt(prompt: string): string {
	return prompt
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, safeCutIndex(prompt, 200));
}

const QUERY_STOPWORDS = new Set([
	// Grammatical / functional pronouns & determiners
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
	"have", "has", "had", "having", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
	"us", "them", "my", "mine", "your", "yours", "his", "her", "hers", "its", "our", "ours",
	"their", "theirs", "what", "which", "who", "whom", "whose", "this", "that", "these", "those",
	"some", "any", "all", "both", "each", "every", "other", "another", "such",
	// Prepositions & conjunctions
	"of", "in", "on", "at", "to", "for", "with", "from", "by", "as", "and", "or", "but", "if",
	"then", "than", "so", "not", "no", "yes", "can", "could", "will", "would", "shall", "should",
	"may", "might", "must", "about", "into", "over", "under", "after", "before", "between",
	"during", "through", "against", "without", "within", "along", "across",
	// Output formatting & instruction filler
	"answer", "name", "only", "one", "short", "sentence", "reply", "use", "used", "using",
	"tell", "give", "show", "find",
	// Conversational / meta inquiry verbs & discourse markers
	"want", "wants", "wanted", "know", "knows", "knew", "known", "how", "why", "when", "where",
	"question", "questions", "ask", "asked", "asking", "think", "thinks", "thought",
	"please", "like", "just", "also", "let", "lets", "see", "look", "get", "got", "getting",
	"make", "made", "making", "take", "took", "need", "needs", "needed", "say", "said", "saying",
	"someday", "maybe", "perhaps", "example", "sample", "naive",
	// Temporal / frequency adverbs
	"actually", "really", "already", "still", "ever", "never", "always", "today", "yesterday",
	"tomorrow", "now", "again", "first", "second", "third", "last", "next", "previous",
	"thing", "things", "way", "ways", "lot", "lots",
	// Continuation, flow & acknowledgment markers
	"continue", "continues", "continued", "continuing",
	"proceed", "proceeds", "proceeded", "proceeding",
	"resume", "resumes", "resumed", "resuming",
	"start", "started", "starting", "stop", "stopped", "stopping",
	"finish", "finished", "finishing", "done",
	"keep", "going", "step", "steps", "turn", "turns",
	"ok", "okay", "cool", "nice", "good", "great", "fine", "alright",
	"sounds", "looks", "awesome", "perfect", "thanks", "thank", "sure", "yep", "yeah", "lgtm",
	// Meta-evaluation & execution performance terms (prevents false-positive conjunctive leaks on turn reviews)
	"performing", "performed", "perform", "performs", "performance",
	"execution", "experience", "intended", "intented", "intend", "intends",
	"status", "progress", "update", "updates", "result", "results",
	"working", "works", "worked", "doing",
	"well", "better", "best", "worse", "worst",
	"remember", "remind", "check",
]);

/**
 * Detect conversational meta-turns, acknowledgments, continuations,
 * or pure procedural directives that lack domain-specific query intent.
 * Gating these early saves ~600ms QMD search latency and eliminates
 * false-positive memory injections (e.g. searching for "continue" or "our execution").
 */
export function isMetaTurn(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (!trimmed) return true;

	// Normalize: lower-case, collapse whitespace, strip peripheral punctuation
	const normalized = trimmed
		.toLowerCase()
		.replace(/^[^a-z0-9#+_-]+|[^a-z0-9#+_-]+$/gi, "")
		.trim();

	// Exact / pure continuation and acknowledgment patterns
	const PURE_META_PATTERNS = new Set([
		"continue", "proceed", "go on", "go ahead", "keep going", "resume", "carry on", "next", "more",
		"ok", "okay", "cool", "nice", "good", "great", "sounds good", "looks good", "lgtm",
		"thanks", "thank you", "thx", "ty", "yes", "yep", "yeah", "sure", "fine", "alright", "all right",
		"done", "perfect", "awesome", "got it", "understood", "ack",
		"no", "nope", "cancel", "stop",
		"run tests", "run test", "run the tests", "test", "tests",
		"commit", "push", "git status", "revert", "clean up", "undo",
	]);

	if (PURE_META_PATTERNS.has(normalized)) return true;

	// Regex for common short acknowledgment/continuation combinations (e.g. "ok continue", "cool, thanks", "sounds good, proceed")
	if (
		/^(ok|okay|cool|nice|good|great|thanks|thank you|sure|yep|yes|proceed|continue|sounds good|looks good|all right)[\s,!.-]+(continue|proceed|go on|go ahead|thanks|thank you|next|done|ok|cool)?$/i.test(
			trimmed,
		)
	) {
		return true;
	}

	return false;
}

/**
 * Derive keyword-query candidates for conjunctive BM25 (qmd `search`):
 * every query term must appear in a document, so raw natural-language
 * prompts with function words reliably return zero hits (probed). Candidates
 * go from most-specific to most-generic: raw prompt → content words →
 * adjacent content-word pairs → long single tokens.
 *
 * If the prompt is a meta-turn or contains zero non-stopword content tokens,
 * returns an empty array to short-circuit retrieval and prevent false-positive leaks.
 */
export function deriveQueryCandidates(prompt: string): string[] {
	if (isMetaTurn(prompt)) return [];

	const tokens = prompt
		.toLowerCase()
		.replace(/[^a-z0-9\s#+-]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));

	if (tokens.length === 0) return [];

	const candidates: string[] = [prompt.trim()];
	candidates.push(tokens.join(" "));
	for (let i = 0; i < tokens.length - 1; i++) candidates.push(`${tokens[i]} ${tokens[i + 1]}`);
	candidates.push(...tokens.filter((t) => t.length >= 6).slice(0, 4));
	const seen = new Set<string>();
	return candidates.filter((c) => {
		const key = c.toLowerCase();
		if (!c || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

let memorySnapshot: string | null = null;
let snapshotTakenOnDate: string | null = null;
let snapshotReason = "";

function refreshMemorySnapshot(reason: string) {
	memorySnapshot = buildMemoryContext();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
}

function buildStableSystemAppend(): string {
	const mode = getSnapshotMode();
	const memoryContext = memorySnapshot ?? "";
	if (!memoryContext) return "";

	const caveat =
		mode === "refresh"
			? `Snapshot ${snapshotReason}. Use memory_read / memory_search for latest state.`
			: "Core is byte-stable between memory mutations; refreshed after memory_write/forget/restore and at day rollover. Use memory_read / memory_search for authoritative latest state.";

	return [
		"\n\n## Memory",
		`(${caveat})`,
		`Project root: ${PROJECT_ROOT}`,
		`Store: ${MEMORY_DIR}`,
		"Use memory_write to persist important information.",
		"- Decisions / preferences / durable facts → MEMORY.md",
		"- Day-to-day notes → daily/<YYYY-MM-DD>.md",
		"- Search past context → memory_search (keyword | semantic | deep)",
		"- Use #tags (e.g. #decision, #preference, #lesson, #bug, #fact) and [[wiki-links]] (e.g. [[database-choice]]) in content to improve search recall.",
		'- If someone says "remember this," write it immediately.',
		"",
		memoryContext,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Job 5 — qmd (per-project collection)
// ---------------------------------------------------------------------------

type ExecFileFn = typeof execFile;
let execFileFn: ExecFileFn = execFile;

export function _setExecFileForTest(fn: ExecFileFn) {
	execFileFn = fn;
}
export function _resetExecFileForTest() {
	execFileFn = execFile;
}

type QmdUpdateMode = "background" | "manual" | "off";

function getQmdUpdateMode(): QmdUpdateMode {
	const v = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").trim().toLowerCase();
	if (v === "manual" || v === "off") return v;
	return "background";
}

function getQmdSearchTimeoutMs(): number {
	const n = Number(process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : 60_000;
}

function getEmbedProbeTimeoutMs(): number {
	const n = Number(process.env.PI_MEMORY_EMBED_PROBE_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : 15_000;
}

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
const qmdCollectionStatusCache = new Map<string, { checkedAt: number; exists: boolean }>();
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5_000;

function qmdStatusTtl(exists: boolean): number {
	return exists ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

export function _setQmdAvailable(value: boolean) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

export function qmdInstallInstructions(): string {
	return [
		"memory_search requires qmd.",
		"",
		"Install: npm install -g @tobilu/qmd",
		"",
		"This extension auto-creates a per-project collection on session start.",
		"Manual setup:",
		`  qmd collection add ${MEMORY_DIR} --name ${COLLECTION_NAME}`,
		"  qmd embed",
	].join("\n");
}

export async function setupQmdCollection(): Promise<boolean> {
	const name = COLLECTION_NAME;
	try {
		await new Promise<void>((resolve, reject) => {
			execFileFn(
				"qmd",
				["collection", "add", MEMORY_DIR, "--name", name],
				{ timeout: 10_000, encoding: "utf8" },
				(err) => (err ? reject(err) : resolve()),
			);
		});
	} catch {
		return false;
	}

	const contexts: [string, string][] = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise<void>((resolve, reject) => {
				execFileFn(
					"qmd",
					["context", "add", ctxPath, desc, "-c", name],
					{ timeout: 10_000, encoding: "utf8" },
					(err) => (err ? reject(err) : resolve()),
				);
			});
		} catch {
			/* ignore */
		}
	}
	qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd(): Promise<boolean> {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}
	return new Promise((resolve) => {
			execFileFn("qmd", ["collection", "list"], { timeout: 15_000, encoding: "utf8" }, (err) => {
				// Only a missing binary means "qmd not installed". Any other error
				// (EACCES, broken install) should surface the real failure in
				// memory_search instead of telling the user to install qmd.
				qmdAvailable = !err || (err as NodeJS.ErrnoException).code !== "ENOENT";
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

/**
 * Match a collection name in `qmd collection list --json` output.
 * Tolerates both JSON arrays and plain text; falls back to a substring
 * match when the output is not a recognizable JSON array.
 */
export function collectionListIncludes(name: string, out: string): boolean {
	try {
		const collections: unknown = JSON.parse(out);
		if (Array.isArray(collections)) {
			return collections.some((entry) => {
				if (typeof entry === "string") return entry === name;
				if (entry != null && typeof entry === "object") return (entry as { name?: unknown }).name === name;
				return false;
			});
		}
	} catch {
		/* fall through to substring match */
	}
	return out.includes(name);
}

export function checkCollection(name: string = COLLECTION_NAME): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}
	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
			const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
			const exists = err ? false : collectionListIncludes(name, out);
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

const QMD_EMBED_TIMEOUT_MS = 10 * 60 * 1000;
let embedInFlight = false;
let embedPending = false;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

export function ensureQmdEmbed(): boolean {
	if (getQmdUpdateMode() !== "background") return false;
	if (!qmdAvailable) return false;
	if (embedInFlight) {
		embedPending = true;
		return true;
	}
	embedInFlight = true;
	execFileFn("qmd", ["embed", "-c", COLLECTION_NAME], { timeout: QMD_EMBED_TIMEOUT_MS, encoding: "utf8" }, () => {
		embedInFlight = false;
		if (embedPending) {
			embedPending = false;
			ensureQmdEmbed();
		}
	});
	return true;
}

async function ensureQmdAvailableForUpdate(): Promise<boolean> {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	if (updateTimer) clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn(
			"qmd",
			["update", "-c", COLLECTION_NAME],
			{ timeout: 30_000, encoding: "utf8" },
			() => ensureQmdEmbed(),
		);
	}, 500);
}

export function clampSearchLimit(value: number | undefined, fallback = 5, max = 25): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

export interface QmdSearchResult {
	path?: string;
	file?: string;
	score?: number;
	content?: string;
	chunk?: string;
	snippet?: string;
	[key: string]: unknown;
}

function getQmdResultPath(r: QmdSearchResult): string | undefined {
	return r.path ?? r.file;
}

function getQmdResultText(r: QmdSearchResult): string {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed || trimmed === "No results found." || trimmed === "No results found") return [];
	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function isQmdModelDownloading(): boolean {
	try {
		const home = process.env.HOME || "~";
		const modelsDir = path.join(home, ".cache", "qmd", "models");
		if (fs.existsSync(modelsDir)) {
			const files = fs.readdirSync(modelsDir);
			return files.some((f) => f.endsWith(".ipull"));
		}
	} catch {
		/* ignore */
	}
	return false;
}

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
	timeoutOverrideMs?: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	if (mode !== "keyword" && isQmdModelDownloading()) {
		return Promise.reject(
			new Error(
				"QMD model download in progress (~/.cache/qmd/models/*.ipull). Semantic/deep search will be available once download completes.",
			),
		);
	}

	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", COLLECTION_NAME, "-n", String(limit), query];
	const timeoutMs = timeoutOverrideMs ?? getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof execFileFn> | undefined;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			if (child?.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try {
						child.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}
			}
		}, timeoutMs);

		child = execFileFn(
			"qmd",
			args,
			{ timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" } as ExecFileOptions,
			(err, stdout, stderr) => {
				clearTimeout(timer);
				const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
				const errOut = typeof stderr === "string" ? stderr : String(stderr ?? "");
				if (err || timedOut) {
					const cleaned = stripAnsi(errOut).trim() || stripAnsi(err?.message ?? "").trim();
					const wasKilled = timedOut || (err as NodeJS.ErrnoException & { killed?: boolean })?.killed === true;
					const hint = wasKilled
						? ` (qmd timed out after ${timeoutMs / 1000}s — process killed, retry shortly)`
						: "";
					reject(new Error(`${cleaned || "qmd search failed"}${hint}`));
					return;
				}
				try {
					const parsed = parseQmdJson(out);
					const results = Array.isArray(parsed)
						? parsed
						: ((parsed as { results?: QmdSearchResult[]; hits?: QmdSearchResult[] }).results ??
							(parsed as { hits?: QmdSearchResult[] }).hits ??
							[]);
					resolve({ results, stderr: errOut });
				} catch (parseErr) {
					reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
				}
			},
		);
	});
}

/** Keyword top-N for the current user prompt → turn-message body (soft-fail). */
export async function searchRelevantMemories(prompt: string): Promise<string> {
	if (!qmdAvailable || !prompt.trim()) return "";
	const sanitized = sanitizeSearchPrompt(prompt);
	if (!sanitized) return "";

	const startTime = Date.now();

	// Short-circuit meta-turns and stopword-only prompts before invoking QMD
	const attempts = deriveQueryCandidates(sanitized).slice(0, 8);
	if (attempts.length === 0) {
		recordRetrievalTelemetry({
			promptSnippet: sanitized,
			winnerCandidate: null,
			hits: 0,
			durationMs: Date.now() - startTime,
			timedOut: false,
		});
		return "";
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	let winnerCandidate: string | null = null;
	let didTimeout = false;
	try {
		const hasCollection = await checkCollection(COLLECTION_NAME);
		if (!hasCollection) return "";
		const searchAll = async (): Promise<QmdSearchResult[]> => {
			for (const candidate of attempts) {
				const { results } = await runQmdSearch("keyword", candidate, 3, 1_000);
				if (results.length > 0) {
					winnerCandidate = candidate;
					return results;
				}
			}
			return [];
		};
		const results = await Promise.race([
			searchAll(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					didTimeout = true;
					reject(new Error("timeout"));
				}, 3_000);
			}),
		]);

		const snippets = (results || [])
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const clipped =
					text.length > CONTEXT_SEARCH_MAX_CHARS
						? `${sliceStart(text, CONTEXT_SEARCH_MAX_CHARS)}\n…`
						: text.trim();
				return filePath ? `_${filePath}_\n${clipped}` : clipped;
			})
			.filter(Boolean);

		const elapsed = Date.now() - startTime;
		recordRetrievalTelemetry({
			promptSnippet: sanitized,
			winnerCandidate,
			hits: snippets.length,
			durationMs: elapsed,
			timedOut: didTimeout,
		});
		logDebug(
			`turn retrieval: ${snippets.length} hit(s) via "${winnerCandidate ?? "none"}" in ${elapsed}ms`,
		);

		if (snippets.length === 0) return "";
		return [
			"## Relevant memories (auto-retrieved)",
			"Prompt-relevant entries from this project's memory store. Prefer these over guessing.",
			"",
			snippets.join("\n\n---\n\n"),
		].join("\n");
	} catch (err) {
		const elapsed = Date.now() - startTime;
		recordRetrievalTelemetry({
			promptSnippet: sanitized,
			winnerCandidate: null,
			hits: 0,
			durationMs: elapsed,
			timedOut: didTimeout,
		});
		logDebug(`turn retrieval error/timeout after ${elapsed}ms:`, err);
		return "";
	} finally {
		clearTimeout(timer);
	}
}

type ToolOut = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: true;
};

function toolResult(text: string, details: Record<string, unknown> = {}, isError = false): ToolOut {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true as const } : {}),
	};
}

export async function probeEmbeddings(): Promise<"ready" | "missing" | "unknown"> {
	const probeTimeoutMs = getEmbedProbeTimeoutMs();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const { stderr } = await Promise.race([
			runQmdSearch("semantic", "memory", 1, probeTimeoutMs),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), probeTimeoutMs);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

export function getMemoryInventory() {
	const longTerm = readFileSafe(MEMORY_FILE) ?? "";
	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	let knowledgeFiles: string[] = [];
	try {
		knowledgeFiles = fs
			.readdirSync(KNOWLEDGE_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		knowledgeFiles = [];
	}
	let archivedDailyFiles: string[] = [];
	try {
		archivedDailyFiles = fs
			.readdirSync(ARCHIVE_DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		archivedDailyFiles = [];
	}
	return {
		projectRoot: PROJECT_ROOT,
		dir: MEMORY_DIR,
		collectionName: COLLECTION_NAME,
		longTermChars: longTerm.trim().length,
		dailyCount: dailyFiles.length,
		knowledgeCount: knowledgeFiles.length,
		knowledgeFiles,
		archivedDailyCount: archivedDailyFiles.length,
		latestDaily: dailyFiles.length ? dailyFiles[dailyFiles.length - 1].replace(/\.md$/, "") : null,
	};
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		bindProject(ctx.cwd);
		ensureDirs();

		qmdAvailable = await detectQmd();
		if (qmdAvailable) {
			const hasCollection = await checkCollection(COLLECTION_NAME);
			if (!hasCollection) await setupQmdCollection();
			ensureQmdEmbed();
		} else if (ctx.hasUI) {
			ctx.ui.notify(
				`Project memory at ${MEMORY_DIR} (search needs qmd). Collection: ${COLLECTION_NAME}`,
				"info",
			);
		}

		refreshMemorySnapshot("session_start");
		maybeTriggerAutonomousCompaction("session_start");
	});

	pi.on("session_before_compact", async () => {
		await runAutonomousCompaction("session_before_compact");
	});

	pi.on("before_agent_start", async (event) => {
		// Skip non-user runs (e.g. custom triggerTurn) so we don't repeat retrieval.
		if ("messageType" in event && event.messageType !== "user") {
			const core = buildStableSystemAppend();
			return core ? { systemPrompt: event.systemPrompt + core } : undefined;
		}

		// Snapshot policy (both modes): byte-stable between mutations, refreshed
		// on first use, after any memory mutation (write/forget/restore refresh
		// eagerly), and at local day rollover so "today" stays correct.
		if (memorySnapshot === null || snapshotTakenOnDate !== todayStr()) {
			refreshMemorySnapshot(memorySnapshot === null ? "session_start" : "day_rollover");
		}

		const coreAppend = buildStableSystemAppend();
		const prompt = "prompt" in event && typeof event.prompt === "string" ? event.prompt : "";
		const retrieved =
			isRetrieveEnabled() && qmdAvailable ? await searchRelevantMemories(prompt) : "";

		const result: {
			systemPrompt?: string;
			message?: { customType: string; content: string; display: boolean };
		} = {};

		if (coreAppend) {
			result.systemPrompt = event.systemPrompt + coreAppend;
		}
		if (retrieved) {
			result.message = {
				customType: "pi-memory-retrieve",
				content: retrieved,
				display: false,
			};
		}

		return Object.keys(result).length ? result : undefined;
	});

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to this project's memory files under .pi/memory/.",
			"- 'long_term': MEMORY.md (append or overwrite) — active working invariants, preferences, laws",
			"- 'knowledge': knowledge/<topic>.md (append or overwrite) — modular domain knowledge dossiers",
			"- 'daily': today's daily log (always append) — running notes",
			"Prefer tagged entries for recall, e.g.:",
			"  #decision [[database-choice]] Chose PostgreSQL for backend services.",
			"  #preference [[package-manager]] Always use pnpm, never npm.",
			"  #lesson [[api-versioning]] URL prefix /v1/ avoids CDN cache issues.",
			"Suggested tags (not enforced): #decision #preference #lesson #bug #fact plus [[wiki-links]].",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily", "knowledge"] as const, {
				description: "Where to write",
			}),
			content: Type.String({ description: "Markdown content (use #tags and [[links]] when useful)" }),
			topic: Type.Optional(
				Type.String({
					description:
						"Topic name for knowledge target (e.g. 'architecture', 'billing'). Stored as knowledge/<topic>.md",
				}),
			),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "long_term or knowledge only. Default: append",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolOut> {
			ensureDirs();
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();
			const { target, content, mode, topic } = params;

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				const separator = existing.trim() ? "\n\n" : "";
				writeFileAtomic(filePath, existing + separator + stamped);
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text" as const,
							text: `Appended to daily log: ${filePath}\n\n${formatPreviewBlock("Existing preview", existing, "end")}`,
						},
					],
					details: { path: filePath, target, projectRoot: PROJECT_ROOT },
				};
			}

			if (target === "knowledge") {
				const cleanTopic = sanitizeTopicName(topic || "general");
				const filePath = knowledgePath(cleanTopic);
				const existing = readFileSafe(filePath) ?? "";
				if (mode === "overwrite") {
					writeFileAtomic(filePath, `<!-- last updated: ${ts} [${sid}] -->\n${content}`);
				} else {
					const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
					const separator = existing.trim() ? "\n\n" : "";
					writeFileAtomic(filePath, existing + separator + stamped);
				}
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text" as const,
							text: `${mode === "overwrite" ? "Overwrote" : "Appended to"} knowledge dossier [${cleanTopic}] (${filePath})`,
						},
					],
					details: {
						path: filePath,
						target,
						topic: cleanTopic,
						mode: mode ?? "append",
						projectRoot: PROJECT_ROOT,
					},
				};
			}

			const existing = readFileSafe(MEMORY_FILE) ?? "";
			if (mode === "overwrite") {
				writeFileAtomic(MEMORY_FILE, `<!-- last updated: ${ts} [${sid}] -->\n${content}`);
			} else {
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				const separator = existing.trim() ? "\n\n" : "";
				writeFileAtomic(MEMORY_FILE, existing + separator + stamped);
			}
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			refreshMemorySnapshot("long_term_write");
			maybeTriggerAutonomousCompaction("long_term_write");
			return {
				content: [
					{
						type: "text" as const,
						text: `${mode === "overwrite" ? "Overwrote" : "Appended to"} MEMORY.md (${MEMORY_FILE})`,
					},
				],
				details: { path: MEMORY_FILE, target, mode: mode ?? "append", projectRoot: PROJECT_ROOT },
			};
		},
	});

	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: "Read MEMORY.md, a knowledge dossier, a daily log, or list available dates/topics.",
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily", "list_daily", "knowledge", "list_knowledge"] as const),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD for daily (default: today)" })),
			topic: Type.Optional(Type.String({ description: "Topic name for knowledge (e.g. 'architecture', 'billing')" })),
		}),
		async execute(_id, params): Promise<ToolOut> {
			ensureDirs();
			if (params.target === "list_daily") {
				let files: string[] = [];
				try {
					files = fs
						.readdirSync(DAILY_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
				} catch {
					files = [];
				}
				return {
					content: [
						{
							type: "text" as const,
							text: files.length ? files.map((f) => f.replace(/\.md$/, "")).join("\n") : "No daily logs.",
						},
					],
					details: { count: files.length, dir: DAILY_DIR },
				};
			}

			if (params.target === "list_knowledge") {
				let files: string[] = [];
				try {
					files = fs
						.readdirSync(KNOWLEDGE_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort();
				} catch {
					files = [];
				}
				return {
					content: [
						{
							type: "text" as const,
							text: files.length
								? files.map((f) => f.replace(/\.md$/, "")).join("\n")
								: "No knowledge dossiers.",
						},
					],
					details: { count: files.length, dir: KNOWLEDGE_DIR },
				};
			}

			let filePath: string;
			if (params.target === "long_term") {
				filePath = MEMORY_FILE;
			} else if (params.target === "knowledge") {
				const cleanTopic = sanitizeTopicName(params.topic || "general");
				filePath = knowledgePath(cleanTopic);
			} else {
				const d = params.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text" as const, text: `Invalid date: ${d}` }],
						isError: true,
						details: {},
					};
				}
				filePath = dailyPath(d);
			}

			const content = readFileSafe(filePath);
			if (!content?.trim()) {
				return {
					content: [{ type: "text" as const, text: `${filePath} is empty or missing.` }],
					details: { path: filePath },
				};
			}
			// Cap the response like every other content path — reading a large
			// MEMORY.md must not flood the conversation.
			const { text, truncated } = previewMemoryContent(content);
			return {
				content: [{ type: "text" as const, text }],
				details: { path: filePath, chars: content.length, truncated },
			};
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description:
			"Delete stamped entries containing a case-insensitive substring. Creates a recovery record for memory_restore.",
		parameters: Type.Object({
			match: Type.String({ description: "Substring identifying entries to remove" }),
			target: Type.Optional(StringEnum(["long_term", "daily"] as const)),
			date: Type.Optional(Type.String({ description: "Daily date YYYY-MM-DD" })),
		}),
		async execute(_id, params): Promise<ToolOut> {
			ensureDirs();
			if (!params.match.trim()) {
				return {
					content: [{ type: "text" as const, text: "Error: 'match' must not be empty." }],
					isError: true,
					details: {},
				};
			}
			const target: MemoryTarget = (params.target ?? "long_term") as MemoryTarget;
			let filePath: string;
			let recoveryDate: string | undefined;
			if (target === "daily") {
				const d = params.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					return {
						content: [{ type: "text" as const, text: `Invalid date: ${d}` }],
						isError: true,
						details: {},
					};
				}
				filePath = dailyPath(d);
				recoveryDate = d;
			} else {
				filePath = MEMORY_FILE;
			}

			const existing = readFileSafe(filePath) ?? "";
			const result = forgetBlocks(existing, params.match);
			if (result.removed.length === 0) {
				return {
					content: [{ type: "text" as const, text: `No matching entries for: ${params.match}` }],
					details: {},
				};
			}
			const recovery = writeRecoveryRecord(target, recoveryDate, result.removed);
			writeFileAtomic(filePath, result.content);
			refreshMemorySnapshot("memory_forget");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [
					{
						type: "text" as const,
						text: `Removed ${result.removed.length} entr(y/ies). Recovery ID: ${recovery.id}`,
					},
				],
				details: { recoveryId: recovery.id, removed: result.removed.length, path: filePath },
			};
		},
	});

	pi.registerTool({
		name: "memory_restore",
		label: "Memory Restore",
		description: "Restore entries deleted by memory_forget using its recovery ID.",
		parameters: Type.Object({
			recovery_id: Type.String({ description: "UUID returned by memory_forget" }),
		}),
		async execute(_id, params): Promise<ToolOut> {
			ensureDirs();
			const loaded = readRecoveryRecord(params.recovery_id.trim());
			if (!loaded) {
				return {
					content: [{ type: "text" as const, text: `Unknown or invalid recovery ID: ${params.recovery_id}` }],
					isError: true,
					details: {},
				};
			}
			const { record, filePath: recoveryFile } = loaded;
			if (record.restoredAt) {
				return {
					content: [{ type: "text" as const, text: `Already restored at ${record.restoredAt}` }],
					details: { recoveryId: record.id },
				};
			}

			if (record.target === "compaction") {
				if (record.originalMemory) {
					writeFileAtomic(MEMORY_FILE, record.originalMemory);
				}
				if (record.archivedDailies && Array.isArray(record.archivedDailies)) {
					for (const f of record.archivedDailies) {
						const src = path.join(ARCHIVE_DAILY_DIR, f);
						const dst = path.join(DAILY_DIR, f);
						try {
							if (fs.existsSync(src)) fs.renameSync(src, dst);
						} catch {
							/* ignore */
						}
					}
				}
				record.restoredAt = new Date().toISOString();
				fs.writeFileSync(recoveryFile, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
				refreshMemorySnapshot("compaction_restore");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [
						{
							type: "text" as const,
							text: `Restored compaction snapshot to ${MEMORY_FILE} and restored ${record.archivedDailies?.length ?? 0} daily log(s).`,
						},
					],
					details: { recoveryId: record.id, path: MEMORY_FILE },
				};
			}

			const dest = record.target === "daily" && record.date ? dailyPath(record.date) : MEMORY_FILE;
			const existing = readFileSafe(dest) ?? "";
			const block = record.removedContent.join("\n\n");
			const separator = existing.trim() ? "\n\n" : "";
			writeFileAtomic(dest, existing + separator + block + (block.endsWith("\n") ? "" : "\n"));
			record.restoredAt = new Date().toISOString();
			fs.writeFileSync(recoveryFile, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
			refreshMemorySnapshot("memory_restore");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [
					{
						type: "text" as const,
						text: `Restored ${record.removedContent.length} entr(y/ies) to ${dest}`,
					},
				],
				details: { recoveryId: record.id, path: dest },
			};
		},
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search this project's memory via qmd (keyword | semantic | deep).",
			"Uses the per-project qmd collection for <project>/.pi/memory/ — never the global pi-memory collection.",
			"Keyword mode is best for #tags and [[wiki-links]].",
			"See memory_status for the active collection name.",
		].join("\n"),
		parameters: Type.Object({
			query: Type.String(),
			mode: Type.Optional(StringEnum(["keyword", "semantic", "deep"] as const)),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params): Promise<ToolOut> {
			if (!qmdAvailable) qmdAvailable = await detectQmd();
			if (!qmdAvailable) {
				return {
					content: [{ type: "text" as const, text: qmdInstallInstructions() }],
					isError: true,
					details: {},
				};
			}

			let hasCollection = await checkCollection(COLLECTION_NAME);
			if (!hasCollection) hasCollection = await setupQmdCollection();
			if (!hasCollection) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not set up qmd collection ${COLLECTION_NAME} for ${MEMORY_DIR}`,
						},
					],
					isError: true,
					details: {},
				};
			}

			const mode: "keyword" | "semantic" | "deep" = (params.mode ?? "keyword") as
				| "keyword"
				| "semantic"
				| "deep";
			const limit = clampSearchLimit(params.limit);
			const searchStartTime = Date.now();
			try {
				let { results, stderr } = await runQmdSearch(mode, params.query, limit);
				let relaxedQuery: string | undefined;
				// Keyword mode fallback: qmd search is conjunctive, so natural-
				// language queries with function words return zero. Retry with
				// derived content-word candidates before giving up.
				if (mode === "keyword" && results.length === 0) {
					for (const candidate of deriveQueryCandidates(params.query).slice(1, 6)) {
						const retry = await runQmdSearch(mode, candidate, limit);
						if (retry.results.length > 0) {
							results = retry.results;
							relaxedQuery = candidate;
							break;
						}
					}
				}
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;
				const searchDurationMs = Date.now() - searchStartTime;

				recordSearchTelemetry({
					mode,
					querySnippet: params.query,
					hits: results.length,
					durationMs: searchDurationMs,
				});
				logDebug(
					`search (${mode}): ${results.length} hit(s) for "${params.query}" in ${searchDurationMs}ms`,
				);

				if (results.length === 0) {
					const embedHint =
						needsEmbed && (mode === "semantic" || mode === "deep")
							? embedStarted
								? "\n\nEmbeddings building in background — retry shortly."
								: "\n\nRun: qmd embed"
							: "";
					return {
						content: [
							{
								type: "text" as const,
								text: `No results for "${params.query}" (mode: ${mode}, collection: ${COLLECTION_NAME}).${embedHint}`,
							},
						],
						details: { mode, collection: COLLECTION_NAME, count: 0, needsEmbed, relaxedQuery },
				// NOTE: relaxedQuery on a hit is reported in details below
					};
				}

				const formatted = results
					.map((r, i) => {
						const parts = [`### Result ${i + 1}`];
						const fp = getQmdResultPath(r);
						if (fp) parts.push(`**File:** ${fp}`);
						if (r.score != null) parts.push(`**Score:** ${r.score}`);
						const text = getQmdResultText(r);
						if (text) parts.push(`\n${text}`);
						return parts.join("\n");
					})
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { mode, collection: COLLECTION_NAME, count: results.length, needsEmbed, relaxedQuery },
				};
			} catch (err) {
				const searchDurationMs = Date.now() - searchStartTime;
				recordSearchTelemetry({
					mode,
					querySnippet: params.query,
					hits: 0,
					durationMs: searchDurationMs,
					error: err instanceof Error ? err.message : String(err),
				});
				logDebug(`search error (${mode}) for "${params.query}" after ${searchDurationMs}ms:`, err);
				return {
					content: [
						{
							type: "text" as const,
							text: `memory_search error: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
					details: {},
				};
			}
		},
	});

	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: "Show project binding, store inventory, qmd health, and telemetry metrics.",
		parameters: Type.Object({
			details: Type.Optional(
				Type.Boolean({
					description: "Include detailed recent queries and compaction history (default: false)",
				}),
			),
		}),
		async execute(_id, params): Promise<ToolOut> {
			ensureDirs();
			const inv = getMemoryInventory();
			const telemetry = readTelemetry();
			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection(COLLECTION_NAME);
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}
			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const rStats = telemetry.retrievalStats;
			const hitRate = rStats.totalTurns > 0 ? Math.round((rStats.hits / rStats.totalTurns) * 100) : 0;
			const lastCompaction = telemetry.compactionHistory[0];

			const lines = [
				"# Memory status (project-scoped PoC)",
				"",
				`- Project root: ${inv.projectRoot}`,
				`- Memory dir: ${inv.dir}`,
				`- Collection: \`${inv.collectionName}\``,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Knowledge dossiers: ${inv.knowledgeCount} files`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				`- Archived daily logs: ${inv.archivedDailyCount} files`,
				"",
				"## Search (qmd)",
				`- qmd available: ${mark(qmdOk)}`,
			];
			if (qmdOk) {
				lines.push(`- Collection ready: ${mark(collectionOk)}`);
				if (collectionOk) lines.push(`- Embeddings: ${embeddings}`);
			} else {
				lines.push("", qmdInstallInstructions());
			}

			lines.push(
				"",
				"## Metrics & Diagnostics",
				`- Auto-Retrievals: ${rStats.totalTurns} turns (${rStats.hits} hits, ${rStats.misses} misses, ${hitRate}% hit rate, ${rStats.timeouts} timeouts)`,
				`- Avg Retrieval Latency: ${rStats.avgDurationMs}ms`,
				`- Explicit Searches: ${telemetry.searchStats.totalSearches} (avg ${telemetry.searchStats.avgDurationMs}ms)`,
				`- Compactions: ${telemetry.compactionHistory.length} total runs`,
			);

			if (lastCompaction) {
				lines.push(
					`- Last Compaction: ${lastCompaction.timestamp} (${lastCompaction.beforeChars} → ${lastCompaction.afterChars} chars, ${lastCompaction.supersededCount} superseded, in ${lastCompaction.durationMs}ms)`,
				);
			}

			if (params?.details) {
				if (telemetry.compactionHistory.length > 0) {
					lines.push("", "### Recent Compactions");
					for (const c of telemetry.compactionHistory.slice(0, 5)) {
						lines.push(
							`  - [${c.timestamp}] ${c.reason}: ${c.beforeChars} → ${c.afterChars} chars (${c.supersededCount} superseded, ${c.knowledgeCreatedCount} knowledge) in ${c.durationMs}ms`,
						);
					}
				}
				if (rStats.recentSearches.length > 0) {
					lines.push("", "### Recent Turn Retrievals");
					for (const s of rStats.recentSearches.slice(0, 5)) {
						lines.push(
							`  - [${s.timestamp}] ${s.durationMs}ms | hits: ${s.hits} | candidate: "${s.winnerCandidate || "none"}" | prompt: "${s.promptSnippet}"`,
						);
					}
				}
				if (telemetry.searchStats.recentQueries.length > 0) {
					lines.push("", "### Recent Explicit Searches");
					for (const q of telemetry.searchStats.recentQueries.slice(0, 5)) {
						lines.push(
							`  - [${q.timestamp}] ${q.mode} | ${q.durationMs}ms | hits: ${q.hits} | query: "${q.querySnippet}"${q.error ? ` | error: ${q.error}` : ""}`,
						);
					}
				}
			}

			lines.push(
				"",
				"## Config",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_RETRIEVE: ${isRetrieveEnabled() ? "on" : "off"}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_DEBUG: ${isDebugEnabled() ? "on" : "off"}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default (.pi/memory under project)"}`,
				`- PI_MEMORY_PROJECT_ROOT: ${process.env.PI_MEMORY_PROJECT_ROOT ? "set" : "auto (git root / cwd)"}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { ...inv, qmd: qmdOk, collection: collectionOk, embeddings, telemetry },
			};
		},
	});
}
