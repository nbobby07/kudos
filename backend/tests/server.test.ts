import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApiServer } from "../src/server.js";

it("serves liveness and rejects unknown routes without exposing configuration", async () => {
  const server = createApiServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const missing = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });

    const post = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
    expect(post.status).toBe(404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
