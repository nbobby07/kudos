import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkCheckout } from "./checkout.js";

// Deploy this backend package outside the app worktree in the browser-ready VM.
try {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is required");
  const directory = resolve(process.argv[2] ?? "/tmp/verification-evidence");
  const result = await checkCheckout({ appUrl });
  await mkdir(directory, { recursive: true });
  const { screenshot, ...diagnostics } = result.evidence;
  // Commit the primary report first; secondary artifact failures must not erase it.
  await writeFile(resolve(directory, "result.json"), JSON.stringify({
    ...result, evidence: { network: "network.json", logs: "logs.json", ...(screenshot ? { screenshot: "failure.png" } : {}) },
  }));
  const artifacts: [string, string | Buffer][] = [
    ["network.json", JSON.stringify(diagnostics.network)],
    ["logs.json", JSON.stringify(diagnostics.logs)],
    ...(screenshot ? [["failure.png", screenshot] as [string, Buffer]] : []),
  ];
  for (const [name, bytes] of artifacts) {
    try { await writeFile(resolve(directory, name), bytes); }
    catch { console.error("Checkout artifact capture failed; primary report preserved"); }
  }
} catch {
  console.error("Checkout runner or evidence capture failed");
  process.exitCode = 1;
}
