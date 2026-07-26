import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  spawnLongRunningChild,
  terminateOwnedAvatar,
  waitForOwnedOverlayStartup,
} from "../../src/launcher/startup.js";

const TOKEN = "B".repeat(43);

describe("waitForOwnedOverlayStartup", () => {
  it("requires the capability and waits for rendered readiness", async () => {
    let ready = false;
    const server = createServer((req, res) => {
      const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
      res.statusCode = authorized && ready ? 200 : authorized ? 503 : 401;
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const child = spawnLongRunningChild();
    setTimeout(() => {
      ready = true;
    }, 80);
    await expect(
      waitForOwnedOverlayStartup(
        child,
        `http://127.0.0.1:${address.port}/event`,
        TOKEN,
        1_000,
      ),
    ).resolves.toEqual({ status: "healthy" });
    await terminateOwnedAvatar(child);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reports an overlay that exits before readiness", async () => {
    const child = spawnLongRunningChild();
    child.kill("SIGTERM");
    const result = await waitForOwnedOverlayStartup(
      child,
      "http://127.0.0.1:1/event",
      TOKEN,
      1_000,
    );
    expect(result.status).toBe("exited");
  });
});
