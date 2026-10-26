import type { ImportedRunCache } from "@zcode/dynamic-workflow";
import type { ModelMessage, ProviderPort, ToolSpec, ZfacadeConfig } from "@zfacade/contracts";
import { EXIT, newId } from "@zfacade/contracts";
import type { WorkspaceStore } from "@zfacade/core";
import { openWorkspaceStore } from "@zfacade/core";
import { BoundedDriver, executeRun, prepareWorkflow } from "@zfacade/agent";
import { buildOrchestratorProvider, buildProvider } from "./config-load.js";

/**
 * The language-agnostic ~10-function ZCode workflow facade prompt for the Orchestrator.
 * The Orchestrator NEVER edits files directly; it writes a short TypeScript workflow
 * script that inspects the workspace with `files.*` / `git.*`, delegates coding work to
 * `agent("coder").ask<T>(...)`, and verifies results with `world.run(...)`.
 */
export const ORCHESTRATOR_FACADE_SYSTEM = [
  "You are the ZCode workflow orchestrator. Call `submit_workflow` with `ts_code` using the global ZCode facade (`phase`, `files.glob`, `files.read`, `files.grep`, `git.status`, `git.diff`, `agent`, `coder.ask<T>`, `world.run`, `log`, `report`) to inspect the workspace, delegate coding to the `coder` agent, and verify tests.",
  "",
  "## Rules for `ts_code`",
  "1. `ts_code` is the body of an async function (NOT a module): NEVER write `import` or `export` statements.",
  "2. The target project may be written in ANY language (Python, Rust, Go, C++, JavaScript, TypeScript, etc.).",
  "3. Only these global facade functions exist:",
  "   - `phase(name: string): void` — must be a top-level statement before `ask` or `world.run` calls.",
  "   - `await files.glob(pattern: string): Promise<string[]>` — list workspace files matching glob.",
  "   - `await files.read(path: string): Promise<string>` — read a workspace file.",
  "   - `await files.grep(pattern: string, glob?: string): Promise<Array<{ path: string; line: number; text: string }>>` — regex search.",
  "   - `await git.status(): Promise<{ branch?: string; clean: boolean; staged: string[]; unstaged: string[]; untracked: string[] }>`",
  "   - `await git.diff(base?: string, path?: string): Promise<string>`",
  "   - `const coder = agent(name: string, persona?: { system?: string })` — create a subagent that has full coding tools (Read, Write, Edit, ApplyPatch, Bash, Grep, Glob).",
  "   - `await coder.ask<T>(instructions: string): Promise<T>` — ask the coding subagent to do the work and return a JSON object matching `T` (`T` must be a plain `interface` declared in your script with no `any`/`unknown`).",
  "   - `await world.run(cmd: string, args?: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>` — run a build/test command (`cmd` MUST be a string literal like `\"python3\"`, `\"pytest\"`, `\"node\"`, `\"cargo\"`, `\"go\"`).",
  "   - `log(message: string): void` and `report(item: unknown): void`",
].join("\n");

export const SUBMIT_WORKFLOW_TOOL: ToolSpec = {
  name: "submit_workflow",
  description: "Compile and execute a ZCode workflow script that delegates coding to subagents.",
  parameters: {
    type: "object",
    properties: {
      ts_code: {
        type: "string",
        description: "The TypeScript workflow script body (no import/export statements).",
      },
    },
    required: ["ts_code"],
  },
};

export const AMEND_WORKFLOW_TOOL: ToolSpec = {
  name: "amend_workflow",
  description: "Compile and execute a revised ZCode workflow script, reusing cached reads and unchanged subagent asks from the previous run.",
  parameters: {
    type: "object",
    properties: {
      ts_code: {
        type: "string",
        description: "The revised TypeScript workflow script body (no import/export statements).",
      },
    },
    required: ["ts_code"],
  },
};

export interface OrchestrateOutcome {
  exitCode: number;
  status: string;
  runId: string;
  runHistory: string[];
  compileAttempts: number;
  workflowTurns: number;
  reusedNodes: number;
  workflowScript: string;
  artifact: unknown;
  summary: string;
  orchestratorLabel: string;
  workerLabel: string;
  effectIds: string[];
}

function extractTsCodeFromText(text: string): string | undefined {
  const toolMatch = /<parameter=ts_code>\s*([\s\S]*?)\s*<\/parameter>/i.exec(text);
  if (toolMatch?.[1]) return toolMatch[1].trim();
  const fenceMatch = /```(?:ts|typescript)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return undefined;
}

/** Build an ImportedRunCache from a previous workflow run in the same session. */
function buildImportedCacheFromRun(store: WorkspaceStore, priorRunId: string): ImportedRunCache {
  const actors = new Map<
    string,
    {
      persona: { name?: string; system?: string; model?: string };
      entries: Array<{ inputHash: string; result: unknown; messageBoundary: number }>;
      transcriptSourceSessionId: string;
    }
  >();
  const nodes = store.journal.listNodes(priorRunId, { kinds: "all", withResult: true });
  const actorRows = store.journal.listActors(priorRunId, { withPersona: true });
  for (const actor of actorRows) {
    if (!actor.name || !actor.sessionId) continue;
    const prefix: Array<{ inputHash: string; result: unknown; messageBoundary: number }> = [];
    const sorted = [
      ...nodes.filter(
        (n) => n.kind === "ask" && n.actorSiteId === actor.siteId && n.actorOrdinal === actor.ordinal,
      ),
    ].sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i]!;
      if (n.status !== "completed" || n.messageBoundary === undefined || (n.actorSeq ?? -1) !== i) break;
      prefix.push({ inputHash: n.inputHash, result: n.result, messageBoundary: n.messageBoundary });
    }
    actors.set(actor.name, {
      persona: actor.persona ?? {},
      entries: prefix,
      transcriptSourceSessionId: actor.sessionId,
    });
  }
  const world = new Map<string, Array<{ inputHash: string; kind: "world-read" | "world-run"; result: unknown }>>();
  for (const n of nodes) {
    if (n.kind !== "world-read" || n.status !== "completed") continue;
    const q = world.get(n.inputHash) ?? [];
    q.push({ inputHash: n.inputHash, kind: n.kind, result: n.result });
    world.set(n.inputHash, q);
  }
  return { actors, world } as unknown as ImportedRunCache;
}

function isArtifactSatisfied(artifact: unknown): boolean {
  if (artifact === null || artifact === undefined || typeof artifact !== "object") return true;
  const obj = artifact as Record<string, unknown>;
  if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return false;
  if (typeof obj.fixed === "boolean" && !obj.fixed) return false;
  if (obj.report && typeof obj.report === "object") {
    const rep = obj.report as Record<string, unknown>;
    if (typeof rep.fixed === "boolean" && !rep.fixed) return false;
  }
  return true;
}

export async function runOrchestratedTask(opts: {
  workspace: string;
  task: string;
  config: ZfacadeConfig;
  orchestratorProvider?: ProviderPort;
  workerProvider?: ProviderPort;
  scriptTextOverride?: string;
  maxCompileTurns?: number;
  maxWorkflowTurns?: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (line: string) => void;
}): Promise<OrchestrateOutcome> {
  const store = openWorkspaceStore(opts.workspace, { env: opts.env });
  try {
    store.effects.recoverScan();
    const workerProvider = opts.workerProvider ?? buildProvider(opts.config, opts.env);
    const orchestratorProvider = opts.orchestratorProvider ?? buildOrchestratorProvider(opts.config, opts.env);
    const maxCompileTurns = opts.maxCompileTurns ?? 4;
    const maxWorkflowTurns = opts.scriptTextOverride ? 1 : (opts.maxWorkflowTurns ?? 3);

    const sessionId = newId("sess");
    store.sessions.insert({
      sessionId,
      workspaceKey: store.workspaceKey,
      runId: "",
      title: opts.task.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const messages: ModelMessage[] = [
      { role: "system", content: ORCHESTRATOR_FACADE_SYSTEM },
      { role: "user", content: opts.task },
    ];

    let totalCompileAttempts = 0;
    let workflowTurns = 0;
    let totalReusedNodes = 0;
    let priorRunId: string | undefined;
    const runHistory: string[] = [];
    const allEffectIds: string[] = [];
    let lastScriptText = opts.scriptTextOverride ?? "";
    let lastStatus = "compile_error";
    let lastArtifact: unknown = null;
    let lastSummary = "";

    for (let wfTurn = 0; wfTurn < maxWorkflowTurns; wfTurn++) {
      let scriptText = opts.scriptTextOverride ?? "";
      let isAmend = false;
      let prepared = scriptText ? prepareWorkflow(scriptText) : undefined;
      if (scriptText) totalCompileAttempts += 1;

      if (!scriptText) {
        const tools = priorRunId ? [SUBMIT_WORKFLOW_TOOL, AMEND_WORKFLOW_TOOL] : [SUBMIT_WORKFLOW_TOOL];
        for (let cTurn = 0; cTurn < maxCompileTurns; cTurn++) {
          totalCompileAttempts += 1;
          const resp = await orchestratorProvider.complete({ messages, tools });
          const wfCall = resp.toolCalls.find(
            (c) => c.name === "submit_workflow" || c.name === "amend_workflow",
          );
          let candidate = "";
          if (wfCall && typeof (wfCall.arguments as { ts_code?: unknown })?.ts_code === "string") {
            candidate = (wfCall.arguments as { ts_code: string }).ts_code;
            isAmend = wfCall.name === "amend_workflow" && priorRunId !== undefined;
          } else {
            candidate = extractTsCodeFromText(resp.text) ?? "";
          }
          if (!candidate.trim()) {
            messages.push({ role: "assistant", content: resp.text });
            messages.push({
              role: "user",
              content: "Call `submit_workflow({ ts_code })` with a valid ZCode TypeScript workflow script.",
            });
            continue;
          }
          scriptText = candidate;
          prepared = prepareWorkflow(scriptText);
          if (prepared.ok) {
            opts.onEvent?.(`orchestrator compiled clean (attempt ${totalCompileAttempts})`);
            if (wfCall) {
              messages.push({ role: "assistant", content: resp.text, toolCalls: [wfCall] });
            } else {
              messages.push({ role: "assistant", content: resp.text });
            }
            break;
          }
          const diagLines = prepared.diagnostics
            .map((d) => `L${d.line}:C${d.column} [TS${d.code}] ${d.message}`)
            .join("\n");
          opts.onEvent?.(`compile diagnostic (${prepared.diagnostics.length}): ${diagLines.split("\n")[0]}`);
          if (wfCall) {
            messages.push({ role: "assistant", content: resp.text, toolCalls: [wfCall] });
            messages.push({
              role: "tool",
              toolCallId: wfCall.id,
              name: wfCall.name,
              content: `Workflow failed to compile:\n${diagLines}\n\nFix the errors and submit again.`,
            });
          } else {
            messages.push({ role: "assistant", content: resp.text });
            messages.push({
              role: "user",
              content: `Workflow failed to compile:\n${diagLines}\n\nFix the errors and submit again.`,
            });
          }
        }
      }

      lastScriptText = scriptText;
      if (!prepared || !prepared.ok) {
        const diagSummary =
          prepared?.diagnostics.map((d) => `L${d.line}:C${d.column} ${d.message}`).join("; ") ??
          "no script submitted";
        lastStatus = "compile_error";
        lastSummary = `compile_error: ${diagSummary}`;
        break;
      }

      workflowTurns += 1;
      const runId = newId("run");
      runHistory.push(runId);
      const commandId = newId("cmd");
      store.commands.insert({
        commandId,
        runId,
        kind: isAmend ? "amend" : "orchestrate",
        payload: { task: opts.task, scriptHash: prepared.scriptHash, priorRunId },
        status: "admitted",
        createdAt: Date.now(),
      });

      const importedCache =
        isAmend && priorRunId ? buildImportedCacheFromRun(store, priorRunId) : undefined;

      const driver = new BoundedDriver({
        store,
        runId,
        runRevision: `${runId}#${workflowTurns}`,
        mode: "provider",
        provider: workerProvider,
        permission: {
          workspaceRoot: store.workspacePath,
          cwd: store.workspacePath,
          grants: opts.config.grants ?? [],
          defaultCommandPolicy: "classify",
        },
        ...(opts.onEvent
          ? {
              onEvent: (event: unknown) => {
                const e = (event ?? {}) as {
                  type?: string;
                  instance?: { siteId?: string; ordinal?: number };
                  cached?: boolean;
                };
                if (e.type && !["node-queued", "node-dispatched", "usage-updated"].includes(e.type)) {
                  const site = e.instance?.siteId ? ` ${e.instance.siteId}#${e.instance.ordinal ?? 1}` : "";
                  const cached = e.cached ? " (cached)" : "";
                  opts.onEvent!(`${e.type}${site}${cached}`);
                }
              },
            }
          : {}),
      });

      const settlement = await executeRun({
        store,
        runId,
        scriptText,
        prepared,
        driver,
        args: { task: opts.task },
        name: isAmend ? "zfacade-amend" : "zfacade-orchestrated",
        ...(importedCache && priorRunId ? { importedCache, resumedFrom: priorRunId } : {}),
        timeoutMs: opts.config.limits?.toolTimeoutMs ? opts.config.limits.toolTimeoutMs * 10 : 600_000,
      });

      totalReusedNodes += driver.reusedNodes;
      store.commands.setStatus(commandId, settlement.status);
      const effects = store.effects.repo.listByRun(runId);
      for (const e of effects) allEffectIds.push(e.operationId);

      lastStatus = settlement.status;
      lastArtifact = settlement.status === "completed" ? settlement.artifact : null;
      lastSummary =
        settlement.status === "completed"
          ? typeof (lastArtifact as { summary?: unknown })?.summary === "string"
            ? (lastArtifact as { summary: string }).summary
            : JSON.stringify(lastArtifact)
          : settlement.status === "errored"
            ? `errored: ${settlement.error.message}`
            : `stopped: ${settlement.reason}`;

      priorRunId = runId;

      if (settlement.status === "completed" && isArtifactSatisfied(lastArtifact)) {
        break;
      }

      if (wfTurn + 1 < maxWorkflowTurns) {
        const lastMsg = messages[messages.length - 1];
        const lastToolCall = lastMsg?.role === "assistant" ? lastMsg.toolCalls?.[0] : undefined;
        const feedback =
          settlement.status === "completed"
            ? `Workflow completed but verification reported an issue: ${JSON.stringify(lastArtifact)}. Submit an amended workflow (\`amend_workflow\` or \`submit_workflow\`) to fix the remaining issue.`
            : `Workflow failed during execution (${lastSummary}). Submit an amended workflow (\`amend_workflow\` or \`submit_workflow\`) to recover and finish the task.`;
        if (lastToolCall) {
          messages.push({
            role: "tool",
            toolCallId: lastToolCall.id,
            name: lastToolCall.name,
            content: feedback,
          });
        } else {
          messages.push({ role: "user", content: feedback });
        }
      }
    }

    const finalRunId = runHistory[runHistory.length - 1] ?? newId("run");
    return {
      exitCode: lastStatus === "completed" ? EXIT.ok : EXIT.infra,
      status: lastStatus,
      runId: finalRunId,
      runHistory,
      compileAttempts: totalCompileAttempts,
      workflowTurns,
      reusedNodes: totalReusedNodes,
      workflowScript: lastScriptText,
      artifact: lastArtifact,
      summary: lastSummary,
      orchestratorLabel: orchestratorProvider.isTestDouble ? "deterministic-test" : orchestratorProvider.id,
      workerLabel: workerProvider.isTestDouble ? "deterministic-test" : workerProvider.id,
      effectIds: allEffectIds,
    };
  } finally {
    store.release();
  }
}
