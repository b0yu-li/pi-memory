/**
 * Project-scoped memory extension for pi.
 *
 * Storage: <projectRoot>/.pi/memory/ (not ~/.pi/agent/memory)
 * Search:  one qmd collection per project root
 *
 * See design.md for job boundaries vs ref/pi-memory.
 */

import { type ExecFileOptions, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
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
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");

export function bindProject(cwd: string, env: MemoryEnv = process.env): {
	projectRoot: string;
	memoryDir: string;
	collectionName: string;
} {
	PROJECT_ROOT = resolveProjectRoot(cwd, env);
	MEMORY_DIR = resolveMemoryDir(PROJECT_ROOT, env);
	COLLECTION_NAME = collectionNameForProject(PROJECT_ROOT);
	MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
	DAILY_DIR = path.join(MEMORY_DIR, "daily");
	RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");
	return { projectRoot: PROJECT_ROOT, memoryDir: MEMORY_DIR, collectionName: COLLECTION_NAME };
}

/** Test helper — force paths. */
export function _setPaths(projectRoot: string, memoryDir?: string) {
	PROJECT_ROOT = path.resolve(projectRoot);
	MEMORY_DIR = memoryDir ? path.resolve(memoryDir) : path.join(PROJECT_ROOT, ".pi", "memory");
	COLLECTION_NAME = collectionNameForProject(PROJECT_ROOT);
	MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
	DAILY_DIR = path.join(MEMORY_DIR, "daily");
	RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");
}

export function _getBinding() {
	return {
		projectRoot: PROJECT_ROOT,
		memoryDir: MEMORY_DIR,
		collectionName: COLLECTION_NAME,
		memoryFile: MEMORY_FILE,
		scratchpadFile: SCRATCHPAD_FILE,
		dailyDir: DAILY_DIR,
		recoveryDir: RECOVERY_DIR,
	};
}

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
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

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;
const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_MAX_CHARS = 16_000;

type TruncateMode = "start" | "end" | "middle";

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
	if (mode === "end") return { text: text.slice(-maxChars), truncated: true };
	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}
	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(
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
// Job 2/3 — Scratchpad + forget/restore helpers
// ---------------------------------------------------------------------------

export interface ScratchpadItem {
	done: boolean;
	text: string;
	meta: string;
}

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MemoryTarget = "long_term" | "daily";

interface RecoveryRecord {
	version: 1;
	id: string;
	createdAt: string;
	target: MemoryTarget;
	date?: string;
	removedContent: string[];
	restoredAt?: string;
}

export function parseScratchpad(content: string): ScratchpadItem[] {
	const items: ScratchpadItem[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) meta = lines[i - 1];
			items.push({ done: match[1].toLowerCase() === "x", text: match[2], meta });
		}
	}
	return items;
}

export function serializeScratchpad(items: ScratchpadItem[]): string {
	const lines: string[] = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) lines.push(item.meta);
		lines.push(`- [${item.done ? "x" : " "}] ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function scratchpadAdd(content: string, text: string, meta: string): string {
	if (!content.trim()) return serializeScratchpad([{ done: false, text, meta }]);
	return `${content.replace(/\n+$/, "")}\n${meta}\n- [ ] ${text}\n`;
}

export function scratchpadToggle(
	content: string,
	needle: string,
	done: boolean,
): { content: string; matched: boolean } {
	const lines = content.split("\n");
	const lower = needle.toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SCRATCHPAD_ITEM_REGEX);
		if (!m) continue;
		if ((m[1].toLowerCase() === "x") === done) continue;
		if (!m[2].toLowerCase().includes(lower)) continue;
		lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
		return { content: lines.join("\n"), matched: true };
	}
	return { content, matched: false };
}

export function scratchpadClearDone(content: string): { content: string; removed: number } {
	const lines = content.split("\n");
	const out: string[] = [];
	let removed = 0;
	for (const line of lines) {
		const m = line.match(SCRATCHPAD_ITEM_REGEX);
		if (m && m[1].toLowerCase() === "x") {
			removed++;
			if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1])) out.pop();
			continue;
		}
		out.push(line);
	}
	return { content: out.join("\n"), removed };
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
		(record.target === "long_term" || record.target === "daily") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.length > 0 &&
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
// Job 4 — Context injection
// ---------------------------------------------------------------------------

export function buildMemoryContext(): string {
	ensureDirs();
	const sections: string[] = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serializeScratchpad(openItems),
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

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

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
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

let memorySnapshot: string | null = null;
let snapshotDirty = false;
let snapshotTakenOnDate: string | null = null;
let snapshotReason = "";

function refreshMemorySnapshot(reason: string) {
	memorySnapshot = buildMemoryContext();
	snapshotDirty = false;
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
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
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name: string = COLLECTION_NAME): Promise<boolean> {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}
	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000, encoding: "utf8" }, (err, stdout) => {
			let exists = false;
			const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
			if (!err) {
				try {
					const collections = JSON.parse(out);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return (entry as { name?: string }).name === name;
							}
							return false;
						});
					} else {
						exists = out.includes(name);
					}
				} catch {
					exists = out.includes(name);
				}
			}
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

export function runQmdSearch(
	mode: "keyword" | "semantic" | "deep",
	query: string,
	limit: number,
	timeoutOverrideMs?: number,
): Promise<{ results: QmdSearchResult[]; stderr: string }> {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", COLLECTION_NAME, "-n", String(limit), query];
	const timeoutMs = timeoutOverrideMs ?? getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		execFileFn(
			"qmd",
			args,
			{ timeout: timeoutMs, encoding: "utf8" } as ExecFileOptions,
			(err, stdout, stderr) => {
				const out = typeof stdout === "string" ? stdout : String(stdout ?? "");
				const errOut = typeof stderr === "string" ? stderr : String(stderr ?? "");
				if (err) {
					const cleaned = stripAnsi(errOut).trim() || stripAnsi(err.message).trim();
					const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
					const hint = timedOut
						? ` (qmd timed out after ${timeoutMs / 1000}s — retry shortly)`
						: "";
					reject(new Error(`${cleaned}${hint}`));
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


type ToolOut = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: true;
};

/** Unify tool result shapes so registerTool inference stays happy. */
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
	const scratchpad = readFileSafe(SCRATCHPAD_FILE) ?? "";
	const items = parseScratchpad(scratchpad);
	let dailyFiles: string[] = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	return {
		projectRoot: PROJECT_ROOT,
		dir: MEMORY_DIR,
		collectionName: COLLECTION_NAME,
		longTermChars: longTerm.trim().length,
		scratchpadOpen: items.filter((i) => !i.done).length,
		scratchpadTotal: items.length,
		dailyCount: dailyFiles.length,
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
	});

	pi.on("before_agent_start", async (event) => {
		const mode = getSnapshotMode();
		if (mode === "refresh") {
			const today = todayStr();
			if (memorySnapshot === null || snapshotDirty || snapshotTakenOnDate !== today) {
				refreshMemorySnapshot(snapshotDirty ? "long_term_write" : "day_rollover");
			}
		} else if (memorySnapshot === null) {
			refreshMemorySnapshot("before_agent_start");
		}

		const memoryContext = memorySnapshot ?? "";
		if (!memoryContext) return;

		const caveat =
			mode === "refresh"
				? `Snapshot ${snapshotReason}. Use memory_read / memory_search for latest state.`
				: "Loaded once at session start. Use memory_read / memory_search for authoritative latest state.";

		const header = [
			"\n\n## Memory",
			`(${caveat})`,
			`Project root: ${PROJECT_ROOT}`,
			`Store: ${MEMORY_DIR}`,
			"Use memory_write to persist important information.",
			"- Decisions / preferences / durable facts → MEMORY.md",
			"- Day-to-day notes → daily/<YYYY-MM-DD>.md",
			"- Checklist items → scratchpad tool",
			"- Search past context → memory_search (keyword | semantic | deep)",
			'- If someone says "remember this," write it immediately.',
			"",
			memoryContext,
		].join("\n");

		return { systemPrompt: event.systemPrompt + header };
	});

	// --- memory_write ---
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: [
			"Write to this project's memory files under .pi/memory/.",
			"- 'long_term': MEMORY.md (append or overwrite)",
			"- 'daily': today's daily log (always append)",
			"Use #tags and [[links]] for searchability.",
		].join("\n"),
		parameters: Type.Object({
			target: StringEnum(["long_term", "daily"] as const, {
				description: "Where to write",
			}),
			content: Type.String({ description: "Markdown content" }),
			mode: Type.Optional(
				StringEnum(["append", "overwrite"] as const, {
					description: "long_term only. Default: append",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolOut> {
			ensureDirs();
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();
			const { target, content, mode } = params;

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
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

			snapshotDirty = true;
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			if (mode === "overwrite") {
				fs.writeFileSync(MEMORY_FILE, `<!-- last updated: ${ts} [${sid}] -->\n${content}`, "utf-8");
			} else {
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
			}
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			if (getSnapshotMode() === "refresh") refreshMemorySnapshot("long_term_write");
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

	// --- scratchpad ---
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description: "Project checklist: add | done | undo | clear_done | list",
		parameters: Type.Object({
			action: StringEnum(["add", "done", "undo", "clear_done", "list"] as const),
			text: Type.Optional(Type.String({ description: "Item text or substring match" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolOut> {
			ensureDirs();
			const sid = shortSessionId(ctx.sessionManager.getSessionId());
			const ts = nowTimestamp();
			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			const items = parseScratchpad(existing);

			if (params.action === "list") {
				if (items.length === 0) {
					return { content: [{ type: "text" as const, text: "Scratchpad is empty." }], details: {} };
				}
				return {
					content: [
						{
							type: "text" as const,
							text: formatPreviewBlock("Scratchpad", serializeScratchpad(items), "start"),
						},
					],
					details: { count: items.length, open: items.filter((i) => !i.done).length },
				};
			}

			if (params.action === "add") {
				if (!params.text) {
					return {
						content: [{ type: "text" as const, text: "Error: 'text' required for add." }],
						isError: true,
						details: {},
					};
				}
				const serialized = scratchpadAdd(existing, params.text, `<!-- ${ts} [${sid}] -->`);
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text" as const, text: `Added: - [ ] ${params.text}` }],
					details: { path: SCRATCHPAD_FILE },
				};
			}

			if (params.action === "done" || params.action === "undo") {
				if (!params.text) {
					return {
						content: [{ type: "text" as const, text: `Error: 'text' required for ${params.action}.` }],
						isError: true,
						details: {},
					};
				}
				const { content, matched } = scratchpadToggle(existing, params.text, params.action === "done");
				if (!matched) {
					return {
						content: [{ type: "text" as const, text: `No matching open/done item for: ${params.text}` }],
						isError: true,
						details: {},
					};
				}
				fs.writeFileSync(SCRATCHPAD_FILE, content, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					content: [{ type: "text" as const, text: `${params.action}: matched "${params.text}"` }],
					details: {},
				};
			}

			// clear_done
			const { content, removed } = scratchpadClearDone(existing);
			fs.writeFileSync(SCRATCHPAD_FILE, content, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				content: [{ type: "text" as const, text: `Cleared ${removed} done item(s).` }],
				details: { removed },
			};
		},
	});

	// --- memory_read ---
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: "Read MEMORY.md, SCRATCHPAD.md, a daily log, or list daily dates.",
		parameters: Type.Object({
			target: StringEnum(["long_term", "scratchpad", "daily", "list_daily"] as const),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD for daily (default: today)" })),
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

			let filePath: string;
			if (params.target === "long_term") filePath = MEMORY_FILE;
			else if (params.target === "scratchpad") filePath = SCRATCHPAD_FILE;
			else {
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
			return {
				content: [{ type: "text" as const, text: content }],
				details: { path: filePath, chars: content.length },
			};
		},
	});

	// --- memory_forget ---
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
			const target: MemoryTarget = params.target ?? "long_term";
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
			fs.writeFileSync(filePath, result.content, "utf-8");
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

	// --- memory_restore ---
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

			const dest =
				record.target === "daily" && record.date ? dailyPath(record.date) : MEMORY_FILE;
			const existing = readFileSafe(dest) ?? "";
			const block = record.removedContent.join("\n\n");
			const separator = existing.trim() ? "\n\n" : "";
			fs.writeFileSync(dest, existing + separator + block + (block.endsWith("\n") ? "" : "\n"), "utf-8");
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

	// --- memory_search ---
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: [
			"Search this project's memory via qmd (keyword | semantic | deep).",
			"Uses the per-project qmd collection for <project>/.pi/memory/ — never the global pi-memory collection.",
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

			const mode = params.mode ?? "keyword";
			const limit = clampSearchLimit(params.limit);
			try {
				const { results, stderr } = await runQmdSearch(mode, params.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

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
						details: { mode, collection: COLLECTION_NAME, count: 0, needsEmbed },
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
					details: { mode, collection: COLLECTION_NAME, count: results.length, needsEmbed },
				};
			} catch (err) {
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

	// --- memory_status ---
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: "Show project binding, store inventory, and qmd/collection health.",
		parameters: Type.Object({}),
		async execute(): Promise<ToolOut> {
			ensureDirs();
			const inv = getMemoryInventory();
			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings: "ready" | "missing" | "unknown" | "n/a" = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection(COLLECTION_NAME);
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}
			const mark = (ok: boolean) => (ok ? "✓" : "✗");
			const lines = [
				"# Memory status (project-scoped)",
				"",
				`- Project root: ${inv.projectRoot}`,
				`- Memory dir: ${inv.dir}`,
				`- Collection: \`${inv.collectionName}\``,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
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
				"## Config",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default (.pi/memory under project)"}`,
				`- PI_MEMORY_PROJECT_ROOT: ${process.env.PI_MEMORY_PROJECT_ROOT ? "set" : "auto (git root / cwd)"}`,
			);
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { ...inv, qmd: qmdOk, collection: collectionOk, embeddings },
			};
		},
	});
}
