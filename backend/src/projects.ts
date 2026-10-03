export type TrustedProject = Readonly<{
  id: string;
  repositoryUrl: string;
  setupCommand: string;
  startCommand: string;
  repositoryPath?: string;
  revisions?: readonly string[];
}>; 

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/checkout-revisions.json", import.meta.url), "utf8")) as {
  projectId: string; setupCommand: string; startCommand: string; revisions: Record<string, string>;
};

// The URL identifies this local-only fixture; its Git bundle is transferred, never published.
export const supportedProjects: readonly TrustedProject[] = Object.freeze([Object.freeze({
  id: fixture.projectId, repositoryUrl: "https://local-fixture.invalid/checkout.git",
  repositoryPath: fileURLToPath(new URL("../../fixtures/checkout", import.meta.url)),
  setupCommand: fixture.setupCommand, startCommand: fixture.startCommand,
  revisions: Object.freeze(Object.values(fixture.revisions)),
})]);
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
