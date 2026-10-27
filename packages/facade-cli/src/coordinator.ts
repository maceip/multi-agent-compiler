import type { ZfacadeConfig } from "@zfacade/contracts";
import { EXIT, newId } from "@zfacade/contracts";
import { openWorkspaceStore } from "@zfacade/core";
import {
  BoundedDriver, SKELETON_HASH, SKELETON_SOURCE, SKELETON_VERSION,
  executeRun, prepareWorkflow,
} from "@zfacade/agent";
import { buildProvider } from "./config-load.js";

const QUIET_EVENTS = new Set(["node-queued", "node-dispatched", "usage-updated"]);

/**
 * One compact progress line per engine event; never includes model text.
 * Returns undefined for events that carry no news worth a line of output.
 */
function describeEvent(event: unknown): string | undefined {
  const e = (event ?? {}) as {
    type?: unknown;
    instance?: { siteId?: unknown; ordinal?: unknown };
    outcome?: unknown;
  };
  const type = typeof e.type === "string" ? e.type : "event";
  if (QUIET_EVENTS.has(type)) return undefined;
  const siteId = typeof e.instance?.siteId === "string" ? e.instance.siteId : "";
  const ordinal = typeof e.instance?.ordinal === "number" ? `#${e.instance.ordinal}` : "";
  const status = typeof e.outcome === "string" ? ` ${e.outcome}` : "";
  return siteId ? `${type} ${siteId}${ordinal}${status}` : type;
}

export interface RunOutcome {
  exitCode: number;
  status: string;
  runId: string;
  sessionId: string;
  summary: string;
  pendingQuestionIds: string[];
  holdOperationIds: string[];
  effectIds: string[];
  providerLabel: string;
}

export async function runTask(opts: {
  workspace: string; task: string; config: ZfacadeConfig;
  env?: NodeJS.ProcessEnv; onEvent?: (line: string) => void;
}): Promise<RunOutcome> {
  const store = openWorkspaceStore(opts.workspace, { env: opts.env });
  try {
    const held = store.effects.recoverScan();
    const runId = newId("run");
    const commandId = newId("cmd");
    store.commands.insert({
      commandId, runId, kind: "task", payload: { task: opts.task, skeleton: SKELETON_VERSION, skeletonHash: SKELETON_HASH },
      status: "admitted", createdAt: Date.now(),
    });
    const sessions = store.sessions;
    const sessionId = newId("sess");
    sessions.insert({
      sessionId, workspaceKey: store.workspaceKey, runId,
      title: opts.task.slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(),
    });
    const provider = buildProvider(opts.config, opts.env);
    const prepared = prepareWorkflow(SKELETON_SOURCE);
    if (!prepared.ok) throw new Error(`bundled skeleton failed to compile: ${JSON.stringify(prepared.diagnostics)}`);
    const driver = new BoundedDriver({
      store, runId, runRevision: `${runId}#1`, mode: "provider", provider,
      permission: {
        workspaceRoot: store.workspacePath, cwd: store.workspacePath,
        grants: opts.config.grants ?? [], defaultCommandPolicy: "classify",
      },
      ...(opts.onEvent
        ? {
            onEvent: (event: unknown) => {
              const line = describeEvent(event);
              if (line !== undefined) opts.onEvent!(line);
            },
          }
        : {}),
    });
    const settlement = await executeRun({
      store, runId, scriptText: SKELETON_SOURCE, prepared, driver,
      args: { task: opts.task }, name: "zfacade-run",
      timeoutMs: opts.config.limits?.toolTimeoutMs ? opts.config.limits.toolTimeoutMs * 10 : 600_000,
    });
    store.commands.setStatus(commandId, settlement.status);
    const effects = store.effects.repo.listByRun(runId);
    const pending = store.questions.pendingByRun(runId).map((q) => q.questionId);
    const holds = [...held.map((h) => h.operationId), ...effects.filter((e) => e.state === "outcome_unknown").map((e) => e.operationId)];
    let exitCode: number = EXIT.ok;
    if (settlement.status !== "completed") exitCode = EXIT.infra;
    if (pending.length > 0) exitCode = EXIT.pendingHuman;
    else if (holds.length > 0) exitCode = EXIT.recoveryHold;
    else if (effects.some((e) => e.state === "denied")) exitCode = EXIT.denied;
    const summary = settlement.status === "completed"
      ? String((settlement.artifact as { summary?: string })?.summary ?? "completed")
      : settlement.status === "errored" ? `errored: ${settlement.error.message}`
        : `stopped: ${settlement.reason}`;
    opts.onEvent?.(summary);
    return {
      exitCode, status: settlement.status, runId, sessionId, summary,
      pendingQuestionIds: pending, holdOperationIds: holds,
      effectIds: effects.map((e) => e.operationId),
      providerLabel: provider.isTestDouble ? "deterministic-test" : provider.id,
    };
  } finally {
    store.release();
  }
}

export function inspect(opts: { workspace: string; runId?: string; env?: NodeJS.ProcessEnv }): Record<string, unknown> {
  const store = openWorkspaceStore(opts.workspace, { env: opts.env, readOnlyLock: true });
  try {
    const runs = opts.runId ? [store.journal.getRun(opts.runId)].filter(Boolean) : [];
    const holds = store.effects.holds();
    const pendingCommands = store.commands.pending();
    const sessions = store.sessions.list().slice(0, 20);
    const runId = opts.runId ?? sessions[0]?.runId ?? "";
    return {
      workspace: store.workspacePath, workspaceKey: store.workspaceKey,
      usage: store.usage(),
      runs, sessions,
      nodes: runId ? store.journal.listNodes(runId, { kinds: "all", withResult: false }) : [],
      effects: runId ? store.effects.repo.listByRun(runId) : [],
      holds, pendingCommands,
      pendingQuestions: runId ? store.questions.pendingByRun(runId) : [],
      ownerGeneration: store.ownerGeneration,
    };
  } finally {
    store.release();
  }
}

export function recover(opts: {
  workspace: string; env?: NodeJS.ProcessEnv;
  reconcile?: { operationId: string; decision: "mark-completed" | "retry" | "abandon"; evidence?: string };
}): Record<string, unknown> {
  const store = openWorkspaceStore(opts.workspace, { env: opts.env });
  try {
    const scanned = store.effects.recoverScan();
    let reconciled: unknown;
    if (opts.reconcile) {
      reconciled = store.effects.reconcile(opts.reconcile.operationId, opts.reconcile.decision,
        opts.reconcile.evidence ? { note: opts.reconcile.evidence } : undefined);
    }
    return { scannedHolds: scanned, holds: store.effects.holds(), reconciled };
  } finally {
    store.release();
  }
}
