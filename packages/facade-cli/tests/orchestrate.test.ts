import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicProvider, runArgv } from "@zfacade/agent";
import { runOrchestratedTask } from "../src/orchestrate.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("language-agnostic Orchestrator -> Worker workflow paradigm", () => {
  it("orchestrates a Python bugfix where the orchestrator uses only the ~10 facade functions and the worker edits Python code across multiple tool turns", async () => {
    const ws = tempDir("zfacade-py-ws-");
    const home = tempDir("zfacade-py-home-");
    writeFileSync(
      join(ws, "calc.py"),
      "def multiply(a: int, b: int) -> int:\n    return a + b\n",
    );
    writeFileSync(
      join(ws, "test_calc.py"),
      "import unittest\nfrom calc import multiply\n\nclass TestCalc(unittest.TestCase):\n    def test_multiply(self):\n        self.assertEqual(multiply(6, 7), 42)\n\nif __name__ == '__main__':\n    unittest.main()\n",
    );

    // Verify broken state fails Python tests first
    const pre = await runArgv(["python3", "test_calc.py"], ws, 30_000);
    expect(pre.exitCode).not.toBe(0);

    // Orchestrator provider: first turn makes a compile error (uses `import`),
    // second turn submits a clean ~10-function ZCode workflow script.
    const orchestrator = new DeterministicProvider([
      {
        toolCalls: [
          {
            name: "submit_workflow",
            arguments: {
              ts_code: `import fs from "node:fs";\nphase("Bad");\n`,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "submit_workflow",
            arguments: {
              ts_code: [
                "interface FixReport {",
                "  fixed: boolean;",
                "  filesChanged: string[];",
                "  summary: string;",
                "}",
                'phase("Inspect");',
                'const pyFiles = await files.glob("*.py");',
                "log(`Found ${pyFiles.length} python files`);",
                'phase("Delegate");',
                'const coder = agent("coder", { system: "You are a Python engineer." });',
                "const report = await coder.ask<FixReport>(`Fix the bug in ${pyFiles.join(\", \")} so test_calc.py passes.`);",
                'phase("Verify");',
                'const check = await world.run("python3", ["test_calc.py"]);',
                "return { report, exitCode: check.exitCode };",
              ].join("\n"),
            },
          },
        ],
      },
    ]);

    // Worker provider: receives coder.ask<FixReport>, calls Read -> Edit -> Bash,
    // and then returns the schema-validated JSON FixReport.
    const worker = new DeterministicProvider([
      {
        toolCalls: [{ name: "Read", arguments: { path: "calc.py" } }],
      },
      {
        toolCalls: [
          {
            name: "Edit",
            arguments: {
              path: "calc.py",
              old: "return a + b",
              new: "return a * b",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "Bash",
            arguments: { argv: ["python3", "test_calc.py"] },
          },
        ],
      },
      {
        text: JSON.stringify({
          fixed: true,
          filesChanged: ["calc.py"],
          summary: "Fixed multiply(a, b) in calc.py to return a * b.",
        }),
      },
    ]);

    const outcome = await runOrchestratedTask({
      workspace: ws,
      task: "Fix multiply in calc.py so python3 test_calc.py passes.",
      config: {
        grants: [
          { id: "edit-all", tool: "Edit", match: "." },
          { id: "write-all", tool: "Write", match: "." },
        ],
      },
      orchestratorProvider: orchestrator,
      workerProvider: worker,
      env: { ...process.env, ZFACADE_HOME: home },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.compileAttempts).toBe(2);
    expect(readFileSync(join(ws, "calc.py"), "utf8")).toContain("return a * b");
    const artifact = outcome.artifact as {
      report: { fixed: boolean; filesChanged: string[] };
      exitCode: number;
    };
    expect(artifact.report.fixed).toBe(true);
    expect(artifact.report.filesChanged).toEqual(["calc.py"]);
    expect(artifact.exitCode).toBe(0);
  });
});
