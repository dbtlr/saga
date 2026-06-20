import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readClaimReviewAttributes, readControlPlaneSnapshot } from "./control-plane.js";

describe("readControlPlaneSnapshot", () => {
  it("returns an unbound snapshot when no local binding exists", async () => {
    const cwd = makeTempWorkspace();

    const snapshot = await readControlPlaneSnapshot({ cwd });

    expect(snapshot.status).toBe("unbound");
    expect(snapshot.binding).toBeUndefined();
    expect(snapshot.activeContext).toBeUndefined();
    expect(snapshot.profile).toBeUndefined();
    expect(snapshot.recentActivity).toEqual([]);
    expect(snapshot.sourceBindings).toEqual([]);
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: ".saga.local.json",
        }),
      ]),
    );
  });

  it("reports an offline snapshot when a binding exists without database credentials", async () => {
    const cwd = makeTempWorkspace();
    writeFileSync(
      join(cwd, ".saga.local.json"),
      JSON.stringify({
        schemaVersion: 1,
        sourceBinding: { id: "source-1" },
        workspace: { handle: "demo", id: "workspace-1" },
      }),
    );

    const snapshot = await readControlPlaneSnapshot({
      cwd,
    });

    expect(snapshot.status).toBe("offline");
    expect(snapshot.binding?.workspace.handle).toBe("demo");
    expect(snapshot.profile).toBeUndefined();
    expect(snapshot.recentActivity).toEqual([]);
    expect(snapshot.runtime.database).toBe("missing");
    expect(snapshot.sourceBindings).toEqual([]);
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "DATABASE_URL",
        }),
      ]),
    );
  });
});

describe("claim review attributes", () => {
  it("projects pin and watch flags from current-claim attributes", () => {
    expect(
      readClaimReviewAttributes({
        reviewPinned: true,
        reviewWatched: true,
        adrPromoted: true,
        adrTitle: "Use event-backed claim reviews",
      }),
    ).toEqual({
      pinned: true,
      promoted: true,
      promotionTitle: "Use event-backed claim reviews",
      watched: true,
    });
  });
});

function makeTempWorkspace(): string {
  const path = join(
    process.env.VITEST_POOL_ID === undefined
      ? "/tmp"
      : `/tmp/saga-vitest-${process.env.VITEST_POOL_ID}`,
    `control-plane-${Date.now().toString()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}
