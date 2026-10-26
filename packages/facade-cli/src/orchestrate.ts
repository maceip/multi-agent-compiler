import type { ModelMessage, ProviderPort, ToolSpec, ZfacadeConfig } from "@zfacade/contracts";
import { EXIT, newId } from "@zfacade/contracts";
import { openWorkspaceStore } from "@zfacade/core";
import { BoundedDriver, executeRun, prepareWorkflow } from "@zfacade/agent";
import { buildProvider } from "./config-load.js";

/**
 * The language-agnostic ~10-function ZCode workflow facade prompt for the Orchestrator.
 * The Orchestrator NEVER edits files directly; it writes a short TypeScript workflow
 * script that inspects the workspace with `files.*` / `git.*`, delegates coding work to
 * `agent("coder").ask<T>(...)`, and verifies results with `world.run(...)`.
 */
export const ORCHESTRATOR_FACADE_SYSTEM = [
  "You are the workflow orchestrator. Your ONLY job is to call `submit_workflow` with a valid TypeScript workflow script (`ts_code`).",
  "Do not write prose. Call `submit_workflow` directly.",
  "",
  "## Rules for `ts_code`",
  "1. `ts_code` is the body of an async function (NOT a module): NEVER write `import` or `export` statements.",
  "2. The target project may be written in ANY language (Python, Rust, Go, C++, JavaScript, TypeScript, etc.).",
  "3. Only these global facade functions exist:",
  "   - `phase(name: string): void` — must be a top-level statement before `ask` or `world.run` calls (e.g. `phase(\"Inspect\");`).",
  "   - `await files.glob(pattern: string): Promise<string[]>` — list workspace files matching glob.",
  "   - `await files.read(path: string): Promise<string>` — read a workspace file.",
  "   - `await files.grep(pattern: string, glob?: string): Promise<Array<{ path: string; line: number; text: string }>>` — regex search.",
  "   - `await git.status(): Promise<{ branch?: string; clean: boolean; staged: string[]; unstaged: string[]; untracked: string[] }>`",
  "   - `await git.diff(base?: string, path?: string): Promise<string>`",
  "   - `const coder = agent(name: string, persona?: { system?: string })` — create a subagent that has full coding tools (Read, Write, Edit, Bash, Grep, Glob).",
  "   - `await coder.ask<T>(instructions: string): Promise<T>` — ask the coding subagent to do the work and return a JSON object matching `T` (`T` must be a plain `interface` declared in your script with no `any`/`unknown`).",
  "   - `await world.run(cmd: string, args?: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>` — run a build/test command (`cmd` MUST be a string literal like `\"python3\"`, `\"pytest\"`, `\"node\"`, `\"cargo\"`, `\"go\"`).",
  "   - `log(message: string): void` and `report(item: unknown): void`",
  "",
  "## Canonical Pattern",
  "```ts",
  "interface FixReport {",
  "  fixed: boolean;",
  "  filesChanged: string[];",
  "  summary: string;",
  "}",
  "phase(\"Inspect\");",
  "const allFiles = await files.glob(\"**/*\");",
  "log(`Found ${allFiles.length} files`);",
  "phase(\"Implement\");",
  "const coder = agent(\"coder\", { system: \"You are a senior software engineer. Read the files, fix the bug, and run the project tests.\" });",
  "let result = await coder.ask<FixReport>(`Task: ${String(args.task ?? \"\")}\\nFiles in workspace: ${allFiles.join(\", \")}`);",
  "return result;",
  "```",
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

export interface OrchestrateOutcome {
  exitCode: number;
  status: string;
  runId: string;
  compileAttempts: number;
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

export async function runOrchestratedTask(opts: {
  workspace: string;
  task: string;
  config: ZfacadeConfig;
  orchestratorProvider?: ProviderPort;
  workerProvider?: ProviderPort;
  scriptTextOverride?: string;
  maxCompileTurns?: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (line: string) => void;
}): Promise<OrchestrateOutcome> {
  const store = openWorkspaceStore(opts.workspace, { env: opts.env });
  try {
    store.effects.recoverScan();
    const runId = newId("run");
    const commandId = newId("cmd");
    const workerProvider = opts.workerProvider ?? buildProvider(opts.config, opts.env);
    const orchestratorProvider = opts.orchestratorProvider ?? workerProvider;
    const maxCompileTurns = opts.maxCompileTurns ?? 4;

    let scriptText = opts.scriptTextOverride ?? "";
    let prepared = scriptText ? prepareWorkflow(scriptText) : undefined;
    let compileAttempts = scriptText ? 1 : 0;

    if (!scriptText) {
      const messages: ModelMessage[] = [
        { role: "system", content: ORCHESTRATOR_FACADE_SYSTEM },
        {
          role: "user",
          content: `Write and submit a workflow script for this task:\n\n${opts.task}`,
        },
      ];
      for (let turn = 0; turn < maxCompileTurns; turn++) {
        compileAttempts += 1;
        const resp = await orchestratorProvider.complete({
          messages,
          tools: [SUBMIT_WORKFLOW_TOOL],
        });
        const submitCall = resp.toolCalls.find((c) => c.name === "submit_workflow");
        let candidate = "";
        if (submitCall && typeof (submitCall.arguments as { ts_code?: unknown })?.ts_code === "string") {
          candidate = (submitCall.arguments as { ts_code: string }).ts_code;
        } else {
          candidate = extractTsCodeFromText(resp.text) ?? "";
        }
        if (!candidate.trim()) {
          messages.push({ role: "assistant", content: resp.text });
          messages.push({
            role: "user",
            content: "You did not call `submit_workflow({ ts_code })`. Call `submit_workflow` with the workflow script body now.",
          });
          continue;
        }
        scriptText = candidate;
        prepared = prepareWorkflow(scriptText);
        if (prepared.ok) {
          opts.onEvent?.(`orchestrator compiled clean on attempt ${compileAttempts}`);
          break;
        }
        const diagLines = prepared.diagnostics
          .map((d) => `L${d.line}:C${d.column} [TS${d.code}] ${d.message}`)
          .join("\n");
        opts.onEvent?.(`compile attempt ${compileAttempts} had ${prepared.diagnostics.length} diagnostic(s)`);
        if (submitCall) {
          messages.push({ role: "assistant", content: resp.text, toolCalls: [submitCall] });
          messages.push({
            role: "tool",
            toolCallId: submitCall.id,
            name: "submit_workflow",
            content: `Workflow failed to compile:\n${diagLines}\n\nFix the errors and call submit_workflow again.`,
          });
        } else {
          messages.push({ role: "assistant", content: resp.text });
          messages.push({
            role: "user",
            content: `Workflow failed to compile:\n${diagLines}\n\nFix the errors and call submit_workflow again.`,
          });
        }
      }
    }

    if (!prepared || !prepared.ok) {
      const diagSummary = prepared?.diagnostics.map((d) => `L${d.line}:C${d.column} ${d.message}`).join("; ") ?? "no script submitted";
      return {
        exitCode: EXIT.infra,
        status: "compile_error",
        runId,
        compileAttempts,
        workflowScript: scriptText,
        artifact: null,
        summary: `compile_error: ${diagSummary}`,
        orchestratorLabel: orchestratorProvider.isTestDouble ? "deterministic-test" : orchestratorProvider.id,
        workerLabel: workerProvider.isTestDouble ? "deterministic-test" : workerProvider.id,
        effectIds: [],
      };
    }

    store.commands.insert({
      commandId,
      runId,
      kind: "orchestrate",
      payload: { task: opts.task, scriptHash: prepared.scriptHash, compileAttempts },
      status: "admitted",
      createdAt: Date.now(),
    });
    const sessionId = newId("sess");
    store.sessions.insert({
      sessionId,
      workspaceKey: store.workspaceKey,
      runId,
      title: opts.task.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const driver = new BoundedDriver({
      store,
      runId,
      runRevision: `${runId}#1`,
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
              const e = (event ?? {}) as { type?: string; instance?: { siteId?: string; ordinal?: number } };
              if (e.type && !["node-queued", "node-dispatched", "usage-updated"].includes(e.type)) {
                const site = e.instance?.siteId ? ` ${e.instance.siteId}#${e.instance.ordinal ?? 1}` : "";
                opts.onEvent!(`${e.type}${site}`);
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
      name: "zfacade-orchestrated",
      timeoutMs: opts.config.limits?.toolTimeoutMs ? opts.config.limits.toolTimeoutMs * 10 : 600_000,
    });

    store.commands.setStatus(commandId, settlement.status);
    const effects = store.effects.repo.listByRun(runId);
    const artifact = settlement.status === "completed" ? settlement.artifact : null;
    const summary =
      settlement.status === "completed"
        ? typeof (artifact as { summary?: unknown })?.summary === "string"
          ? (artifact as { summary: string }).summary
          : JSON.stringify(artifact)
        : settlement.status === "errored"
          ? `errored: ${settlement.error.message}`
          : `stopped: ${settlement.reason}`;

    return {
      exitCode: settlement.status === "completed" ? EXIT.ok : EXIT.infra,
      status: settlement.status,
      runId,
      compileAttempts,
      workflowScript: scriptText,
      artifact,
      summary,
      orchestratorLabel: orchestratorProvider.isTestDouble ? "deterministic-test" : orchestratorProvider.id,
      workerLabel: workerProvider.isTestDouble ? "deterministic-test" : workerProvider.id,
      effectIds: effects.map((e) => e.operationId),
    };
  } finally {
    store.release();
  }
}
