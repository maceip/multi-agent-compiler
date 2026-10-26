import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ModelRequest, ModelResponse, ModelToolCall, ProviderPort } from "@zfacade/contracts";
import { ZfacadeError } from "@zfacade/contracts";

const execFileAsync = promisify(execFile);

interface SseToolAccum { id: string; name: string; argsText: string }

/**
 * Real OpenAI-compatible streaming provider (local endpoint; D2).
 * Live acceptance is pending (S4): no test in this repo claims a live pass.
 * Tool calls are assembled from streamed fragments and JSON-parsed only when
 * complete; a truncated stream yields interrupted=true and no runnable calls.
 */
export class OpenAICompatibleProvider implements ProviderPort {
  readonly isTestDouble = false;
  readonly id: string;
  constructor(
    private readonly baseUrl: string,
    private readonly modelId: string,
    private readonly apiKey: string | undefined,
  ) { this.id = `openai-compatible:${modelId}`; }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    // gpt-5+ / o-series reject `max_tokens`; use `max_completion_tokens` (D15).
    const needsCompletionTokens = /^(gpt-5|o[0-9]|o[0-9]-)/i.test(this.modelId);
    const body = {
      model: this.modelId, stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens !== undefined
        ? (needsCompletionTokens
            ? { max_completion_tokens: request.maxTokens }
            : { max_tokens: request.maxTokens })
        : {}),
      messages: request.messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls) {
          return {
            role: "assistant", content: m.content || null,
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id, type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            })),
          };
        }
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        return { role: m.role, content: m.content };
      }),
      tools: request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok || !res.body) {
      throw new ZfacadeError("ProviderError", `provider HTTP ${res.status} from ${url}`);
    }
    let text = "";
    let finishReason = "";
    let usage: ModelResponse["usage"];
    let sawDone = false;
    const tools = new Map<number, SseToolAccum>();
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { sawDone = true; continue; }
          let chunk: Record<string, unknown>;
          try { chunk = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          const u = chunk.usage as Record<string, number> | undefined;
          if (u) usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens };
          const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
          const delta = (choice.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            request.onTextDelta?.(delta.content);
          }
          const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          for (const tc of tcs ?? []) {
            const index = typeof tc.index === "number" ? tc.index : 0;
            const acc = tools.get(index) ?? { id: "", name: "", argsText: "" };
            if (typeof tc.id === "string" && tc.id) acc.id = tc.id;
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            if (typeof fn.name === "string" && fn.name) acc.name = fn.name;
            if (typeof fn.arguments === "string") acc.argsText += fn.arguments;
            tools.set(index, acc);
          }
        }
      }
    } catch (e) {
      if (request.signal?.aborted) throw new ZfacadeError("ProviderCancelled", "provider request cancelled");
      // Transport failure mid-stream: incomplete response, never runnable.
      return { modelId: this.modelId, text, toolCalls: [], finishReason: "interrupted", interrupted: true, usage };
    }
    const toolCalls: ModelToolCall[] = [];
    let interrupted = !sawDone && finishReason === "";
    for (const [index, acc] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
      try {
        toolCalls.push({ id: acc.id || `call_${index}`, name: acc.name, arguments: JSON.parse(acc.argsText || "{}") as unknown });
      } catch {
        interrupted = true; // truncated tool JSON: execute nothing (A4)
      }
    }
    if (interrupted) return { modelId: this.modelId, text, toolCalls: [], finishReason: finishReason || "interrupted", interrupted: true, usage };
    return { modelId: this.modelId, text, toolCalls, finishReason: finishReason || "stop", usage };
  }
}

interface DeterministicStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  finishReason?: string;
}

/** Explicit test double. Never a default; receipts label it deterministic-test. */
export class DeterministicProvider implements ProviderPort {
  readonly isTestDouble = true;
  readonly id = "deterministic-test";
  private idx = 0;
  constructor(private readonly steps: DeterministicStep[]) {}
  static fromFile(path: string): DeterministicProvider {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { steps: DeterministicStep[] };
    if (!Array.isArray(parsed.steps)) throw new ZfacadeError("ConfigInvalid", "deterministic script needs a steps array");
    return new DeterministicProvider(parsed.steps);
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new ZfacadeError("ProviderCancelled", "cancelled");
    const step = this.steps[this.idx++];
    if (!step) throw new ZfacadeError("ProviderError", "deterministic script exhausted");
    const text = step.text ?? "";
    if (text) request.onTextDelta?.(text);
    return {
      modelId: "deterministic-test", text,
      toolCalls: (step.toolCalls ?? []).map((t, i) => ({ id: `det_${this.idx}_${i}`, name: t.name, arguments: t.arguments })),
      finishReason: step.finishReason ?? (step.toolCalls?.length ? "tool_calls" : "stop"),
    };
  }
}

const TINKER_SAMPLE_SCRIPT = `
import asyncio, json, os, sys
from pathlib import Path

payload = json.loads(sys.stdin.read())
model = payload["modelId"]
checkpoint_path = payload.get("checkpointPath")
renderer_name = payload.get("renderer") or "qwen3_5_disable_thinking"
max_tokens = int(payload.get("maxTokens") or 768)
messages = payload["messages"]
tools = payload["tools"]

import tinker
from tinker_cookbook.renderers import get_renderer, get_text_content
from tinker_cookbook.renderers.base import ToolCall
from tinker_cookbook.tokenizer_utils import get_tokenizer

async def run():
    client = tinker.ServiceClient()
    if checkpoint_path:
        meta = json.loads(Path(checkpoint_path).read_text())
        sampler = await client.create_sampling_client_async(model_path=meta["sampler_path"])
    else:
        sampler = await client.create_sampling_client_async(base_model=model)
    renderer = get_renderer(renderer_name, get_tokenizer(model))
    oai_tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in tools]
    sys_msg = next((m["content"] for m in messages if m["role"] == "system"), "")
    conv = renderer.create_conversation_prefix_with_tools(oai_tools, sys_msg) if oai_tools else [{"role": "system", "content": sys_msg}]
    for m in messages:
        if m["role"] == "system":
            continue
        if m["role"] == "assistant" and m.get("toolCalls"):
            tcs = [ToolCall(id=c["id"], function=ToolCall.FunctionBody(name=c["name"], arguments=json.dumps(c["arguments"]))) for c in m["toolCalls"]]
            conv.append({"role": "assistant", "content": m.get("content", ""), "tool_calls": tcs})
        elif m["role"] == "tool":
            conv.append({"role": "tool", "name": m.get("name", ""), "tool_call_id": m.get("toolCallId", ""), "content": m.get("content", "")})
        else:
            conv.append({"role": m["role"], "content": m.get("content", "")})
    prompt = renderer.build_generation_prompt(conv)
    resp = await sampler.sample_async(
        prompt=prompt,
        num_samples=1,
        sampling_params=tinker.SamplingParams(max_tokens=max_tokens, temperature=0.2, stop=renderer.get_stop_sequences()),
    )
    seq = resp.sequences[0]
    tokens = list(seq.tokens)
    msg, term = renderer.parse_response(tokens)
    out_calls = []
    for i, c in enumerate(msg.get("tool_calls") or []):
        try:
            args = json.loads(c.function.arguments)
        except Exception:
            args = {}
        out_calls.append({"id": getattr(c, "id", None) or f"tinker_call_{i}", "name": c.function.name, "arguments": args})
    text = get_text_content(msg) if isinstance(msg, dict) else ""
    print(json.dumps({
        "modelId": f"tinker:{model}" + (f"@{Path(checkpoint_path).stem}" if checkpoint_path else ""),
        "text": text,
        "toolCalls": out_calls,
        "finishReason": "tool_calls" if out_calls else ("stop" if term.is_clean else "length"),
        "usage": {"promptTokens": prompt.length, "completionTokens": len(tokens), "totalTokens": prompt.length + len(tokens)},
    }))

asyncio.run(run())
`;

/** Native Tinker provider for sampling base or fine-tuned LoRA orchestrator checkpoints. */
export class TinkerProvider implements ProviderPort {
  readonly isTestDouble = false;
  readonly id: string;
  private readonly pythonBin: string;

  constructor(
    private readonly modelId: string,
    private readonly checkpointPath: string | undefined,
    private readonly renderer: string = "qwen3_5_disable_thinking",
    private readonly apiKey: string | undefined = undefined,
    pythonBin?: string,
  ) {
    this.id = checkpointPath ? `tinker:${modelId}@${checkpointPath}` : `tinker:${modelId}`;
    this.pythonBin = pythonBin ?? "/Users/mac/zfacade-tinker/.venv/bin/python";
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey && !process.env.TINKER_API_KEY) {
      throw new ZfacadeError("ProviderError", "TINKER_API_KEY is required for TinkerProvider");
    }
    const payload = JSON.stringify({
      modelId: this.modelId,
      checkpointPath: this.checkpointPath,
      renderer: this.renderer,
      maxTokens: request.maxTokens ?? 768,
      messages: request.messages,
      tools: request.tools,
    });
    const childPromise = execFileAsync(this.pythonBin, ["-c", TINKER_SAMPLE_SCRIPT], {
      env: {
        ...process.env,
        ...(this.apiKey ? { TINKER_API_KEY: this.apiKey } : {}),
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    childPromise.child.stdin?.write(payload);
    childPromise.child.stdin?.end();
    const { stdout } = await childPromise;
    const lines = stdout.trim().split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) throw new ZfacadeError("ProviderError", "empty response from TinkerProvider");
    return JSON.parse(lastLine) as ModelResponse;
  }
}
