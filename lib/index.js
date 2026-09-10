/** dsh-sidebar host half — SRC-typert gateway over fs/shell/subprocess, terminal pool, plugin apply. */

import { Service } from "@deepseek-ai/cordis";

/** Remote method descriptor key read by the Typert Gateway's source-mode discovery. */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** Maximum file size readable through the panel (bytes). */
const MAX_READ_BYTES = 1024 * 1024;
/** Diff/status output cap per git invocation (bytes). */
const MAX_DIFF_BYTES = 256 * 1024;
/** Per-terminal scrollback ring size (bytes). */
const TERM_RING_BYTES = 512 * 1024;
/** Long-poll hold time before an idle termRead returns (ms). */
const TERM_WAIT_MS = 15000;
/** Shell foreground timeout for git calls (ms). */
const GIT_TIMEOUT_MS = 15000;

/** Mark one prototype method as a direct-invocation Remote method (hand-rolled @Remote). */
function markRemote(prototype, method) {
	const current = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	const previous = current !== void 0 ? current.value : void 0;
	const methods = previous !== void 0 && previous !== null ? [...previous.methods, Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) })] : [Object.freeze({ method, invocation: Object.freeze({ kind: "direct" }) })];
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({ version: 1, methods: Object.freeze(methods) })
	});
}

/** Typed gateway failure; a plain Error surfaces to clients as gateway/internal. */
class SidebarError extends Error {
	constructor(message, details) {
		super(message);
		this.name = "SidebarError";
		this.details = details;
	}
}

/** Normalize any thrown value into a JSON-safe error record. */
function errorRecord(error) {
	return { code: "dsh-sidebar/error", message: error instanceof Error ? error.message : String(error) };
}

/** Clamp a text buffer to its byte tail, tracking truncation. */
function tail(buffer, maxBytes) {
	if (buffer.length <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
	const cut = buffer.subarray(buffer.length - maxBytes);
	// Drop a partial leading UTF-8 sequence so the tail decodes cleanly.
	let start = 0;
	while (start < cut.length && (cut[start] & 0xc0) === 0x80) start += 1;
	return { text: cut.subarray(start).toString("utf8"), truncated: true };
}

/** Trim trailing slashes and the git-dir suffix from a git common dir path. */
function repoBasename(gitDirPath) {
	const trimmed = gitDirPath.replace(/\/+$/, "");
	// normal repo: "<root>/.git"; bare repo: "<root>.git" (no inner .git dir)
	const withoutGit = trimmed.endsWith("/.git")
		? trimmed.slice(0, -5)
		: trimmed.endsWith(".git")
			? trimmed.slice(0, -4)
			: trimmed;
	const base = withoutGit.split("/").filter(Boolean).pop() || withoutGit;
	return { name: base, root: withoutGit };
}

/** Normalize one path for comparison: trailing-slash trim. */
function samePath(a, b) {
	return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/**
 * Parse `git worktree list --porcelain` blocks into repo rows and locate the
 * caller's worktree. Blocks are `worktree <path>` / `HEAD <sha>` /
 * `branch refs/heads/<name>` / `bare` in any order; the branch line is absent
 * when detached and the HEAD line absent in a fresh repo. The current row is
 * matched by exact path first, then by path prefix so a workspace registered
 * inside a repo subdirectory still lands.
 * @param text - porcelain output (may be empty).
 * @param currentPath - workspace root to mark as current ("" disables matching).
 * @returns worktree rows plus the matched current row (or null).
 */
function parseWorktreeList(text, currentPath) {
	const rows = [];
	let current = null;
	const blocks = String(text || "").split("\n\n");
	for (const block of blocks) {
		const lines = block.split("\n").filter((line) => line.length > 0);
		if (lines.length === 0) continue;
		const row = { path: "", branch: null, head: null, bare: false, isCurrent: false };
		for (const line of lines) {
			if (line.startsWith("worktree ")) row.path = line.slice("worktree ".length);
			else if (line.startsWith("HEAD ")) row.head = line.slice("HEAD ".length);
			else if (line.startsWith("branch refs/heads/")) row.branch = line.slice("branch refs/heads/".length);
			else if (line === "bare") row.bare = true;
		}
		if (!row.path) continue;
		row.isCurrent = currentPath !== "" && samePath(row.path, currentPath);
		if (row.isCurrent && current === null) current = row;
		rows.push(row);
	}
	// prefix match: the workspace sits inside a worktree (repo subdirectory)
	if (current === null && currentPath !== "") {
		const normalized = currentPath.replace(/\/+$/, "");
		for (const row of rows) {
			const root = row.path.replace(/\/+$/, "");
			if (root !== "" && normalized.startsWith(root + "/")) {
				row.isCurrent = true;
				current = row;
				break;
			}
		}
	}
	return { worktrees: rows, current };
}

/** Git repo identity for the diff view (name, branch, worktrees) or null. */
function repoInfo(toplevel, commonDir, worktreeText, workspacePath) {
	const common = repoBasename(commonDir);
	const root = String(toplevel || "").replace(/\/+$/, "");
	const parsed = parseWorktreeList(worktreeText, workspacePath);
	const current = parsed.current;
	return {
		name: common.name,
		root,
		branch: current ? current.branch : null,
		detached: current ? current.branch === null : false,
		sha: current ? current.head : null,
		isWorktree: root !== "" && common.root !== "" && !samePath(root, common.root),
		mainRoot: common.root,
		worktrees: parsed.worktrees
	};
}

/**
 * Ring-buffered scrollback for one PTY terminal. The PassThrough output is
 * pumped continuously so bytes land in the ring even between client polls;
 * reads drain from a caller-supplied byte offset.
 */
class TerminalBuffer {
	constructor(maxBytes) {
		this.chunks = [];
		this.length = 0;
		this.maxBytes = maxBytes;
		this.dropped = 0;
		this.wake = null;
	}
	push(data) {
		if (data.length === 0) return;
		this.chunks.push(data);
		this.length += data.length;
		while (this.length > this.maxBytes && this.chunks.length > 1) {
			const drop = this.chunks[0];
			this.chunks.shift();
			this.length -= drop.length;
			this.dropped += drop.length;
		}
		if (this.length > this.maxBytes) {
			// A single chunk exceeded the whole ring: keep its tail only.
			const head = this.chunks[0];
			const excess = this.length - this.maxBytes;
			this.chunks[0] = head.subarray(excess);
			this.length -= excess;
			this.dropped += excess;
		}
		// release any long-poll read waiting for data
		if (this.wake !== null) {
			const resolve = this.wake;
			this.wake = null;
			resolve();
		}
	}
	read(fromByte) {
		let skipped = 0;
		const parts = [];
		for (const chunk of this.chunks) {
			const chunkStart = this.dropped + skipped;
			const chunkEnd = chunkStart + chunk.length;
			if (chunkEnd <= fromByte) { skipped += chunk.length; continue; }
			const offset = fromByte > chunkStart ? fromByte - chunkStart : 0;
			parts.push(chunk.subarray(offset));
			skipped += chunk.length;
		}
		const merged = Buffer.concat(parts);
		const out = tail(merged, this.maxBytes);
		return { text: out.text, truncated: this.dropped > 0 || out.truncated };
	}
	get end() {
		return this.dropped + this.length;
	}
}

/**
 * One live PTY terminal: the handle's output stream is pumped into a ring
 * buffer, the exit promise flips the banner, and teardown terminates the shell.
 */
class LiveTerminal {
	constructor(handle, maxBytes, dispose) {
		this.handle = handle;
		this.buffer = new TerminalBuffer(maxBytes);
		this.exited = false;
		this.outcome = null;
		this.dispose = dispose;
		const onExit = () => {
			this.exited = true;
		};
		const settle = (outcome) => {
			this.outcome = outcome;
			onExit();
		};
		handle.done.then(settle, settle);
		const pump = (data) => {
			this.buffer.push(Buffer.from(data, "utf8"));
		};
		handle.output.on("data", pump);
		handle.done.then(async () => {
			handle.output.off("data", pump);
			await this.dispose();
		}, async () => {
			handle.output.off("data", pump);
			await this.dispose();
		});
	}
}

/**
 * SRC-typert gateway service (`sidebarFs`). Exposes workspace-aware file
 * listing/reading, git diffs, and PTY terminal management to the web panel
 * through the /api channel's source-mode reflection: the class prototype
 * carries the Remote-method markers, the instance carries the visible
 * `typertRemote` binding, and every method returns JSON-safe values only.
 */
class SidebarGateway extends Service {
	constructor(ctx) {
		super(ctx, "sidebarFs");
		this.terminals = new Map();
		this.nextTermId = 1;
		this.typertRemote = Object.freeze({
			service: this,
			serviceKey: "sidebarFs",
			namespace: "sidebarFs"
		});
		this.poolDisposer = ctx.effect(() => () => {
			const pending = [];
			for (const terminal of this.terminals.values()) pending.push(terminal.handle.terminate().catch(() => {}));
			this.terminals.clear();
			return Promise.all(pending).then(() => {});
		}, "dsh-sidebar: terminal pool");
	}

	/** Resolve one path and assert it stays inside the workspace root. */
	async inside(rootPath, targetPath) {
		const fs = this.ctx.fs;
		const root = await fs.resolve(rootPath);
		const target = await fs.resolve(targetPath);
		if (!fs.contains(root, target)) throw new SidebarError(`dsh-sidebar: path "${targetPath}" escapes the workspace root "${rootPath}"`);
		return { root, target };
	}

	/** Containment check against every registered workspace (panel-level guard). */
	async ensureRegistered(targetPath) {
		const registry = this.ctx.workspaceRegistry;
		const workspaces = registry.list();
		const fs = this.ctx.fs;
		const target = await fs.resolve(targetPath);
		for (const workspace of workspaces) {
			const root = await fs.resolve(workspace.path);
			if (fs.contains(root, target)) return target;
		}
		throw new SidebarError(`dsh-sidebar: path "${targetPath}" is outside every registered workspace`);
	}

	/**
	 * List direct children of one directory inside a registered workspace.
	 * @param path - absolute or fs-cwd-relative directory path.
	 * @param signal - aborts the listing.
	 * @returns name/type/size/child-path rows in stable order.
	 */
	async listDir(path, signal) {
		const fs = this.ctx.fs;
		const target = await this.ensureRegistered(path);
		const entries = await fs.listDir(target, signal);
		const dirPrefix = target.targetKey.endsWith("/") ? target.targetKey : `${target.targetKey}/`;
		return entries.map((entry) => ({
			name: entry.name,
			type: entry.type,
			...entry.type === "file" && Number.isFinite(entry.size) ? { size: entry.size } : {},
			path: `${dirPrefix}${entry.name}`
		}));
	}

	/**
	 * Read one text file, capped at 1 MiB with an explicit truncation flag.
	 * @param path - absolute or fs-cwd-relative file path.
	 * @param maxBytes - optional byte cap (default 1 MiB).
	 * @param signal - aborts the read.
	 * @returns content plus truncation state.
	 */
	async readText(path, maxBytes, signal) {
		const fs = this.ctx.fs;
		const target = await this.ensureRegistered(path);
		const info = await fs.lstat(path, {}, signal);
		const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, MAX_READ_BYTES) : MAX_READ_BYTES;
		if (info !== void 0 && info.type === "file" && info.size > MAX_READ_BYTES) {
			return { content: "", truncated: true, size: info.size, tooLarge: true };
		}
		const content = await fs.readText(target, signal);
		const limited = tail(Buffer.from(content, "utf8"), cap);
		return { content: limited.text, truncated: limited.truncated || (info !== void 0 && info.type === "file" && info.size > cap), size: info !== void 0 && info.type === "file" ? info.size : undefined };
	}

	/**
	 * Git status plus unified diff for one workspace root, plus repo identity
	 * (name, current branch, worktree state) for the panel's diff view.
	 * @param workspacePath - absolute path of the workspace root.
	 * @param signal - aborts the git calls.
	 * @returns porcelain status rows, combined unstaged+cached diff, truncation,
	 *   and a repo row (or null when the workspace is not a git repo or the
	 *   identity probes fail — repo info never breaks the diff itself).
	 */
	async diff(workspacePath, signal) {
		const shell = this.ctx.shell;
		const root = await this.ensureRegistered(workspacePath);
		const workdir = root.targetKey;
		const runGit = async (command) => shell.run(shell.resolve({
			command,
			workdir,
			stdoutMaxBytes: MAX_DIFF_BYTES,
			timeoutMs: GIT_TIMEOUT_MS,
			...(signal !== void 0 ? { signal } : {})
		}));
		const statusRun = await runGit("git -c core.quotepath=false status --porcelain=v1");
		if (statusRun.exitCode !== 0) return { isGit: false, status: [], diff: "", truncated: false, repo: null };
		const status = statusRun.stdout.text.split("\n").filter((line) => line.length >= 4).map((line) => ({
			code: line.slice(0, 2),
			path: line.slice(3)
		}));
		const unstaged = await runGit("git -c core.quotepath=false diff --no-color");
		const cached = await runGit("git -c core.quotepath=false diff --no-color --cached");
		const combined = `${unstaged.stdout.text}\n${cached.stdout.text}`;
		const limited = tail(Buffer.from(combined, "utf8"), MAX_DIFF_BYTES);
		// repo identity probes: read-only and best-effort
		let repo = null;
		try {
			const [toplevelRun, worktreeRun] = await Promise.all([
				runGit("git rev-parse --show-toplevel --path-format=absolute --git-common-dir"),
				runGit("git worktree list --porcelain")
			]);
			if (toplevelRun.exitCode === 0 && worktreeRun.exitCode === 0) {
				const lines = toplevelRun.stdout.text.split("\n").filter((line) => line.length > 0);
				if (lines.length >= 2) {
					repo = repoInfo(lines[0], lines[1], worktreeRun.stdout.text, workdir);
				}
			}
		} catch {
			repo = null;
		}
		return { isGit: true, status, diff: limited.text, truncated: limited.truncated || unstaged.stdout.truncated || cached.stdout.truncated, repo };
	}

	/**
	 * Spawn one interactive bash PTY for a workspace root (one per workspace).
	 * Sandbox-confined when the deployment policy is not danger-full-access.
	 * @param workspacePath - absolute path of the workspace root (also the cwd).
	 * @param signal - aborts the spawn.
	 * @returns terminal id plus the shell banner line.
	 */
	async termSpawn(workspacePath, signal) {
		const subprocess = this.ctx.subprocess;
		const policy = this.ctx.sandboxPolicy.resolve();
		const root = await this.ensureRegistered(workspacePath);
		const cwd = root.targetKey;
		let argv = ["/bin/bash", "--noprofile", "--norc", "-i"];
		if (policy.mode !== "danger-full-access") {
			const sandbox = this.ctx.get("sandbox");
			if (sandbox === void 0) throw new SidebarError(`dsh-sidebar: sandbox mode "${policy.mode}" requires a ctx.sandbox provider in the execution world`);
			argv = sandbox.confine(argv, { ...policy, mode: policy.mode }).argv;
		}
		// One terminal per workspace: reusing the id keeps scrollback alive
		// across panel toggles; a dead terminal respawns fresh.
		for (const [id, terminal] of this.terminals) {
			if (terminal.workspacePath === cwd && !terminal.exited) return { id, motd: `dsh-sidebar: terminal ${id} (pid ${terminal.handle.pid})` };
		}
		const handle = await subprocess.spawnTerminal({
			argv,
			cwd,
			rows: 30,
			cols: 100,
			graceMs: 3000,
			env: { TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", PS1: "dsh> " },
			...(signal !== void 0 ? { signal } : {})
		});
		const id = `t${this.nextTermId}`;
		this.nextTermId += 1;
		const workspacePathKey = cwd;
		const terminal = new LiveTerminal(handle, TERM_RING_BYTES, async () => {
			const current = this.terminals.get(id);
			if (current === terminal) this.terminals.delete(id);
		});
		terminal.workspacePath = workspacePathKey;
		this.terminals.set(id, terminal);
		return { id, motd: `dsh-sidebar: terminal ${id} (pid ${handle.pid})` };
	}

	/**
	 * Read terminal output since a caller byte offset. Long-polls: when no new
	 * bytes are available the read holds (woken by the next push, exit, or a
	 * TERM_WAIT_MS timeout) so echo latency is one round trip, not a poll.
	 * @param termId - terminal id from termSpawn.
	 * @param fromByte - caller's read cursor (default 0).
	 * @param signal - aborts the read.
	 * @returns new text plus truncation state.
	 */
	async termRead(termId, fromByte, signal) {
		const terminal = this.terminals.get(termId);
		if (terminal === void 0) throw new SidebarError(`dsh-sidebar: unknown terminal "${termId}"`);
		const start = Number.isFinite(fromByte) && fromByte >= 0 ? fromByte : 0;
		const hasNew = () => terminal.buffer.end > start || terminal.exited || (signal !== void 0 && signal.aborted);
		if (!hasNew()) {
			await new Promise((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					if (terminal.buffer.wake === resolve) terminal.buffer.wake = null;
					resolve();
				};
				const timer = setTimeout(finish, TERM_WAIT_MS);
				// hold until bytes arrive, the shell exits, or the caller aborts
				terminal.buffer.wake = resolve;
				if (signal !== void 0) signal.addEventListener("abort", finish, { once: true });
				// a push or exit may have landed while we set up the hold
				if (hasNew()) finish();
			});
		}
		const read = terminal.buffer.read(start);
		return { ...read, exited: terminal.exited, outcome: terminal.outcome, end: terminal.buffer.end };
	}

	/**
	 * Write text (or one control byte) to a terminal's stdin.
	 * @param termId - terminal id from termSpawn.
	 * @param text - exact bytes to write.
	 * @param signal - aborts the write.
	 * @returns write acknowledgement.
	 */
	async termWrite(termId, text, signal) {
		const terminal = this.terminals.get(termId);
		if (terminal === void 0) throw new SidebarError(`dsh-sidebar: unknown terminal "${termId}"`);
		if (terminal.exited) return { ok: false, exited: true };
		await terminal.handle.write(String(text));
		return { ok: true };
	}

	/**
	 * Terminate one terminal and drop its scrollback.
	 * @param termId - terminal id from termSpawn.
	 * @param signal - aborts the termination.
	 * @returns termination acknowledgement.
	 */
	async termKill(termId, signal) {
		const terminal = this.terminals.get(termId);
		if (terminal === void 0) return { ok: true };
		this.terminals.delete(termId);
		await terminal.handle.terminate().catch(() => {});
		return { ok: true };
	}

	/** List registered workspaces for the panel's directory picker. */
	async workspaces(signal) {
		const registry = this.ctx.workspaceRegistry;
		return registry.list().map((workspace) => ({
			id: workspace.id,
			path: workspace.path,
			title: workspace.title
		}));
	}
}

/** Prototype Remote markers: one per gateway method, declaration order. */
markRemote(SidebarGateway.prototype, "listDir");
markRemote(SidebarGateway.prototype, "readText");
markRemote(SidebarGateway.prototype, "diff");
markRemote(SidebarGateway.prototype, "termSpawn");
markRemote(SidebarGateway.prototype, "termRead");
markRemote(SidebarGateway.prototype, "termWrite");
markRemote(SidebarGateway.prototype, "termKill");
markRemote(SidebarGateway.prototype, "workspaces");

/** Arrow apply: the loader treats `function apply` declarations inconsistently across runtimes — arrows are the verified form. */
export const apply = (ctx) => {
	new SidebarGateway(ctx);
};

export const name = "dsh-sidebar";
export const inject = ["fs", "shell", "workspaceRegistry", "subprocess", "sandboxPolicy"];

export { SidebarError, errorRecord, SidebarGateway, TerminalBuffer, tail, parseWorktreeList, repoInfo };
