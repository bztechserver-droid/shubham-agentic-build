import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createWriteStream, watch } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
const BAD_CHARS = /[<>:"/\\|?*]/;
/** A control character (0 to 31, 127): tested by its code, so no pattern has to hold one. */
const hasControl = (s) => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/** Why a single name can't be used, in words for a person; null when it can. The same on every operating system. */
function nameProblem(name) {
	if (!name) return "The name is empty.";
	if (name === "." || name === "..") return "That name is not allowed.";
	if (BAD_CHARS.test(name) || hasControl(name)) return "A name cannot contain < > : \" / \\ | ? * or control characters.";
	if (/[. ]$/.test(name)) return "A name cannot end with a dot or a space.";
	if (RESERVED.test(name)) return "That name is reserved by Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).";
	if (new TextEncoder().encode(name).length > 255) return "That name is too long.";
	return null;
}
/** Why a whole path can't be used (any piece of it, or its length); null when it can. `""` is the root. */
function pathProblem(path) {
	if (path === "") return null;
	if (path.startsWith("/") || path.endsWith("/")) return "A path has no slash at either end.";
	if (path.length > 240) return "That path is too long.";
	for (const part of path.split("/")) {
		const why = nameProblem(part);
		if (why) return why;
	}
	return null;
}
/** The key two names are compared by: Unicode NFC, then lower case. Two names with one key are "the same name in a different case". */
const nameKey = (name) => name.normalize("NFC").toLowerCase();
const depth = (p) => p === "" ? 0 : p.split("/").length;
function plan(base, local, remote, opt = {}) {
	const baseFiles = [...base.values()].filter((b) => b.kind === "file").length;
	if (!opt.allowMassDelete && baseFiles > 0) {
		const localFiles = [...local.values()].filter((l) => l.kind === "file").length;
		const remoteFiles = [...remote.values()].filter((r) => r.kind === "file").length;
		if (localFiles === 0) return {
			actions: [],
			held: [],
			blocked: "local-empty"
		};
		if (remoteFiles === 0) return {
			actions: [],
			held: [],
			blocked: "remote-empty"
		};
	}
	const paths = /* @__PURE__ */ new Set([
		...base.keys(),
		...local.keys(),
		...remote.keys()
	]);
	const mkdirs = [];
	const transfers = [];
	const deletes = [];
	const bookkeeping = [];
	for (const path of paths) {
		const b = base.get(path);
		const l = local.get(path);
		const r = remote.get(path);
		if (b && l && l.kind !== b.kind) {
			transfers.push({
				op: "error",
				path,
				why: "It was a file and is now a folder here (or the other way round)."
			});
			continue;
		}
		if (b && r && r.kind !== b.kind) {
			transfers.push({
				op: "error",
				path,
				why: "It was a file and is now a folder in the Common Drive (or the other way round)."
			});
			continue;
		}
		if (l && r && l.kind !== r.kind) {
			transfers.push({
				op: "error",
				path,
				why: "It is a file on one side and a folder on the other."
			});
			continue;
		}
		const kind = (l ?? r ?? b)?.kind;
		if (!kind) continue;
		if (kind === "dir") {
			if (!b && l && !r) mkdirs.push({
				op: "mkdir-remote",
				path
			});
			else if (!b && !l && r) mkdirs.push({
				op: "mkdir-local",
				path
			});
			else if (!b && l && r) bookkeeping.push({
				op: "adopt",
				path
			});
			else if (b && l && r) bookkeeping.push({
				op: "adopt",
				path
			});
			else if (b && !l && r) deletes.push({
				op: "delete-remote",
				path
			});
			else if (b && l && !r) deletes.push({
				op: "delete-local",
				path
			});
			else if (b && !l && !r) bookkeeping.push({
				op: "forget",
				path
			});
			continue;
		}
		const localChanged = l ? !b || b.lsize !== l.size || Math.abs(b.lmtime - l.mtimeMs) >= 1 : false;
		const remoteChanged = r ? !b || b.etag !== r.etag : false;
		if (!b) {
			if (l && !r) transfers.push({
				op: "upload",
				path,
				mode: "create"
			});
			else if (!l && r) transfers.push({
				op: "download",
				path
			});
			else if (l && r) {
				if (l.size === r.size && Math.abs(l.mtimeMs - r.mtime) < 2e3) bookkeeping.push({
					op: "adopt",
					path
				});
				else transfers.push({
					op: "conflict",
					path
				});
			}
			continue;
		}
		if (l && r) {
			if (!localChanged && !remoteChanged) continue;
			if (localChanged && !remoteChanged) transfers.push({
				op: "upload",
				path,
				mode: "ifmatch",
				baseEtag: b.etag
			});
			else if (!localChanged && remoteChanged) transfers.push({
				op: "download",
				path
			});
			else if (l.size === r.size && Math.abs(l.mtimeMs - r.mtime) < 2e3) bookkeeping.push({
				op: "adopt",
				path
			});
			else transfers.push({
				op: "conflict",
				path,
				baseEtag: b.etag
			});
		} else if (!l && r) {
			if (!remoteChanged) deletes.push({
				op: "delete-remote",
				path
			});
			else transfers.push({
				op: "download",
				path
			});
		} else if (l && !r) {
			if (!localChanged) deletes.push({
				op: "delete-local",
				path
			});
			else transfers.push({
				op: "upload",
				path,
				mode: "create"
			});
		} else bookkeeping.push({
			op: "forget",
			path
		});
	}
	const holdOver = opt.holdOver ?? 20;
	const holdShare = opt.holdShare ?? .2;
	const fileDeletes = deletes.filter((d) => d.op !== "forget");
	const massive = !opt.allowMassDelete && fileDeletes.length > holdOver && fileDeletes.length > holdShare * Math.max(1, baseFiles);
	mkdirs.sort((a, c) => depth(a.path) - depth(c.path) || (a.path < c.path ? -1 : 1));
	transfers.sort((a, c) => a.path < c.path ? -1 : a.path > c.path ? 1 : 0);
	deletes.sort((a, c) => depth(c.path) - depth(a.path) || (a.path < c.path ? -1 : 1));
	return massive ? {
		actions: [
			...mkdirs,
			...transfers,
			...bookkeeping
		],
		held: deletes,
		blocked: null
	} : {
		actions: [
			...mkdirs,
			...transfers,
			...deletes,
			...bookkeeping
		],
		held: [],
		blocked: null
	};
}
// agent/drive/sync.ts
const IGNORED_NAME = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\.~lock\..*#|.*\.tmp|.*\.part|\.sad-sync-.*)$/i;
const isIgnored = (name) => IGNORED_NAME.test(name);
const message = (e) => e instanceof Error ? e.message : String(e);
const sleep = (ms, signal) => new Promise((resolve) => {
	if (signal?.aborted) return resolve();
	const t = setTimeout(resolve, ms);
	t.unref?.();
	signal?.addEventListener("abort", () => {
		clearTimeout(t);
		resolve();
	});
});
/** Windows answers EPERM/EBUSY/EACCES to a rename over a file that is open, being deleted or being scanned: it is usually over in a moment. */
const BUSY_CODES = /* @__PURE__ */ new Set([
	"EPERM",
	"EBUSY",
	"EACCES"
]);
const RENAME_WAITS_MS = [
	100,
	200,
	300
];
/** Renames, trying again a few times (waits apart) while the file is busy; any other error, or the last busy one, is thrown as it is. */
async function renameWhenFree(rename_, from, to, waits = RENAME_WAITS_MS) {
	for (let i = 0;; i++) try {
		return await rename_(from, to);
	} catch (e) {
		const code = e.code;
		if (!code || !BUSY_CODES.has(code) || i >= waits.length) throw e;
		await sleep(waits[i]);
	}
}
function createSync(o) {
	const moveFile = (from, to) => renameWhenFree(o.renameFile ?? rename, from, to, o.renameWaitsMs);
	const now = o.now ?? Date.now;
	const folder = path.resolve(o.folder);
	const stateFile = path.join(o.stateDir, "sync-state.json");
	const trashDir = path.join(o.stateDir, "trash");
	const abs = (rel) => path.join(folder, ...rel.split("/"));
	let state = null;
	let allowDeletes = false;
	let status = {
		state: "idle",
		lastOkAt: null,
		lastReport: null,
		error: null
	};
	async function load() {
		if (state) return state;
		try {
			const v = JSON.parse(await readFile(stateFile, "utf8"));
			if (v.version === 1 && v.base && typeof v.base === "object") return state = v;
		} catch {}
		return state = {
			version: 1,
			rev: null,
			base: {}
		};
	}
	async function save() {
		if (!state) return;
		await mkdir(o.stateDir, { recursive: true });
		const tmp = `${stateFile}.${randomBytes(3).toString("hex")}.tmp`;
		await writeFile(tmp, JSON.stringify(state));
		await rename(tmp, stateFile);
	}
	async function scanLocal(errors) {
		const out = /* @__PURE__ */ new Map();
		const walk = async (dirAbs, rel) => {
			const names = (await readdir(dirAbs)).sort();
			const seen = /* @__PURE__ */ new Map();
			for (const n of names) {
				if (isIgnored(n)) continue;
				const r = rel ? `${rel}/${n}` : n;
				const st = await lstat(path.join(dirAbs, n)).catch(() => null);
				if (!st || st.isSymbolicLink()) continue;
				if (!st.isDirectory() && !st.isFile()) continue;
				const why = pathProblem(r.normalize("NFC"));
				if (why) {
					errors.push({
						path: r,
						why: `Not synced: ${why}`
					});
					continue;
				}
				const key = nameKey(n);
				const clash = seen.get(key);
				if (clash) {
					errors.push({
						path: r,
						why: `Not synced: ${clash} is already here; names that differ only in case are the same name in the Common Drive.`
					});
					continue;
				}
				seen.set(key, n);
				const norm = r.normalize("NFC");
				if (st.isDirectory()) {
					out.set(norm, {
						kind: "dir",
						size: 0,
						mtimeMs: 0
					});
					await walk(path.join(dirAbs, n), r);
				} else out.set(norm, {
					kind: "file",
					size: st.size,
					mtimeMs: st.mtimeMs
				});
			}
		};
		await walk(folder, "");
		return out;
	}
	async function walkRemote(into, rel) {
		let cursor;
		do {
			const page = await o.remote.list(rel, cursor);
			for (const e of page.entries) {
				into.set(e.path, {
					kind: e.kind,
					size: e.size,
					etag: e.etag,
					mtime: e.mtime
				});
				if (e.kind === "dir") await walkRemote(into, e.path);
			}
			cursor = page.next;
		} while (cursor);
	}
	const fromBase = (base) => {
		const m = /* @__PURE__ */ new Map();
		for (const [p, b] of Object.entries(base)) m.set(p, {
			kind: b.kind,
			size: b.size,
			etag: b.etag,
			mtime: b.lmtime
		});
		return m;
	};
	async function remoteView(s) {
		if (s.rev === null) {
			const rev = await o.remote.rev();
			const view = /* @__PURE__ */ new Map();
			await walkRemote(view, "");
			return {
				view,
				rev
			};
		}
		const ch = await o.remote.changes(s.rev, 0);
		if (ch.reset) {
			const view = /* @__PURE__ */ new Map();
			await walkRemote(view, "");
			return {
				view,
				rev: ch.rev
			};
		}
		const view = fromBase(s.base);
		const touched = /* @__PURE__ */ new Set();
		const gone = (p) => {
			view.delete(p);
			for (const k of [...view.keys()]) if (k.startsWith(`${p}/`)) view.delete(k);
		};
		for (const c of ch.changes) {
			if (c.op === "purge") continue;
			if (c.op === "delete") gone(c.path);
			if (c.op === "move" && c.from) gone(c.from);
			if (c.op !== "delete") touched.add(c.path);
		}
		for (const p of touched) {
			const e = await o.remote.stat(p);
			if (!e) {
				gone(p);
				continue;
			}
			view.set(p, {
				kind: e.kind,
				size: e.size,
				etag: e.etag,
				mtime: e.mtime
			});
			if (e.kind === "dir") {
				const sub = /* @__PURE__ */ new Map();
				await walkRemote(sub, p);
				for (const [k, v] of sub) view.set(k, v);
			}
		}
		return {
			view,
			rev: ch.rev
		};
	}
	async function tempNear(target) {
		return path.join(path.dirname(target), `.sad-sync-${randomBytes(4).toString("hex")}.part`);
	}
	async function moveToTrash(rel) {
		const to = path.join(trashDir, new Date(now()).toISOString().replace(/[:.]/g, "-"), ...rel.split("/"));
		await mkdir(path.dirname(to), { recursive: true });
		try {
			await moveFile(abs(rel), to);
		} catch {
			await copyFile(abs(rel), to);
			await unlink(abs(rel));
		}
	}
	async function runOnce() {
		const report = {
			uploaded: 0,
			downloaded: 0,
			conflicts: 0,
			deletedLocal: 0,
			deletedRemote: 0,
			errors: [],
			held: 0,
			blocked: null,
			rev: 0
		};
		const s = await load();
		await mkdir(o.stateDir, { recursive: true });
		if (!await stat(folder).then((x) => x.isDirectory(), () => false)) {
			if (Object.keys(s.base).length > 0) {
				report.blocked = "local-missing";
				return report;
			}
			await mkdir(folder, { recursive: true });
		}
		const { view: remote, rev } = await remoteView(s);
		report.rev = rev;
		const local = await scanLocal(report.errors);
		const p = plan(new Map(Object.entries(s.base)), local, remote, {
			...o.plan,
			allowMassDelete: allowDeletes || o.plan?.allowMassDelete
		});
		if (p.blocked) {
			report.blocked = p.blocked;
			return report;
		}
		report.held = p.held.length;
		let failed = false;
		const fail = (path_, e) => {
			failed = true;
			report.errors.push({
				path: path_,
				why: message(e)
			});
		};
		const setBase = (rel, e) => void (s.base[rel] = e);
		const download = async (rel, before) => {
			const target = abs(rel);
			await mkdir(path.dirname(target), { recursive: true });
			const tmp = await tempNear(target);
			let entry;
			try {
				entry = await o.remote.download(rel, tmp);
				const now2 = await lstat(target).catch(() => null);
				if (now2 && before && (now2.size !== before.size || Math.abs(now2.mtimeMs - before.mtimeMs) >= 1)) throw new Error("It changed here while it was being fetched; it will be looked at again.");
				await utimes(tmp, entry.mtime / 1e3, entry.mtime / 1e3);
				await moveFile(tmp, target);
			} catch (e) {
				await rm(tmp, { force: true });
				throw e;
			}
			const st = await stat(target);
			setBase(rel, {
				kind: "file",
				etag: entry.etag,
				size: entry.size,
				lsize: st.size,
				lmtime: st.mtimeMs
			});
			report.downloaded++;
		};
		const upload = async (rel, mode, baseEtag) => {
			const pre = await stat(abs(rel));
			const done = await o.remote.upload(rel, abs(rel), {
				mode,
				baseEtag,
				modified: Math.floor(pre.mtimeMs),
				size: pre.size
			});
			report.uploaded++;
			if (!done.conflict) setBase(rel, {
				kind: "file",
				etag: done.entry.etag,
				size: done.entry.size,
				lsize: pre.size,
				lmtime: pre.mtimeMs
			});
			return done;
		};
		for (const a of p.actions) try {
			switch (a.op) {
				case "mkdir-remote":
					await o.remote.mkdir(a.path);
					setBase(a.path, {
						kind: "dir",
						etag: "",
						size: 0,
						lsize: 0,
						lmtime: 0
					});
					break;
				case "mkdir-local":
					await mkdir(abs(a.path), { recursive: true });
					setBase(a.path, {
						kind: "dir",
						etag: "",
						size: 0,
						lsize: 0,
						lmtime: 0
					});
					break;
				case "upload":
					await upload(a.path, a.mode, a.baseEtag);
					break;
				case "download":
					await download(a.path, local.get(a.path));
					break;
				case "conflict": {
					const done = await upload(a.path, "ifmatch", a.baseEtag ?? "none");
					report.conflicts++;
					if (done.conflict) await download(a.path, void 0);
					break;
				}
				case "adopt": {
					const r = remote.get(a.path);
					const l = local.get(a.path);
					if (r && l) setBase(a.path, {
						kind: r.kind,
						etag: r.etag,
						size: r.size,
						lsize: l.size,
						lmtime: l.mtimeMs
					});
					break;
				}
				case "delete-remote":
					if (s.base[a.path]?.kind === "dir") {
						if ((await o.remote.list(a.path)).entries.length) break;
					}
					await o.remote.remove(a.path);
					delete s.base[a.path];
					report.deletedRemote++;
					break;
				case "delete-local":
					if (s.base[a.path]?.kind === "dir") {
						if ((await readdir(abs(a.path)).catch(() => ["x"])).length) break;
						await rmdir(abs(a.path));
					} else await moveToTrash(a.path);
					delete s.base[a.path];
					report.deletedLocal++;
					break;
				case "forget":
					delete s.base[a.path];
					break;
				case "error": fail(a.path, a.why);
			}
		} catch (e) {
			fail(a.path, e);
		}
		allowDeletes = false;
		if (!failed && p.held.length === 0) s.rev = rev;
		await save();
		return report;
	}
	let running = false;
	let stopping = null;
	let loop = null;
	let watcher = null;
	function start() {
		if (running) return;
		running = true;
		const ac = stopping = new AbortController();
		status = {
			...status,
			state: "syncing"
		};
		let wake = null;
		let woken = false;
		const poke = () => {
			woken = true;
			wake?.();
		};
		let debounce;
		try {
			watcher = watch(folder, { recursive: true }, (_e, name) => {
				if (name && isIgnored(path.basename(String(name)))) return;
				clearTimeout(debounce);
				debounce = setTimeout(poke, 1500);
				debounce.unref?.();
			});
			watcher.on("error", () => void 0);
		} catch {
			watcher = null;
		}
		(async () => {
			let since = null;
			let backoff = 1e3;
			while (!ac.signal.aborted) try {
				since ??= await o.remote.rev();
				const c = await o.remote.changes(since, o.pollMs ?? 25e3, ac.signal);
				if (ac.signal.aborted) return;
				if (c.reset || c.changes.length) poke();
				since = c.rev;
				backoff = 1e3;
			} catch {
				await sleep(backoff, ac.signal);
				backoff = Math.min(6e4, backoff * 2);
			}
		})();
		loop = (async () => {
			let backoff = 2e3;
			while (!ac.signal.aborted) {
				try {
					status = {
						...status,
						state: "syncing"
					};
					const r = await runOnce();
					status = {
						state: r.blocked || r.held ? "blocked" : "idle",
						lastOkAt: now(),
						lastReport: r,
						error: r.blocked ? `Sync paused: ${r.blocked}` : null
					};
					backoff = 2e3;
				} catch (e) {
					status = {
						...status,
						state: "offline",
						error: message(e)
					};
					o.log?.warn(`sync: ${message(e)}`);
					await sleep(backoff, ac.signal);
					backoff = Math.min(6e4, backoff * 2);
					continue;
				}
				if (!woken && !ac.signal.aborted) await new Promise((resolve) => {
					wake = resolve;
					setTimeout(resolve, o.scanEveryMs ?? 6e4).unref?.();
					ac.signal.addEventListener("abort", () => resolve());
				});
				wake = null;
				woken = false;
			}
		})();
	}
	return {
		runOnce,
		start,
		async stop() {
			stopping?.abort();
			watcher?.close();
			watcher = null;
			await loop;
			running = false;
			loop = null;
			status = {
				...status,
				state: "stopped"
			};
		},
		status: () => ({ ...status }),
		allowMassDelete() {
			allowDeletes = true;
		}
	};
}
// agent/drive/sync-http.ts
var DriveHttpError = class extends Error {
	status;
	code;
	received;
	constructor(status, message, code, received) {
		super(message);
		this.status = status;
		this.code = code;
		this.received = received;
	}
};
const TRIES = 4;
function httpRemote(o) {
	const f = o.fetch ?? fetch;
	const root = `${o.baseUrl.replace(/\/+$/, "")}/api`;
	const auth = `Basic ${Buffer.from(`${o.name}:${o.password}`).toString("base64")}`;
	const q = (params) => {
		const u = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== void 0 && v !== "") u.set(k, String(v));
		const s = u.toString();
		return s ? `?${s}` : "";
	};
	async function raw(method, rest, opt = {}) {
		const headers = {
			authorization: auth,
			"x-drive-client": o.name,
			...opt.headers
		};
		let body = opt.body;
		if (opt.json !== void 0) {
			body = JSON.stringify(opt.json);
			headers["content-type"] = "application/json";
		}
		const res = await f(`${root}${rest}`, {
			method,
			headers,
			body,
			signal: opt.signal
		});
		if (res.ok) return res;
		let message = `${res.status}`;
		let code;
		let received;
		const text = await res.text().catch(() => "");
		try {
			const j = JSON.parse(text);
			message = j.error ?? message;
			code = j.code;
			received = j.received;
		} catch {
			message = text.slice(0, 200) || message;
		}
		if (res.status === 401) message = "The server did not accept this device’s password. Pair it again from the Drive page.";
		throw new DriveHttpError(res.status, message, code, received);
	}
	const json = async (method, rest, opt = {}) => (await raw(method, rest, opt)).json();
	const pause = (ms) => new Promise((r) => setTimeout(r, ms));
	const transient = (e) => !(e instanceof DriveHttpError) || e.status >= 500 || e.status === 429;
	return {
		rev: async () => (await json("GET", "/status")).rev,
		changes: (since, waitMs, signal) => {
			const t = AbortSignal.timeout(waitMs + 2e4);
			return json("GET", `/changes${q({
				since,
				wait: waitMs,
				limit: 2e3
			})}`, { signal: signal ? AbortSignal.any([signal, t]) : t });
		},
		list: (path, cursor) => json("GET", `/list${q({
			path,
			cursor,
			limit: 1e3
		})}`),
		async stat(path) {
			try {
				return await json("GET", `/stat${q({ path })}`);
			} catch (e) {
				if (e instanceof DriveHttpError && e.code === "notfound") return null;
				throw e;
			}
		},
		async download(path, dest) {
			const res = await raw("GET", `/file${q({
				path,
				download: 1
			})}`);
			try {
				if (!res.body) throw new Error("The server sent no content.");
				await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
			} catch (e) {
				await rm(dest, { force: true });
				throw e;
			}
			const size = Number(res.headers.get("content-length") ?? "0");
			const etag = (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "");
			const mtime = Number(res.headers.get("x-drive-mtime") ?? Date.parse(res.headers.get("last-modified") ?? ""));
			return {
				name: path.slice(path.lastIndexOf("/") + 1),
				path,
				kind: "file",
				size,
				etag,
				mtime: Number.isFinite(mtime) ? mtime : Date.now()
			};
		},
		async upload(path, src, opt) {
			const start = await json("POST", "/upload", { json: {
				path,
				size: opt.size,
				mode: opt.mode,
				baseEtag: opt.baseEtag,
				modified: opt.modified
			} });
			try {
				const fh = await open(src, "r");
				try {
					let offset = 0;
					const buf = Buffer.alloc(start.pieceBytes);
					while (offset < opt.size) {
						const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, opt.size - offset), offset);
						if (bytesRead <= 0) throw new Error("The file changed while it was being sent.");
						const piece = Buffer.from(buf.subarray(0, bytesRead));
						for (let attempt = 1;; attempt++) try {
							await raw("PUT", `/upload/${start.id}${q({ offset })}`, {
								body: piece,
								headers: { "content-type": "application/octet-stream" }
							});
							break;
						} catch (e) {
							if (!transient(e) && !(e instanceof DriveHttpError && e.code === "offset")) throw e;
							if (attempt >= TRIES) throw e;
							await pause(o.retryMs ?? 500 * attempt);
							const info = await json("GET", `/upload/${start.id}`).catch(() => null);
							if (info && info.received === offset + bytesRead) break;
							if (info && info.received !== offset) throw new Error("The upload got out of step; it will be tried again from the start.");
						}
						offset += bytesRead;
					}
				} finally {
					await fh.close();
				}
				return await json("POST", `/upload/${start.id}/commit`);
			} catch (e) {
				await raw("DELETE", `/upload/${start.id}`).catch(() => void 0);
				throw e;
			}
		},
		async mkdir(path) {
			await json("POST", "/mkdir", { json: { path } });
		},
		async remove(path) {
			await json("POST", "/delete", { json: { path } });
		}
	};
}
// agent/drive/sync-cli.ts
function configDir(env = process.env, platform = process.platform) {
	if (platform === "win32") return path.join(env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "CommonDrive");
	if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", "CommonDrive");
	return path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "common-drive");
}
const consoleLog = (scope = "") => {
	const line = (level) => (...a) => console.log(`${(/* @__PURE__ */ new Date()).toISOString()} ${level} ${scope}${a.map(String).join(" ")}`);
	return {
		debug: () => void 0,
		info: line("info"),
		warn: line("warn"),
		error: line("error"),
		child: (s) => consoleLog(`${scope}${s}: `)
	};
};
function parseArgs(argv) {
	const [cmd = "help", ...rest] = argv;
	const flags = {};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
			else flags[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
		}
	}
	return {
		cmd,
		flags
	};
}
async function readConfig(dir) {
	try {
		const c = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
		if (c.server && c.name && c.password && c.folder) return c;
	} catch {}
	throw new Error(`Not paired yet. Make a code on the Drive page, then: node sync-cli.ts pair --server <address> --code <code>`);
}
async function writeConfig(dir, c) {
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, "config.json");
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(c, null, 2), { mode: 384 });
	await chmod(tmp, 384).catch(() => void 0);
	await rename(tmp, file);
}
function unitText(nodePath, scriptPath) {
	return `[Unit]
Description=Common Drive sync folder
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${nodePath} ${scriptPath} run
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}
async function main(argv, env = process.env, out = (s) => console.log(s)) {
	const { cmd, flags } = parseArgs(argv);
	const dir = flags.config ?? configDir(env);
	switch (cmd) {
		case "pair": {
			const server = (flags.server ?? "").replace(/\/+$/, "");
			if (!server || !flags.code) {
				out("Usage: pair --server https://<hub>.<tailnet>.ts.net:8444 --code ABCD-2345 [--folder <folder>] [--name <this device>]");
				return 2;
			}
			const res = await fetch(`${server}/api/pair`, {
				method: "POST",
				body: JSON.stringify({ code: flags.code })
			});
			if (!res.ok) {
				out(`Pairing failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
				return 1;
			}
			const creds = await res.json();
			const folder = path.resolve((flags.folder ?? path.join(homedir(), "CommonDrive")).replace(/^~(?=$|\/|\\)/, homedir()));
			await writeConfig(dir, {
				server,
				name: creds.name,
				password: creds.password,
				folder
			});
			await mkdir(folder, { recursive: true });
			out(`Paired as "${creds.name}". The folder is ${folder}. Start it with: node sync-cli.ts run`);
			return 0;
		}
		case "status": {
			const c = await readConfig(dir);
			out(`Paired as "${c.name}" with ${c.server}; folder ${c.folder}; config ${path.join(dir, "config.json")}`);
			return 0;
		}
		case "once":
		case "run": {
			const c = await readConfig(dir);
			const sync = createSync({
				folder: c.folder,
				stateDir: path.join(dir, "state"),
				remote: httpRemote({
					baseUrl: c.server,
					name: c.name,
					password: c.password
				}),
				device: c.name,
				log: consoleLog()
			});
			if (cmd === "once") {
				const r = await sync.runOnce();
				out(`uploaded ${r.uploaded}, downloaded ${r.downloaded}, conflicts ${r.conflicts}, deleted here ${r.deletedLocal}, deleted there ${r.deletedRemote}${r.held ? `, ${r.held} deletes held (confirm with --allow-deletes)` : ""}${r.blocked ? `, PAUSED: ${r.blocked}` : ""}`);
				for (const e of r.errors) out(`  ${e.path}: ${e.why}`);
				return r.errors.length || r.blocked ? 1 : 0;
			}
			if (flags["allow-deletes"]) sync.allowMassDelete();
			sync.start();
			out(`Keeping ${c.folder} in step with ${c.server} as "${c.name}". Stop with Ctrl+C.`);
			await new Promise((resolve) => {
				const stop = () => void sync.stop().then(resolve);
				process.once("SIGINT", stop);
				process.once("SIGTERM", stop);
			});
			return 0;
		}
		case "unit":
			out(unitText(process.execPath, path.resolve(process.argv[1] ?? "sync-cli.ts")));
			return 0;
		default:
			out("Commands: pair, run, once, status, unit. See the comment at the top of sync-cli.ts.");
			return cmd === "help" ? 0 : 2;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
export { configDir, main, parseArgs, unitText };
