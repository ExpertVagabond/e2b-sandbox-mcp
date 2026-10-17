#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PYTHON = process.env.E2B_SANDBOX_MCP_PYTHON || "python3";

const server = new McpServer({
  name: "e2b-sandbox-mcp",
  version: "1.0.0",
});

async function runPython(script, env = {}) {
  const { stdout, stderr } = await execFileAsync(
    PYTHON, ["-I", "-c", script],
    {
      env: { ...process.env, ...env },
      timeout: 120_000,
    }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// Tool 1: Create a sandbox and run code in it
server.tool(
  "run-code",
  "Create an E2B sandbox, execute code, return stdout/stderr. The sandbox is destroyed after execution.",
  {
    code: z.string().describe("Python code to execute inside the sandbox"),
    template: z.string().optional().describe("E2B sandbox template ID (default: Python base image)"),
    timeout: z.number().optional().describe("Execution timeout in seconds (default: 30)"),
    install: z.array(z.string()).optional().describe("pip packages to install before running"),
  },
  async ({ code, template, timeout, install }) => {
    const tmpl = template ? JSON.stringify(template) : "None";
    const timeoutSec = timeout || 30;
    const pipPkgs = install && install.length > 0 ? install : [];

    const pipInstallBlock = pipPkgs.length > 0
      ? `
    for pkg in ${JSON.stringify(pipPkgs)}:
        install_result = sbx.commands.run(f"pip install {pkg}")
        if install_result.exit_code != 0:
            results.append({"phase": "install", "package": pkg, "error": install_result.stderr})`
      : "";

    const script = `
import json, sys, os
try:
    from e2b_code_interpreter import Sandbox
except ImportError:
    print(json.dumps({"error": "e2b_code_interpreter not installed. Run: pip install e2b-code-interpreter"}))
    sys.exit(0)

api_key = os.environ.get("E2B_API_KEY")
if not api_key:
    print(json.dumps({"error": "E2B_API_KEY not set. Sign up at e2b.dev and set the key."}))
    sys.exit(0)

results = []
template = ${tmpl}
try:
    sbx = Sandbox(template=template, timeout=${timeoutSec}) if template else Sandbox(timeout=${timeoutSec})
    ${pipInstallBlock}
    execution = sbx.run_code(${JSON.stringify(code)})
    results.append({
        "stdout": execution.text if hasattr(execution, 'text') else str(execution.logs.stdout) if execution.logs else "",
        "stderr": str(execution.logs.stderr) if execution.logs and execution.logs.stderr else "",
        "error": str(execution.error) if execution.error else None,
        "results": [str(r) for r in (execution.results or [])],
    })
    sbx.kill()
except Exception as e:
    results.append({"error": str(e)})

print(json.dumps(results, default=str))
`;
    try {
      const { stdout, stderr } = await runPython(script);
      const parsed = JSON.parse(stdout || "[]");
      if (parsed.error) {
        return { content: [{ type: "text", text: `Error: ${parsed.error}` }] };
      }
      const result = Array.isArray(parsed) ? parsed[0] : parsed;
      let text = "";
      if (result.error) text += `Error: ${result.error}\n`;
      if (result.stdout) text += `stdout:\n${result.stdout}\n`;
      if (result.stderr) text += `stderr:\n${result.stderr}\n`;
      if (result.results?.length) text += `Results: ${result.results.join(", ")}\n`;
      if (!text) text = "Execution completed with no output.";
      return { content: [{ type: "text", text: text.trim() }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Execution failed: ${err.message}` }] };
    }
  }
);

// Tool 2: List available sandbox templates
server.tool(
  "list-templates",
  "List available E2B sandbox templates from your account.",
  {},
  async () => {
    const script = `
import json, sys, os
try:
    from e2b import Sandbox
except ImportError:
    print(json.dumps({"error": "e2b not installed"}))
    sys.exit(0)

api_key = os.environ.get("E2B_API_KEY")
if not api_key:
    print(json.dumps({"error": "E2B_API_KEY not set"}))
    sys.exit(0)

try:
    from e2b import SandboxTemplate
    templates = SandboxTemplate.list()
    result = [{"id": t.template_id, "name": t.name, "aliases": t.aliases} for t in templates]
    print(json.dumps(result, default=str))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    try {
      const { stdout } = await runPython(script);
      const parsed = JSON.parse(stdout || "{}");
      if (parsed.error) {
        return { content: [{ type: "text", text: `Error: ${parsed.error}` }] };
      }
      const text = parsed.length === 0
        ? "No custom templates found. Use the default Python sandbox or create one with `e2b template init`."
        : parsed.map(t => `- ${t.id}: ${t.name || "(unnamed)"}${t.aliases?.length ? ` (aliases: ${t.aliases.join(", ")})` : ""}`).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);

// Tool 3: Upload a file to a sandbox and run a script against it
server.tool(
  "run-with-file",
  "Create a sandbox, upload a file into it, run code that processes the file, return results. For data pipelines, CSV analysis, etc.",
  {
    file_content: z.string().describe("Content of the file to upload"),
    file_name: z.string().describe("Name for the uploaded file (e.g. data.csv)"),
    code: z.string().describe("Python code to run — the file is at /home/user/{file_name}"),
    install: z.array(z.string()).optional().describe("pip packages to install before running"),
  },
  async ({ file_content, file_name, code, install }) => {
    const safeFileName = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const pipPkgs = install && install.length > 0 ? install : [];

    const pipBlock = pipPkgs.length > 0
      ? `
    for pkg in ${JSON.stringify(pipPkgs)}:
        sbx.commands.run(f"pip install {pkg}")`
      : "";

    const script = `
import json, sys, os
try:
    from e2b_code_interpreter import Sandbox
except ImportError:
    print(json.dumps({"error": "e2b_code_interpreter not installed"}))
    sys.exit(0)

api_key = os.environ.get("E2B_API_KEY")
if not api_key:
    print(json.dumps({"error": "E2B_API_KEY not set"}))
    sys.exit(0)

try:
    sbx = Sandbox(timeout=60)
    sbx.files.write(f"/home/user/${safeFileName}", ${JSON.stringify(file_content)})
    ${pipBlock}
    execution = sbx.run_code(${JSON.stringify(code)})
    result = {
        "stdout": execution.text if hasattr(execution, 'text') else str(execution.logs.stdout) if execution.logs else "",
        "stderr": str(execution.logs.stderr) if execution.logs and execution.logs.stderr else "",
        "error": str(execution.error) if execution.error else None,
    }
    sbx.kill()
    print(json.dumps(result, default=str))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
    try {
      const { stdout } = await runPython(script);
      const parsed = JSON.parse(stdout || "{}");
      if (parsed.error) {
        return { content: [{ type: "text", text: `Error: ${parsed.error}` }] };
      }
      let text = "";
      if (parsed.stdout) text += `stdout:\n${parsed.stdout}\n`;
      if (parsed.stderr) text += `stderr:\n${parsed.stderr}\n`;
      if (parsed.error) text += `error:\n${parsed.error}\n`;
      if (!text) text = "Completed with no output.";
      return { content: [{ type: "text", text: text.trim() }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err.message}` }] };
    }
  }
);

// Tool 4: Check E2B environment health
server.tool(
  "doctor",
  "Check E2B SDK installation, API key, and connectivity. Run this first to diagnose issues.",
  {},
  async () => {
    const script = `
import json, sys, os

checks = []

# SDK installed?
try:
    import e2b
    checks.append({"check": "e2b SDK", "status": "ok", "version": getattr(e2b, '__version__', 'installed')})
except ImportError:
    checks.append({"check": "e2b SDK", "status": "missing", "fix": "pip install e2b"})

try:
    import e2b_code_interpreter
    checks.append({"check": "e2b-code-interpreter", "status": "ok", "version": getattr(e2b_code_interpreter, '__version__', 'installed')})
except ImportError:
    checks.append({"check": "e2b-code-interpreter", "status": "missing", "fix": "pip install e2b-code-interpreter"})

# API key?
key = os.environ.get("E2B_API_KEY", "")
if key:
    checks.append({"check": "E2B_API_KEY", "status": "ok", "prefix": key[:8] + "..."})
else:
    checks.append({"check": "E2B_API_KEY", "status": "missing", "fix": "Sign up at e2b.dev → Dashboard → API Keys"})

# Connectivity (only if key present)
if key:
    try:
        from e2b_code_interpreter import Sandbox
        sbx = Sandbox(timeout=10)
        execution = sbx.run_code("print('hello from e2b')")
        output = execution.text if hasattr(execution, 'text') else str(execution.logs.stdout) if execution.logs else ""
        sbx.kill()
        checks.append({"check": "sandbox creation", "status": "ok", "output": output.strip()})
    except Exception as e:
        checks.append({"check": "sandbox creation", "status": "error", "detail": str(e)})

print(json.dumps(checks, default=str))
`;
    try {
      const { stdout } = await runPython(script);
      const checks = JSON.parse(stdout || "[]");
      const lines = checks.map(c => {
        const icon = c.status === "ok" ? "✓" : c.status === "missing" ? "✗" : "⚠";
        let line = `${icon} ${c.check}: ${c.status}`;
        if (c.version) line += ` (v${c.version})`;
        if (c.prefix) line += ` (${c.prefix})`;
        if (c.output) line += ` → ${c.output}`;
        if (c.fix) line += ` — ${c.fix}`;
        if (c.detail) line += ` — ${c.detail}`;
        return line;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Doctor failed: ${err.message}` }] };
    }
  }
);

// Tool 5: Scaffold a sandbox template Dockerfile
server.tool(
  "scaffold-template",
  "Generate a Dockerfile and e2b.toml for a custom E2B sandbox template. Use when the default Python sandbox doesn't have the right dependencies.",
  {
    name: z.string().describe("Template name (lowercase, alphanumeric + hyphens)"),
    packages: z.array(z.string()).describe("Python packages to pre-install"),
    system_packages: z.array(z.string()).optional().describe("apt packages to install"),
    description: z.string().optional().describe("What this sandbox is for"),
  },
  async ({ name, packages, system_packages, description }) => {
    const safeName = name.replace(/[^a-z0-9-]/g, "-").toLowerCase();
    const aptLine = system_packages?.length
      ? `RUN apt-get update && apt-get install -y ${system_packages.join(" ")} && rm -rf /var/lib/apt/lists/*`
      : "";
    const pipLine = packages.length
      ? `RUN pip install ${packages.join(" ")}`
      : "";

    const dockerfile = `FROM e2b/code-interpreter:latest

${aptLine}
${pipLine}
`.trim() + "\n";

    const toml = `# E2B sandbox template
template_id = "${safeName}"
dockerfile = "Dockerfile"
${description ? `# ${description}` : ""}
`;

    const text = `Generated template "${safeName}":\n\n--- Dockerfile ---\n${dockerfile}\n--- e2b.toml ---\n${toml}\nTo build and register:\n  cd <template-dir>\n  e2b template build\n\nThen use template="${safeName}" in run-code.`;
    return { content: [{ type: "text", text }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
