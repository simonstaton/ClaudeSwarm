import { describe, expect, it } from "vitest";
import {
  isExemptFromAuth,
  isExemptFromKillAndRecovery,
  PATHS_EXEMPT_FROM_KILL_AND_RECOVERY,
  PATHS_SKIP_AUTH,
} from "./exempt-paths";

describe("exempt-paths", () => {
  it("PATHS_SKIP_AUTH is subset of PATHS_EXEMPT_FROM_KILL_AND_RECOVERY", () => {
    for (const p of PATHS_SKIP_AUTH) {
      expect(PATHS_EXEMPT_FROM_KILL_AND_RECOVERY).toContain(p);
    }
  });

  it("isExemptFromAuth returns true for health and auth/token", () => {
    expect(isExemptFromAuth("/api/health")).toBe(true);
    expect(isExemptFromAuth("/api/auth/token")).toBe(true);
  });

  it("isExemptFromAuth returns false for other API paths", () => {
    expect(isExemptFromAuth("/api/agents")).toBe(false);
    expect(isExemptFromAuth("/api/kill-switch")).toBe(false);
  });

  it("isExemptFromKillAndRecovery returns true for kill-switch, health, auth/token", () => {
    expect(isExemptFromKillAndRecovery("/api/kill-switch")).toBe(true);
    expect(isExemptFromKillAndRecovery("/api/health")).toBe(true);
    expect(isExemptFromKillAndRecovery("/api/auth/token")).toBe(true);
  });

  it("isExemptFromKillAndRecovery returns false for other API paths", () => {
    expect(isExemptFromKillAndRecovery("/api/agents")).toBe(false);
  });
});
