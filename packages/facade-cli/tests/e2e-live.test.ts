import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MAIN = join(ROOT, "packages/facade-cli/dist/main.js");
const CHECKPOINT = "/Users/mac/zfacade-tinker/checkpoints/universal-4b/orchestrator.json";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Real Live End-to-End Test: Trained Qwen3.5-4B (Tinker) Orchestrator -> ZCode Facade Compiler/Engine -> OpenAI gpt-5.5 Worker", () => {
  it("runs `zfacade run` end-to-end on a multi-file Python project, fixes two bugs via a compiled facade workflow, and records durable SQLite journal & effect receipts", async () => {
    const ws = tempDir("zfacade-live-e2e-py-");
    const home = tempDir("zfacade-live-e2e-home-");

    // Create a multi-file Python inventory + order processing app with two bugs
    writeFileSync(
      join(ws, "inventory.py"),
      [
        "class Inventory:",
        "    def __init__(self, stock: dict[str, int]):",
        "        self.stock = dict(stock)",
        "",
        "    def reserve(self, item: str, qty: int) -> bool:",
        "        if qty <= 0:",
        "            raise ValueError('qty must be positive')",
        "        available = self.stock.get(item, 0)",
        "        # Bug 1: uses > instead of >= so exact stock reservation fails",
        "        if available > qty:",
        "            self.stock[item] = available - qty",
        "            return True",
        "        return False",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(ws, "checkout.py"),
      [
        "from inventory import Inventory",
        "",
        "def compute_total(unit_prices: dict[str, float], items: list[tuple[str, int]], tax_rate: float) -> float:",
        "    subtotal = sum(unit_prices[name] * qty for name, qty in items)",
        "    # Bug 2: divides by (1 + tax_rate) instead of multiplying",
        "    return round(subtotal / (1.0 + tax_rate), 2)",
        "",
      ].join("\n"),
    );

    writeFileSync(
      join(ws, "test_store.py"),
      [
        "import unittest",
        "from inventory import Inventory",
        "from checkout import compute_total",
        "",
        "class TestStore(unittest.TestCase):",
        "    def test_exact_stock_reservation(self):",
        "        inv = Inventory({'widget': 5})",
        "        self.assertTrue(inv.reserve('widget', 5))",
        "        self.assertEqual(inv.stock['widget'], 0)",
        "",
        "    def test_compute_total_with_tax(self):",
        "        prices = {'widget': 10.0, 'gadget': 25.0}",
        "        total = compute_total(prices, [('widget', 2), ('gadget', 1)], 0.10)",
        "        self.assertEqual(total, 49.5)",
        "",
        "if __name__ == '__main__':",
        "    unittest.main()",
        "",
      ].join("\n"),
    );

    // 1. Confirm the test suite initially fails on both bugs
    await expect(run("python3", ["test_store.py"], { cwd: ws })).rejects.toThrow();

    // 2. Write real dual-provider config: Tinker Qwen3.5-4B Orchestrator + OpenAI gpt-5.5 Worker
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        orchestratorProvider: {
          kind: "tinker",
          modelId: "Qwen/Qwen3.5-4B",
          checkpointPath: CHECKPOINT,
          renderer: "qwen3_5_disable_thinking",
        },
        provider: {
          kind: "openai",
          modelId: "gpt-5.5",
        },
        grants: [
          { id: "write-all", tool: "Write", match: "." },
          { id: "edit-all", tool: "Edit", match: "." },
          { id: "patch-all", tool: "ApplyPatch", match: "." },
        ],
      }),
    );

    const env = { ...process.env, ZFACADE_HOME: home, PYTHONDONTWRITEBYTECODE: "1" };

    // 3. Execute the real CLI binary `zfacade run`
    const cliResult = await run(
      process.execPath,
      [
        MAIN,
        "run",
        "--workspace",
        ws,
        "--json",
        "Fix the bugs in inventory.py and checkout.py so `python3 test_store.py` passes.",
      ],
      { env, timeout: 300_000 },
    );

    const outcome = JSON.parse(cliResult.stdout.trim()) as {
      exitCode: number;
      status: string;
      runId: string;
      compileAttempts: number;
      workflowTurns: number;
      workflowScript: string;
      orchestratorLabel: string;
      workerLabel: string;
      effectIds: string[];
      artifact: unknown;
      summary: string;
    };

    console.log("=== E2E CLI Outcome ===");
    console.log("Orchestrator:", outcome.orchestratorLabel);
    console.log("Worker:", outcome.workerLabel);
    console.log("Compile Attempts:", outcome.compileAttempts);
    console.log("Workflow Script Generated by 4B Orchestrator:\n" + outcome.workflowScript);
    console.log("Worker Final Summary:", outcome.summary);

    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.orchestratorLabel).toContain("tinker:Qwen/Qwen3.5-4B");
    expect(outcome.workerLabel).toBe("openai-compatible:gpt-5.5");
    expect(outcome.workflowScript).toContain("agent(");
    expect(outcome.workflowScript).toContain(".ask<");
    expect(outcome.effectIds.length).toBeGreaterThan(0);

    // 4. Independently run `python3 test_store.py` to prove the real files were fixed
    const postCheck = await run("python3", ["test_store.py"], { cwd: ws });
    expect(postCheck.stderr).toContain("OK");
    expect(readFileSync(join(ws, "inventory.py"), "utf8")).toContain("available >= qty");
    expect(readFileSync(join(ws, "checkout.py"), "utf8")).toContain("subtotal * (1");

    // 5. Inspect durable SQLite state via `zfacade inspect`
    const inspectResult = await run(
      process.execPath,
      [MAIN, "inspect", "--workspace", ws, "--run", outcome.runId, "--json"],
      { env },
    );
    const inspected = JSON.parse(inspectResult.stdout.trim()) as {
      nodes: Array<{ siteId: string; kind: string; status: string }>;
      effects: Array<{ toolName: string; state: string }>;
      holds: unknown[];
    };
    console.log("Journaled Workflow Nodes:", inspected.nodes);
    console.log(
      "Journaled Tool Effects:",
      inspected.effects.map((e) => `${e.toolName}:${e.state}`),
    );

    expect(inspected.nodes.length).toBeGreaterThanOrEqual(2);
    expect(inspected.nodes.every((n) => n.status === "completed")).toBe(true);
    expect(inspected.effects.every((e) => e.state === "completed")).toBe(true);
    expect(inspected.holds).toEqual([]);
  }, 300_000);
});
