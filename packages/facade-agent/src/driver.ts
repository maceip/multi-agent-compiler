import { readFileSync, statSync } from "node:fs";
import type {
  ActorRef, ArtifactPublishRequest, ArtifactVersionRecord, AskMessage,
  InstanceRef, PersonaSpec, RunEvent, SessionRef, SubmitVerdict,
  WorkflowDriver, WorkflowReportSink, WorldOpContext, WorldReadOp,
} from "@zcode/dynamic-workflow";
import { WorkflowError, refToString } from "@zcode/dynamic-workflow";
import type { ModelMessage, ProviderPort, ToolName } from "@zfacade/contracts";
import { READONLY_TOOLS, TOOL_NAMES } from "@zfacade/contracts";
import type { PermissionContext, WorkspaceStore } from "@zfacade/core";
import { resolveInside, tx } from "@zfacade/core";
import { CODING_TOOLS, type StepEnvelope } from "./skeleton.js";
import { HoldError, PendingHumanError, ToolDeniedError, ToolExecutor, type ToolCallContext } from "./tools.js";
import type { SandboxSpec } from "./sandbox.js";

export interface ParkedAsk {
  session: SessionRef;
  instance: InstanceRef;
  message: AskMessage;
  parkedAt: number;
}

export interface DriverDeps {
  store: WorkspaceStore;
  runId: string;
  runRevision: string;
  permission: PermissionContext;
  mode: "provider" | "external";
  provider?: ProviderPort;
  onEvent?: (event: RunEvent) => void;
  onParked?: (parked: ParkedAsk) => void;
  maxStepsPerAskRepair?: number;
  gates?: Record<string, { argv: string[]; typecheckArgv?: string[] }>;
  sandbox?: SandboxSpec;
  toolTimeoutMs?: number;
}

const EXT_CONTENT_TYPES: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html",
  ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png",
};

export class BoundedDriver implements WorkflowDriver {
  readonly journal: WorkspaceStore["journal"];
  readonly tools: ToolExecutor;
  private sink: WorkflowReportSink | undefined;
  private readonly aborts = new Map<string, AbortController>();
  private readonly parked = new Map<string, ParkedAsk>();
  private readonly submitWaiters = new Map<string, (v: SubmitVerdict) => void>();
  private readonly mutated = new Set<string>();
  stepCount = 0;
  failedAttempts = 0;
  readonly gateReceiptIds: string[] = [];
  reusedNodes = 0;
  /** Policy denials observed at the world-op edge (no effect row may exist yet). */
  readonly denials: string[] = [];

  constructor(private readonly deps: DriverDeps) {
    this.journal = deps.store.journal;
    this.tools = new ToolExecutor(deps.store);
    if (deps.mode === "provider" && !deps.provider) throw new Error("provider mode requires a provider");
  }

  attach(sink: WorkflowReportSink): void { this.sink = sink; }
  emit(event: RunEvent): void {
    if (event.type === "node-settled" && event.cached) this.reusedNodes += 1;
    this.deps.onEvent?.(event);
  }

  private stampBoundary(instance: InstanceRef, sessionId: string): void {
    try {
      const node = this.journal.getNode(this.deps.runId, instance.siteId, instance.ordinal);
      if (node) {
        this.journal.putNode({ ...node, messageBoundary: this.deps.store.sessions.messages(sessionId).length });
      }
    } catch { /* boundary is an amend-resume aid; settlement already recorded */ }
  }
  parkedAsks(): ParkedAsk[] { return [...this.parked.values()]; }

  async createActorSession(actor: ActorRef, persona: PersonaSpec, seed?: { sourceSessionId: string; messageCount: number }): Promise<SessionRef> {
    const sessionId = `sess:${this.deps.runId}:${refToString(actor)}`;
    const sessions = this.deps.store.sessions;
    const existing = sessions.list().find((s) => s.sessionId === sessionId);
    if (!existing) {
      sessions.insert({
        sessionId, workspaceKey: this.deps.store.workspaceKey, runId: this.deps.runId,
        title: persona.name ?? refToString(actor), createdAt: Date.now(), updatedAt: Date.now(),
      });
      if (persona.system) sessions.appendMessage(sessionId, "system", { role: "system", content: persona.system });
      if (seed) {
        const source = sessions.messages(seed.sourceSessionId).slice(0, seed.messageCount);
        for (const m of source) sessions.appendMessage(sessionId, m.role, m.content, m.stepId);
      }
    }
    const started = Promise.resolve({ id: sessionId });
    return started;
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    if (this.deps.mode === "external") {
      const parked: ParkedAsk = { session, instance, message, parkedAt: Date.now() };
      this.parked.set(refToString(instance), parked);
      this.deps.onParked?.(parked);
      return;
    }
    queueMicrotask(() => { void this.runStep(session, instance, message); });
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    const waiter = this.submitWaiters.get(refToString(instance));
    if (waiter) { this.submitWaiters.delete(refToString(instance)); waiter(verdict); }
  }

  cancelAsk(instance: InstanceRef): void {
    this.aborts.get(refToString(instance))?.abort();
    this.parked.delete(refToString(instance));
  }

  dispose(): void {
    for (const c of this.aborts.values()) c.abort();
    this.aborts.clear();
  }

  /** External (bridge) settlement of a parked ask with validated data. Returns the engine verdict. */
  async resolveParkedData(instanceKey: string, value: unknown): Promise<SubmitVerdict> {
    const parked = this.parked.get(instanceKey);
    if (!parked) throw new Error(`no parked ask ${instanceKey}`);
    const verdictPromise = new Promise<SubmitVerdict>((res) => this.submitWaiters.set(instanceKey, res));
    this.sink!.askSubmitAttempted(parked.instance, value);
    const verdict = await verdictPromise;
    if (verdict.kind === "accept") {
      this.parked.delete(instanceKey);
      this.stampBoundary(parked.instance, parked.session.id);
    }
    return verdict;
  }

  resolveParkedText(instanceKey: string, finalText: string): void {
    const parked = this.parked.get(instanceKey);
    if (!parked) throw new Error(`no parked ask ${instanceKey}`);
    this.parked.delete(instanceKey);
    this.sink!.askTurnEnded(parked.instance, finalText);
    this.stampBoundary(parked.instance, parked.session.id);
  }

  failParked(instanceKey: string, message: string): void {
    const parked = this.parked.get(instanceKey);
    if (!parked) return;
    this.parked.delete(instanceKey);
    this.sink!.askFailed(parked.instance, new WorkflowError("DriverError", message));
  }

  async executeWorldRead(op: WorldReadOp, args: unknown[], ctx?: WorldOpContext): Promise<unknown> {
    const instance = ctx?.instance ?? { siteId: `world#${op}`, ordinal: 1 };
    const toolCtx: ToolCallContext = {
      runId: this.deps.runId, runRevision: this.deps.runRevision,
      siteId: instance.siteId, ordinal: instance.ordinal, toolOrdinal: 0,
      permission: this.deps.permission,
      gates: this.deps.gates, gateReceiptIds: this.gateReceiptIds, sandbox: this.deps.sandbox,
      timeoutMs: this.deps.toolTimeoutMs,
    };
    try {
      return await this.tools.world(op, args, toolCtx);
    } catch (e) {
      if (e instanceof PendingHumanError) throw new WorkflowError("DriverError", `pending permission ${e.question.questionId} for ${op}`);
      if (e instanceof HoldError) throw new WorkflowError("OutcomeUnknown", `recovery hold on ${e.effect.operationId}`);
      if (e instanceof ToolDeniedError) { this.denials.push(`${op}: ${e.message}`); throw new WorkflowError("DriverError", e.message); }
      throw e;
    }
  }

  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    const root = this.deps.permission.workspaceRoot;
    const opts = (request.opts ?? {}) as { title?: string; description?: string; contentType?: string };
    let bytes: Uint8Array;
    let contentType = opts.contentType;
    if (request.op === "file") {
      if (!request.path) throw new WorkflowError("ArtifactSourceMissing", "artifact.file requires a path");
      let abs: string;
      try { abs = resolveInside(root, request.path); }
      catch { throw new WorkflowError("ArtifactPathOutsideWorkspace", `outside workspace: ${request.path}`); }
      try { bytes = new Uint8Array(readFileSync(abs)); }
      catch { throw new WorkflowError("ArtifactSourceMissing", `missing file: ${request.path}`); }
      if (bytes.length > 20 * 1024 * 1024) throw new WorkflowError("ArtifactTooLarge", "file exceeds 20 MiB cap");
      const dot = request.path.lastIndexOf(".");
      contentType ??= EXT_CONTENT_TYPES[request.path.slice(dot).toLowerCase()] ?? "application/octet-stream";
      void statSync;
    } else {
      const content = request.content ?? "";
      bytes = new TextEncoder().encode(content);
      if (bytes.length > 256 * 1024) throw new WorkflowError("ArtifactTooLarge", "markdown exceeds 256 KB cap");
      contentType ??= "text/markdown";
    }
    const uri = this.deps.store.putArtifact(request.runId, `published:${request.op}`, bytes, contentType);
    const record: ArtifactVersionRecord = {
      id: request.id, kind: request.op, version: request.version,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.description ? { description: opts.description } : {}),
      contentType, bytes: bytes.length, uri,
      ...(request.path ? { sourcePath: request.path } : {}),
      publishedAt: Date.now(),
    };
    return record;
  }

  private transcript(sessionId: string): ModelMessage[] {
    return this.deps.store.sessions.messages(sessionId)
      .map((m) => m.content as ModelMessage)
      .filter((m) => m && typeof m === "object" && "role" in m);
  }

  private async runStep(session: SessionRef, instance: InstanceRef, message: AskMessage): Promise<void> {
    const sink = this.sink!;
    const key = refToString(instance);
    const provider = this.deps.provider!;
    const sessions = this.deps.store.sessions;
    const controller = new AbortController();
    this.aborts.set(key, controller);
    this.stepCount += 1;
    try {
      sink.askExecuting(instance);
      const initialContent = message.typed && message.schema !== undefined
        ? `${message.instructions}\n\nYou may call workspace tools (Read, Write, Edit, ApplyPatch, Bash, Grep, Glob) across as many turns as needed to complete the task in whatever language the workspace uses. When you are completely finished and calling no more tools, your final reply text MUST be ONLY a valid JSON object matching this JSON Schema (no markdown fences, no extra prose):\n${JSON.stringify(message.schema)}`
        : message.instructions;
      sessions.appendMessage(session.id, "user", { role: "user", content: initialContent }, key);
      let repairs = 0;
      let toolTurns = 0;
      const maxRepairs = this.deps.maxStepsPerAskRepair ?? 2;
      const maxToolTurns = 30;
      for (;;) {
        const response = await provider.complete({
          messages: this.transcript(session.id), tools: CODING_TOOLS, signal: controller.signal,
        });
        if (response.interrupted) {
          sessions.appendMessage(session.id, "assistant", { role: "assistant", content: "", interrupted: true }, key);
          this.failedAttempts += 1;
          sink.askFailed(instance, new WorkflowError("DriverError", "provider stream interrupted; no tool calls executed"));
          return;
        }
        // Accept: persist the complete response and pre-admit ordered tool intents
        // in one transaction before any tool runs (plan 5.2.2).
        const toolCalls = response.toolCalls;
        tx(this.deps.store.db, () => {
          sessions.appendMessage(session.id, "assistant",
            { role: "assistant", content: response.text, toolCalls }, key);
          toolCalls.forEach((call, i) => {
            this.deps.store.effects.admit({
              runId: this.deps.runId, runRevision: this.deps.runRevision,
              siteId: instance.siteId, ordinal: instance.ordinal, toolOrdinal: i,
              toolName: call.name, input: (call.arguments ?? {}) as Record<string, unknown>,
              cwd: this.deps.permission.cwd,
            });
          });
        });
        const envelope: StepEnvelope = {
          done: toolCalls.length === 0,
          summary: response.text || `ran ${toolCalls.length} tool call(s)`,
          toolResults: [], providerLabel: provider.isTestDouble ? "deterministic-test" : response.modelId,
        };
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i]!;
          const toolName = call.name as ToolName;
          if (!(TOOL_NAMES as readonly string[]).includes(toolName)) {
            envelope.toolResults.push({ tool: call.name, ok: false, text: `unknown tool: ${call.name}`, operationId: "" });
            sessions.appendMessage(session.id, "tool", { role: "tool", toolCallId: call.id, name: call.name, content: `unknown tool: ${call.name}` }, key);
            continue;
          }
          if (!READONLY_TOOLS.has(toolName) && !this.mutated.has(key)) {
            this.mutated.add(key);
            sink.askMutating(instance);
          }
          try {
            const out = await this.tools.execute(toolName, call.arguments, {
              runId: this.deps.runId, runRevision: this.deps.runRevision,
              siteId: instance.siteId, ordinal: instance.ordinal, toolOrdinal: i,
              permission: this.deps.permission, signal: controller.signal, sandbox: this.deps.sandbox,
            });
            envelope.toolResults.push({ tool: call.name, ok: out.ok, text: out.text.slice(0, 4000), operationId: out.effect.operationId });
            sessions.appendMessage(session.id, "tool", { role: "tool", toolCallId: call.id, name: call.name, content: out.text.slice(0, 16384) }, key);
          } catch (e) {
            if (e instanceof ToolDeniedError) {
              envelope.toolResults.push({ tool: call.name, ok: false, text: `denied: ${e.message}`, operationId: "" });
              sessions.appendMessage(session.id, "tool", { role: "tool", toolCallId: call.id, name: call.name, content: `denied: ${e.message}` }, key);
              continue;
            }
            throw e;
          }
        }
        sink.askStats(instance, {
          tokens: response.usage?.totalTokens ?? 0,
          toolCalls: toolCalls.length, turns: 1, worldToolCalls: toolCalls.length,
        });
        if (!message.typed) {
          sink.askTurnEnded(instance, JSON.stringify(envelope));
          this.stampBoundary(instance, session.id);
          return;
        }
        // Typed ask: if the worker agent called tools on this turn, continue the loop
        // so it can observe tool outputs and finish the task before submitting JSON.
        if (toolCalls.length > 0) {
          toolTurns += 1;
          if (toolTurns > maxToolTurns) {
            this.failedAttempts += 1;
            sink.askFailed(instance, new WorkflowError("DriverError", `exceeded max tool turns (${maxToolTurns}) in typed ask`));
            return;
          }
          continue;
        }
        // Typed ask final reply: strip optional outer markdown fence, then parse JSON.
        let cleanedText = response.text.trim();
        const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(cleanedText);
        if (fenceMatch?.[1]) cleanedText = fenceMatch[1].trim();
        let payload: unknown;
        try { payload = JSON.parse(cleanedText) as unknown; }
        catch { payload = undefined; }
        if (payload === undefined) {
          this.failedAttempts += 1;
          if (repairs >= maxRepairs) {
            sink.askFailed(instance, new WorkflowError("ValidationFailed", "typed ask reply was not valid JSON"));
            return;
          }
          repairs += 1;
          sessions.appendMessage(session.id, "user", {
            role: "user",
            content: "Your previous reply was not valid JSON. Reply now with ONLY a valid JSON object matching the required JSON Schema (no markdown fences or prose).",
          }, key);
          continue;
        }
        const verdictPromise = new Promise<SubmitVerdict>((res) => this.submitWaiters.set(key, res));
        sink.askSubmitAttempted(instance, payload);
        const verdict = await verdictPromise;
        if (verdict.kind === "accept") { this.stampBoundary(instance, session.id); return; }
        this.failedAttempts += 1;
        if (repairs >= maxRepairs) {
          sink.askFailed(instance, new WorkflowError("ValidationFailed", "typed submission rejected after bounded repairs"));
          return;
        }
        repairs += 1;
        const note = verdict.kind === "reject"
          ? `Your previous reply failed validation: ${JSON.stringify(verdict.violations)}. Reply again with valid JSON only.`
          : "Submit a result now as valid JSON only.";
        sessions.appendMessage(session.id, "user", { role: "user", content: note }, key);
      }
    } catch (e) {
      this.failedAttempts += 1;
      if (e instanceof PendingHumanError) {
        sink.askFailed(instance, new WorkflowError("DriverError", `pending permission question ${e.question.questionId}`));
      } else if (e instanceof HoldError) {
        sink.askFailed(instance, new WorkflowError("OutcomeUnknown", `recovery hold on effect ${e.effect.operationId}`));
      } else {
        sink.askFailed(instance, e instanceof WorkflowError ? e : new WorkflowError("DriverError", e instanceof Error ? e.message : String(e)));
      }
    } finally {
      this.aborts.delete(key);
    }
  }
}
