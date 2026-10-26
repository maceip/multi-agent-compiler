import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EffectRecord, QuestionRecord, ToolName } from "@zfacade/contracts";
import { digestOf, newId, sha256Hex, ZfacadeError } from "@zfacade/contracts";
import type { PermissionContext, WorkspaceStore } from "@zfacade/core";
import { PermissionService, resolveInside, toRelative, tx } from "@zfacade/core";
import { sigTargets } from "./sh-ops.js";
import { sandboxEnv, wrapArgv, type SandboxSpec } from "./sandbox.js";

export class PendingHumanError extends Error {
  constructor(readonly question: QuestionRecord) {
    super(`pending human decision: ${question.questionId}`);
    this.name = "PendingHumanError";
  }
}
export class HoldError extends Error {
  constructor(readonly effect: EffectRecord) {
    super(`recovery hold on effect ${effect.operationId} (${effect.toolName})`);
    this.name = "HoldError";
  }
}
export class ToolDeniedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ToolDeniedError"; }
}
/** Test-only: thrown by effect hooks to simulate abrupt process death (no settlement write). */
export class CrashSimulationError extends Error {
  constructor() { super("simulated crash"); this.name = "CrashSimulationError"; }
}

export interface ToolCallContext {
  runId: string;
  runRevision: string;
  siteId: string;
  ordinal: number;
  toolOrdinal: number;
  permission: PermissionContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Bridge gate/test effects use a distinct prefix so receipts stay attributable. */
  toolNameOverride?: string;
  /** Authorization surface when different from the performing tool (world.run). */
  authTool?: ToolName | "world.run";
  /** Registered verification gates by ID (bridge episodes). */
  gates?: Record<string, { argv: string[]; typecheckArgv?: string[] }>;
  /** Collector for gate effect receipt IDs produced by z_verify. */
  gateReceiptIds?: string[];
  /** R2: seatbelt sandbox applied to every subprocess in bridge episodes. */
  sandbox?: SandboxSpec;
}

export interface ToolOutcome {
  ok: boolean;
  /** Model-visible text (bounded; full bytes in artifact when truncated). */
  text: string;
  /** Structured result persisted on the receipt. */
  result: unknown;
  effect: EffectRecord;
  replayed: boolean;
}

const DEFAULT_MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

function asRecord(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolDeniedError("tool input must be a JSON object");
  }
  return input as Record<string, unknown>;
}
function needString(input: Record<string, unknown>, field: string): string {
  const v = input[field];
  if (typeof v !== "string" || v.length === 0) throw new ToolDeniedError(`tool input requires string field "${field}"`);
  return v;
}
function argvInput(input: Record<string, unknown>): string[] {
  const a = input.argv;
  if (!Array.isArray(a) || a.length === 0 || !a.every((x) => typeof x === "string" && x.length > 0 && !x.includes("\0"))) {
    throw new ToolDeniedError("Bash requires argv: non-empty string array (shell strings are not accepted)");
  }
  return a as string[];
}

export class ToolExecutor {
  private readonly permissions = new PermissionService();
  constructor(private readonly store: WorkspaceStore) {}

  async execute(tool: ToolName, rawInput: unknown, ctx: ToolCallContext): Promise<ToolOutcome> {
    const input = asRecord(rawInput);
    const toolName = ctx.toolNameOverride ?? tool;
    const intent = {
      runId: ctx.runId, runRevision: ctx.runRevision, siteId: ctx.siteId,
      ordinal: ctx.ordinal, toolOrdinal: ctx.toolOrdinal, toolName,
      input, cwd: ctx.permission.cwd,
    };
    const effects = this.store.effects;
    let rec = effects.admit(intent);
    if (rec.state === "completed") {
      const r = rec.result as { text?: string; result?: unknown } | undefined;
      return { ok: true, text: r?.text ?? "", result: r?.result, effect: rec, replayed: true };
    }
    if (rec.state === "outcome_unknown") throw new HoldError(rec);
    if (rec.state === "dispatched" || rec.state === "started") rec = effects.prepareRetry(rec);
    if (rec.state === "dispatched" || rec.state === "started") {
      // Mutating effect dispatched in a prior life with no receipt: hold, never guess.
      effects.recoverScan();
      const held = effects.repo.get(rec.operationId)!;
      throw new HoldError(held);
    }
    if (rec.state === "intended") {
      const decision = this.permissions.decide({ tool: ctx.authTool ?? tool, input }, ctx.permission);
      if (decision.kind === "deny") {
        effects.deny(rec.operationId, decision.reason);
        throw new ToolDeniedError(decision.reason);
      }
      if (decision.kind === "ask") {
        const question = tx(this.store.db, () => {
          const q: QuestionRecord = {
            questionId: newId("q"), runId: ctx.runId, kind: "permission", operationId: rec.operationId,
            payload: { tool, input, cwd: ctx.permission.cwd, reason: decision.reason },
            policyDigest: digestOf({ tool, input, cwd: ctx.permission.cwd }),
            status: "pending", createdAt: Date.now(),
          };
          this.store.questions.insert(q);
          return q;
        });
        throw new PendingHumanError(question);
      }
      rec = effects.authorize(rec.operationId, { grantId: decision.grantId, reason: decision.reason });
    }
    rec = effects.markDispatched(rec.operationId);
    try {
      const performed = await this.perform(tool, input, ctx);
      effects.noteEffectPerformed(rec.operationId);
      const settled = effects.settleCompleted(rec.operationId,
        { text: performed.text, result: performed.result },
        { artifactRef: performed.artifactRef, preHash: performed.preHash, postHash: performed.postHash });
      return { ok: performed.ok, text: performed.text, result: performed.result, effect: settled, replayed: false };
    } catch (e) {
      if (e instanceof CrashSimulationError) throw e; // process "died": receipt stays dispatched
      if (e instanceof ToolDeniedError) {
        const settled = effects.settleFailed(rec.operationId, e.message);
        return { ok: false, text: `error: ${e.message}`, result: { error: e.message }, effect: settled, replayed: false };
      }
      const current = effects.repo.get(rec.operationId);
      if (current && (current.state === "dispatched" || current.state === "started")) {
        effects.settleFailed(rec.operationId, e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  }

  private root(ctx: ToolCallContext): string { return ctx.permission.workspaceRoot; }

  private bound(ctx: ToolCallContext, runId: string, text: string): { text: string; artifactRef?: string } {
    const max = ctx.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= max) return { text };
    const ref = this.store.putArtifact(runId, "tool-output", bytes, "text/plain");
    const head = new TextDecoder().decode(bytes.slice(0, max));
    return { text: `${head}\n[truncated: ${bytes.length} bytes total; full output at ${ref}]`, artifactRef: ref };
  }

  private async perform(tool: ToolName, input: Record<string, unknown>, ctx: ToolCallContext):
    Promise<{ ok: boolean; text: string; result: unknown; artifactRef?: string; preHash?: string; postHash?: string }> {
    const root = this.root(ctx);
    switch (tool) {
      case "Read": {
        const rel = needString(input, "path");
        const abs = resolveInside(root, rel);
        if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolDeniedError(`file not found: ${rel}`);
        const data = readFileSync(abs);
        const text = new TextDecoder().decode(data);
        const b = this.bound(ctx, ctx.runId, text);
        return { ok: true, text: b.text, result: { path: rel, bytes: data.length, sha256: sha256Hex(data) }, artifactRef: b.artifactRef };
      }
      case "Write": {
        const rel = needString(input, "path");
        const content = needString(input, "content");
        const abs = resolveInside(root, rel);
        const preHash = existsSync(abs) && statSync(abs).isFile() ? sha256Hex(readFileSync(abs)) : undefined;
        this.atomicWrite(abs, content);
        const post = readFileSync(abs);
        return { ok: true, text: `wrote ${rel} (${post.length} bytes)`, result: { path: rel, bytes: post.length }, preHash, postHash: sha256Hex(post) };
      }
      case "Edit": {
        const rel = needString(input, "path");
        const oldText = needString(input, "old");
        const newText = typeof input.new === "string" ? input.new : (() => { throw new ToolDeniedError('Edit requires string field "new"'); })();
        const abs = resolveInside(root, rel);
        if (!existsSync(abs)) throw new ToolDeniedError(`file not found: ${rel}`);
        const before = readFileSync(abs, "utf8");
        const first = before.indexOf(oldText);
        if (first < 0) throw new ToolDeniedError(`Edit anchor not found in ${rel}`);
        if (before.indexOf(oldText, first + 1) >= 0) throw new ToolDeniedError(`Edit anchor is not unique in ${rel}`);
        const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
        this.atomicWrite(abs, after);
        return { ok: true, text: `edited ${rel}`, result: { path: rel }, preHash: sha256Hex(before), postHash: sha256Hex(after) };
      }
      case "ApplyPatch": {
        const patch = needString(input, "patch");
        const changed = applyUnifiedPatch(root, patch);
        return { ok: true, text: `patched: ${changed.join(", ")}`, result: { files: changed } };
      }
      case "Glob": {
        const pattern = needString(input, "pattern");
        const files = globFiles(root, pattern);
        if (files.length > 2000) throw new ToolDeniedError(`glob matched more than 2000 files: ${pattern}`);
        return { ok: true, text: files.join("\n"), result: { files } };
      }
      case "Grep": {
        const pattern = needString(input, "pattern");
        const glob = typeof input.glob === "string" ? input.glob : undefined;
        const matches = await this.grep(root, pattern, glob, ctx);
        const text = matches.map((m) => `${m.path}:${m.line}:${m.text}`).join("\n");
        const b = this.bound(ctx, ctx.runId, text);
        return { ok: true, text: b.text, result: { matches }, artifactRef: b.artifactRef };
      }
      case "Bash": {
        const argv = argvInput(input);
        const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : (ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const r = await runArgv(argv, root, timeoutMs, ctx.signal, ctx.sandbox);
        const combined = `exit ${r.exitCode}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`;
        const b = this.bound(ctx, ctx.runId, combined);
        return { ok: r.exitCode === 0 && !r.timedOut, text: b.text, result: { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.slice(0, 65536), stderr: r.stderr.slice(0, 65536) }, artifactRef: b.artifactRef };
      }
    }
  }

  private atomicWrite(abs: string, content: string): void {
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.zfacade-tmp-${process.pid}`;
    writeFileSync(tmp, content);
    try { renameSync(tmp, abs); } catch (e) { try { unlinkSync(tmp); } catch { /* tmp already gone */ } throw e; }
  }

  private async grep(root: string, pattern: string, glob: string | undefined, ctx: ToolCallContext): Promise<Array<{ path: string; line: number; text: string }>> {
    const argv = ["rg", "-n", "--no-heading", "--color=never", "-e", pattern];
    if (glob) argv.push("-g", glob);
    argv.push(".");
    const r = await runArgv(argv, root, ctx.timeoutMs ?? 60_000, ctx.signal, ctx.sandbox);
    if (r.exitCode === 2 && r.stderr.includes("ENOENT")) throw new ToolDeniedError("ripgrep (rg) is not available on this machine");
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new ToolDeniedError(`rg failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500)}`);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const m = /^\.?\/?(.+?):(\d+):(.*)$/.exec(line);
      if (m) matches.push({ path: m[1]!, line: Number(m[2]), text: m[3]! });
      if (matches.length > 2000) throw new ToolDeniedError("grep matched more than 2000 lines; narrow the pattern or add a glob");
    }
    return matches;
  }

  /** Workflow world operations (files, git, world.run) through the same authority. */
  async world(op: string, args: unknown[], ctx: ToolCallContext): Promise<unknown> {
    const root = this.root(ctx);
    const asTool = async (tool: ToolName, input: Record<string, unknown>, override: string): Promise<ToolOutcome> =>
      this.execute(tool, input, { ...ctx, toolNameOverride: override });
    switch (op) {
      case "glob": {
        const out = await asTool("Glob", { pattern: String(args[0] ?? "") }, "world-read:glob");
        return (out.result as { files: string[] }).files;
      }
      case "read": {
        const rel = String(args[0] ?? "");
        const out = await asTool("Read", { path: rel }, "world-read:read");
        return out.text;
      }
      case "grep": {
        const out = await asTool("Grep", { pattern: String(args[0] ?? ""), glob: args[1] as string | undefined }, "world-read:grep");
        return (out.result as { matches: unknown }).matches;
      }
      case "run": {
        const cmd = String(args[0] ?? "");
        const rest = Array.isArray(args[1]) ? (args[1] as string[]) : [];
        const opts = (args[2] as { timeoutMs?: number } | undefined) ?? {};
        // world.run is authorized as its own tool name (exact grants / pinned gates).
        const out = await this.executeWorldRun([cmd, ...rest], ctx, opts.timeoutMs);
        return out;
      }
      case "z-sig": {
        const rel = String(args[0] ?? "");
        const abs = resolveInside(root, rel);
        const out = await asTool("Read", { path: rel }, "world-read:z-sig");
        void abs;
        return sigTargets(out.text, rel).map((t) => ({
          file: rel, symbol: t.name, digest: t.bodyHash, signature: t.signature,
        }));
      }
      case "z-slice": {
        const rel = String(args[0] ?? "");
        const start = Math.max(1, Math.floor(Number(args[1] ?? 1)));
        const end = Math.max(start, Math.floor(Number(args[2] ?? start)));
        if (end - start + 1 > 200) throw new ToolDeniedError("z_slice window exceeds 200 lines");
        const out = await asTool("Read", { path: rel }, "world-read:z-slice");
        const lines = out.text.split("\n");
        return lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n");
      }
      case "z-impact": {
        const symbol = String(args[0] ?? "");
        const dir = String(args[1] ?? ".");
        if (!symbol) throw new ToolDeniedError("z_impact requires a symbol");
        const glob = dir === "." ? undefined : `${dir.replace(/\/$/, "")}/**`;
        const out = await asTool("Grep", { pattern: `\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, glob }, "world-read:z-impact");
        const matches = (out.result as { matches: Array<{ path: string; line: number; text: string }> }).matches;
        const byFile = new Map<string, string>();
        for (const m of matches) if (!byFile.has(m.path)) byFile.set(m.path, m.text.trim());
        return [...byFile.entries()].map(([file, line]) => ({
          file, symbol, digest: sha256Hex(line), signature: `textual-candidate: ${line.slice(0, 200)}`,
        }));
      }
      case "z-verify": {
        const gateId = String(args[0] ?? "");
        const gate = ctx.gates?.[gateId];
        if (!gate) throw new ToolDeniedError(`unknown gate id: ${gateId} (arbitrary commands are not gates)`);
        let exitCode = 0;
        let receiptId = "";
        const runGate = async (argv: string[], label: string, ordinal: number): Promise<number> => {
          const out = await this.execute("Bash", { argv }, {
            ...ctx, toolOrdinal: ordinal, toolNameOverride: `gate:${gateId}:${label}`, authTool: "world.run",
          });
          ctx.gateReceiptIds?.push(out.effect.operationId);
          receiptId = out.effect.operationId;
          return (out.result as { exitCode: number }).exitCode;
        };
        if (gate.typecheckArgv && gate.typecheckArgv.length > 0) exitCode = await runGate(gate.typecheckArgv, "typecheck", 0);
        if (exitCode === 0) exitCode = await runGate(gate.argv, "test", gate.typecheckArgv?.length ? 1 : 0);
        return { exit_code: exitCode, receiptId };
      }
      case "git-changed-files": case "git-diff": case "git-status": case "git-log": {
        const effects = this.store.effects;
        let rec = effects.admit({
          runId: ctx.runId, runRevision: ctx.runRevision, siteId: ctx.siteId, ordinal: ctx.ordinal,
          toolOrdinal: ctx.toolOrdinal, toolName: `world-read:${op}`, input: { args }, cwd: ctx.permission.cwd,
        });
        if (rec.state === "completed") return (rec.result as { result?: unknown })?.result;
        if (rec.state === "intended") rec = effects.authorize(rec.operationId, { grantId: "builtin-readonly", reason: "readonly git view inside workspace" });
        rec = effects.markDispatched(rec.operationId);
        try {
          const result = await this.gitWorld(op, args, root, ctx);
          effects.settleCompleted(rec.operationId, { result });
          return result;
        } catch (e) {
          effects.settleFailed(rec.operationId, e instanceof Error ? e.message : String(e));
          throw e;
        }
      }
      default:
        throw new ToolDeniedError(`unknown world operation: ${op}`);
    }
  }

  private async executeWorldRun(argv: string[], ctx: ToolCallContext, timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Reuse the Bash effect path but authorize under the world.run grant surface.
    const out = await this.execute("Bash", { argv, timeoutMs }, {
      ...ctx, toolNameOverride: "world-run", authTool: "world.run",
    });
    const r = out.result as { exitCode: number; stdout: string; stderr: string };
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  private async gitWorld(op: string, args: unknown[], root: string, ctx: ToolCallContext): Promise<unknown> {
    const git = async (argv: string[]): Promise<string> => {
      const r = await runArgv(["git", ...argv], root, 60_000, ctx.signal, ctx.sandbox);
      if (r.exitCode !== 0) throw new ToolDeniedError(`git ${argv[0]} failed: ${r.stderr.slice(0, 500) || "not a git repository"}`);
      return r.stdout;
    };
    switch (op) {
      case "git-status": {
        const out = await git(["status", "--porcelain=v1", "--branch"]);
        const lines = out.split("\n").filter(Boolean);
        const branchLine = lines.find((l) => l.startsWith("## "));
        const branch = branchLine ? branchLine.slice(3).split("...")[0]!.trim() : undefined;
        const staged: string[] = []; const unstaged: string[] = []; const untracked: string[] = [];
        for (const l of lines) {
          if (l.startsWith("## ")) continue;
          const x = l[0] ?? " "; const y = l[1] ?? " "; const path = l.slice(3);
          if (x === "?" && y === "?") untracked.push(path);
          else { if (x !== " " && x !== "?") staged.push(path); if (y !== " ") unstaged.push(path); }
        }
        return { branch, clean: lines.every((l) => l.startsWith("## ")), staged, unstaged, untracked };
      }
      case "git-changed-files": {
        const base = typeof args[0] === "string" ? args[0] : undefined;
        if (base) return (await git(["diff", "--name-only", base])).split("\n").filter(Boolean);
        const tracked = (await git(["diff", "--name-only", "HEAD"])).split("\n").filter(Boolean);
        const untracked = (await git(["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
        return [...new Set([...tracked, ...untracked])].sort();
      }
      case "git-diff": {
        const base = typeof args[0] === "string" ? args[0] : "HEAD";
        const argv = ["diff", base];
        if (typeof args[1] === "string") { resolveInside(root, args[1]); argv.push("--", args[1]); }
        const out = await git(argv);
        if (new TextEncoder().encode(out).length > 512 * 1024) throw new ToolDeniedError("git diff exceeds 512KB cap; narrow to one path");
        return out;
      }
      case "git-log": {
        const count = Math.min(100, Math.max(1, typeof args[0] === "number" ? args[0] : 20));
        const out = await git(["log", `-n`, String(count), "--format=%H%x1f%s%x1f%an%x1f%aI"]);
        return out.split("\n").filter(Boolean).map((l) => {
          const [hash, subject, author, date] = l.split("\x1f");
          return { hash, subject, author, date };
        });
      }
    }
    throw new ToolDeniedError(`unknown git operation: ${op}`);
  }
}

export interface ArgvResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; pid?: number }

/** Fixed-argv process execution (never a shell). Kills the whole process group on timeout/abort. */
export function runArgv(argv: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, sandbox?: SandboxSpec): Promise<ArgvResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const env: Record<string, string> = {
      PYTHONDONTWRITEBYTECODE: "1",
      ...Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]
          .filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k] as string]),
      ),
    };
    const effective = sandbox ? wrapArgv(sandbox, argv) : argv;
    if (sandbox) Object.assign(env, sandboxEnv(sandbox));
    const child = spawn(effective[0]!, effective.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    let outBytes = 0; let errBytes = 0;
    const CAP = 8 * 1024 * 1024;
    child.stdout?.on("data", (d: Buffer) => { if (outBytes < CAP) { out.push(d); outBytes += d.length; } });
    child.stderr?.on("data", (d: Buffer) => { if (errBytes < CAP) { err.push(d); errBytes += d.length; } });
    let timedOut = false;
    const killTree = () => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
      }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = () => killTree();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      rejectPromise(new ToolDeniedError(`spawn failed for ${argv[0]}: ${(e as Error).message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: code ?? -1, timedOut, pid: child.pid,
        stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
      });
    });
    if (signal?.aborted) killTree();
  });
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".zcode", "dist", ".turbo",
  // Non-JS toolchain output and vendored third-party trees.
  "vendor", "target", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".gradle", ".next", "coverage", ".idea", ".cargo", "Pods", ".tox",
]);

export function globFiles(root: string, pattern: string): string[] {
  if (pattern.includes("..")) throw new ToolDeniedError("Glob pattern escapes workspace");
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), rel); }
      else if (e.isFile() && matchGlob(pattern, rel)) out.push(rel);
      if (out.length > 5000) return;
    }
  };
  walk(root, "");
  return out.sort();
}

export function matchGlob(pattern: string, path: string): boolean {
  const p = pattern.split("/"); const s = path.split("/");
  const segMatch = (pat: string, str: string): boolean => {
    const re = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return re.test(str);
  };
  const go = (pi: number, si: number): boolean => {
    if (pi === p.length) return si === s.length;
    if (p[pi] === "**") {
      for (let k = si; k <= s.length; k++) if (go(pi + 1, k)) return true;
      return false;
    }
    if (si >= s.length) return false;
    return segMatch(p[pi]!, s[si]!) && go(pi + 1, si + 1);
  };
  return go(0, 0);
}

/** Minimal unified-diff applier: ---/+++ file headers, @@ hunks, exact context matching. */
export function applyUnifiedPatch(root: string, patch: string): string[] {
  const lines = patch.split("\n");
  const changed: string[] = [];
  let i = 0;
  let currentPath: string | undefined;
  let currentLines: string[] | undefined;
  const flush = () => {
    if (currentPath !== undefined && currentLines !== undefined) {
      const abs = resolveInside(root, currentPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, currentLines.join("\n"));
      changed.push(currentPath);
    }
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      const rel = p.startsWith("b/") ? p.slice(2) : p;
      flush();
      currentPath = rel;
      const abs = resolveInside(root, rel);
      currentLines = (existsSync(abs) ? readFileSync(abs, "utf8") : "").split("\n");
      i++; continue;
    }
    if (line.startsWith("@@") && currentLines !== undefined) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new ToolDeniedError(`bad hunk header: ${line}`);
      let cursor = Number(m[1]) - 1;
      i++;
      while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git") && !lines[i]!.startsWith("--- ")) {
        const h = lines[i]!;
        if (h.startsWith("\\")) { i++; continue; }
        const kind = h[0] ?? " ";
        const text = h.slice(1);
        if (kind === " ") {
          if (currentLines[cursor] !== text) throw new ToolDeniedError(`patch context mismatch in ${currentPath} at line ${cursor + 1}`);
          cursor++;
        } else if (kind === "-") {
          if (currentLines[cursor] !== text) throw new ToolDeniedError(`patch removal mismatch in ${currentPath} at line ${cursor + 1}`);
          currentLines.splice(cursor, 1);
        } else if (kind === "+") {
          currentLines.splice(cursor, 0, text);
          cursor++;
        } else break;
        i++;
      }
      continue;
    }
    i++;
  }
  flush();
  if (changed.length === 0) throw new ToolDeniedError("patch contained no file changes");
  return changed;
}

export { toRelative };
