import { sha256Hex } from "@zfacade/contracts";
import type { ToolSpec } from "@zfacade/contracts";

/**
 * Trusted host-authored coding skeleton (plan 4.1). Bundled and hash-pinned;
 * model output enters only as data (ask instructions/answers), never as code.
 * Each ask is exactly one bounded model step in the driver; the loop lives
 * here so the engine sees every step as its own node.
 */
const CODER_SYSTEM = [
  "You are zfacade, a coding agent working inside one workspace directory.",
  "Complete the task by calling tools. Each reply may call any number of them.",
  "All paths are workspace-relative and must stay inside the workspace.",
  "The project may be written in any language. Discover its conventions from its",
  "own files and build configuration instead of assuming; never assume TypeScript.",
  "Read the real files before changing them, and match the surrounding style.",
  "After editing, verify by running the project's own build, vet, or test command.",
  "If a command is denied, do not retry it verbatim; use an allowed equivalent.",
  "When the task is complete and verified, reply with no tool calls at all and a",
  "two-sentence summary of what you changed. Any reply with tool calls means you",
  "are not finished. Do not restate the plan; just do the next step.",
].join(" ");

export const SKELETON_SOURCE = [
  'phase("coding");',
  "const coder = agent(\"coder\", { system: " + JSON.stringify(CODER_SYSTEM) + " });",
  'const task = String(args.task ?? "");',
  "let stepText = await coder.ask(task);",
  "let step = JSON.parse(stepText);",
  "let guard = 0;",
  "while (!step.done && guard < 200) {",
  "  guard += 1;",
  '  stepText = await coder.ask("Continue.");',
  "  step = JSON.parse(stepText);",
  "}",
  "return step;",
  "",
].join("\n");

export const SKELETON_HASH = sha256Hex(SKELETON_SOURCE);
export const SKELETON_VERSION = "skeleton-2";

export interface StepEnvelope {
  done: boolean;
  summary: string;
  toolResults: Array<{ tool: string; ok: boolean; text: string; operationId: string }>;
  providerLabel: string;
}

export const CODING_TOOLS: ToolSpec[] = [
  { name: "Read", description: "Read a workspace file as UTF-8 text.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "Write", description: "Write (atomically replace) a workspace file with full content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "Edit", description: "Replace one unique exact string in a workspace file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } },
  { name: "ApplyPatch", description: "Apply a unified diff patch inside the workspace.", parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
  { name: "Bash", description: "Run a command as a fixed argv array (never a shell) in the workspace.", parameters: { type: "object", properties: { argv: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" } }, required: ["argv"] } },
  { name: "Grep", description: "Search file contents with a ripgrep regex; optional glob narrows paths.", parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
  { name: "Glob", description: "List workspace-relative files matching a glob pattern.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];
