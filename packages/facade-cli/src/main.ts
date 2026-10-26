#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { EXIT, FACADE_VERSION, ZfacadeError, type Grant, type ToolName } from "@zfacade/contracts";
import { analyzeWorkflowScript } from "@zcode/dynamic-workflow";
import { loadConfig } from "./config-load.js";
import { inspect, recover, runTask } from "./coordinator.js";
import { runOrchestratedTask } from "./orchestrate.js";
import { serveBridge } from "./bridge.js";
import { auditTraining } from "./bridge-transform.js";

const HELP = `zfacade ${FACADE_VERSION} — engine-owned CLI coding agent (Phase 1 slice; local-provider A1 gate pending)

Usage:
  zfacade run [--workspace DIR] [--config FILE] [--grant Tool:match ...] <task>
  zfacade orchestrate [--workspace DIR] [--config FILE] [--script FILE] [--grant Tool:match ...] <task>
  zfacade inspect [--workspace DIR] [--run RUN_ID] [--json]
  zfacade sessions [--workspace DIR] [--json]
  zfacade recover [--workspace DIR] [--reconcile OP_ID:mark-completed|retry|abandon] [--json]
  zfacade analyze <workflow.ts> [--json]      Compile/analyze only; never executes model-authored code.
  zfacade bridge                              Training bridge protocol v1 over stdio (NDJSON).

Exit codes: 0 completed, 2 pending human input, 3 recovery hold, 4 denied, 5 infrastructure/usage error.
State: ~/.zfacade/workspaces/<key>/ (ZFACADE_HOME overrides). Trusted config: ~/.zfacade/config.json.
Deferred (absent, not stubbed): REPL, memory, compaction, MCP/hooks, general subagents, model-authored CLI execution.
`;

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v === undefined ? 1 : 2);
  return v;
}
function takeAll(args: string[], name: string): string[] {
  const out: string[] = [];
  for (;;) { const v = takeFlag(args, name); if (v === undefined) return out; out.push(v); }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") { process.stdout.write(HELP); return 0; }
  if (command === "bridge") { await serveBridge(); return 0; }
  const args = [...rest];
  const json = args.includes("--json");
  for (let i = args.length - 1; i >= 0; i--) if (args[i] === "--json") args.splice(i, 1);
  const workspace = takeFlag(args, "--workspace") ?? process.cwd();
  const emit = (value: unknown, pretty: () => void) => {
    if (json) process.stdout.write(JSON.stringify(value) + "\n"); else pretty();
  };
  if (command === "run") {
    const configPath = takeFlag(args, "--config");
    const grantArgs = takeAll(args, "--grant");
    const task = args.join(" ").trim();
    if (!task) { process.stderr.write("zfacade run: missing task\n"); return EXIT.infra; }
    const cfg = loadConfig(configPath);
    const grants: Grant[] = [...(cfg.grants ?? [])];
    grantArgs.forEach((g, i) => {
      const idx = g.indexOf(":");
      if (idx <= 0) throw new ZfacadeError("ConfigInvalid", `--grant needs Tool:match, got ${g}`);
      grants.push({ id: `cli-${i}`, tool: g.slice(0, idx) as ToolName, match: g.slice(idx + 1) });
    });
    // With no grants configured at all, default to the whole workspace so a first
    // run works. Bash is not opened up here: it stays under the command classifier,
    // which allows read-only and project build/test verbs and asks for the rest.
    if (grants.length === 0) {
      for (const tool of ["Write", "Edit", "ApplyPatch"] as ToolName[]) {
        grants.push({ id: `default-${tool}`, tool, match: "." });
      }
    }
    cfg.grants = grants;
    const outcome = await runTask({
      workspace, task, config: cfg,
      onEvent: (line) => process.stderr.write(`  ${line}\n`),
    });
    emit(outcome, () => {
      process.stdout.write(`${outcome.status}: ${outcome.summary}\nrun: ${outcome.runId}\nprovider: ${outcome.providerLabel}\n`);
      if (outcome.pendingQuestionIds.length) process.stdout.write(`pending: ${outcome.pendingQuestionIds.join(", ")}\n`);
      if (outcome.holdOperationIds.length) process.stdout.write(`holds: ${outcome.holdOperationIds.join(", ")}\n`);
    });
    return outcome.exitCode;
  }
  if (command === "orchestrate") {
    const configPath = takeFlag(args, "--config");
    const scriptPath = takeFlag(args, "--script");
    const grantArgs = takeAll(args, "--grant");
    const task = args.join(" ").trim();
    if (!task) { process.stderr.write("zfacade orchestrate: missing task\n"); return EXIT.infra; }
    const cfg = loadConfig(configPath);
    const grants: Grant[] = [...(cfg.grants ?? [])];
    grantArgs.forEach((g, i) => {
      const idx = g.indexOf(":");
      if (idx <= 0) throw new ZfacadeError("ConfigInvalid", `--grant needs Tool:match, got ${g}`);
      grants.push({ id: `cli-${i}`, tool: g.slice(0, idx) as ToolName, match: g.slice(idx + 1) });
    });
    if (grants.length === 0) {
      for (const tool of ["Write", "Edit", "ApplyPatch"] as ToolName[]) {
        grants.push({ id: `default-${tool}`, tool, match: "." });
      }
    }
    cfg.grants = grants;
    const scriptTextOverride = scriptPath ? readFileSync(scriptPath, "utf8") : undefined;
    const outcome = await runOrchestratedTask({
      workspace,
      task,
      config: cfg,
      ...(scriptTextOverride ? { scriptTextOverride } : {}),
      onEvent: (line) => process.stderr.write(`  ${line}\n`),
    });
    emit(outcome, () => {
      process.stdout.write(
        `${outcome.status}: ${outcome.summary}\nrun: ${outcome.runId}\ncompile-attempts: ${outcome.compileAttempts}\norchestrator: ${outcome.orchestratorLabel}\nworker: ${outcome.workerLabel}\n`,
      );
    });
    return outcome.exitCode;
  }
  if (command === "inspect" || command === "sessions") {
    const runId = takeFlag(args, "--run");
    const data = inspect({ workspace, runId });
    emit(command === "sessions" ? { sessions: data.sessions } : data, () => {
      process.stdout.write(`workspace: ${String(data.workspace)}\n`);
      for (const s of data.sessions as Array<{ sessionId: string; title?: string; runId?: string }>) {
        process.stdout.write(`${s.sessionId}\t${s.runId ?? "-"}\t${s.title ?? ""}\n`);
      }
      process.stdout.write(`holds: ${(data.holds as unknown[]).length}  pending-questions: ${(data.pendingQuestions as unknown[]).length}\n`);
    });
    return 0;
  }
  if (command === "recover") {
    const raw = takeFlag(args, "--reconcile");
    let reconcile;
    if (raw) {
      const [operationId, decision] = raw.split(":");
      if (!operationId || !["mark-completed", "retry", "abandon"].includes(decision ?? "")) {
        process.stderr.write("zfacade recover: --reconcile needs OP_ID:mark-completed|retry|abandon\n");
        return EXIT.infra;
      }
      reconcile = { operationId, decision: decision as "mark-completed" | "retry" | "abandon" };
    }
    const data = recover({ workspace, reconcile });
    emit(data, () => {
      process.stdout.write(`holds: ${(data.holds as unknown[]).length}\n`);
      for (const h of data.holds as Array<{ operationId: string; toolName: string }>) {
        process.stdout.write(`${h.operationId}\t${h.toolName}\toutcome_unknown\n`);
      }
    });
    return (data.holds as unknown[]).length > 0 ? EXIT.recoveryHold : 0;
  }
  if (command === "analyze") {
    const file = args[0];
    if (!file) { process.stderr.write("zfacade analyze: missing workflow file\n"); return EXIT.infra; }
    const source = readFileSync(file, "utf8");
    const result = analyzeWorkflowScript(source);
    const audit = auditTraining(source);
    const payload = {
      ok: result.ok,
      diagnostics: result.diagnostics,
      graphSites: result.causality?.steps.length ?? undefined,
      causalitySteps: result.causality?.steps.map((s) => s.id) ?? [],
      trainingAudit: audit,
      execution_authorized: false,
    };
    emit(payload, () => {
      process.stdout.write(result.ok ? "analyze: clean (execution not authorized by analyze)\n" : `analyze: ${result.diagnostics.length} diagnostic(s)\n`);
      for (const d of result.diagnostics) process.stdout.write(`${d.line ?? "?"}:${d.column ?? "?"} ${d.message}\n`);
    });
    return result.ok ? 0 : EXIT.infra;
  }
  process.stderr.write(`unknown command: ${command}\n${HELP}`);
  return EXIT.infra;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    const code = e instanceof ZfacadeError ? e.code : "error";
    process.stderr.write(`zfacade: ${code}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = EXIT.infra;
  },
);
