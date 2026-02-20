import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_PERSISTENT = "/tmp/test-dep-cache-persistent";

describe("dep-cache", () => {
  beforeEach(() => {
    // Reset module state between tests by clearing the module cache
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(TEST_PERSISTENT, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("hasPersistentCache", () => {
    it("returns false when /persistent does not exist", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { hasPersistentCache } = await import("./dep-cache");
      expect(hasPersistentCache()).toBe(false);
    });
  });

  describe("getDepCacheEnv", () => {
    it("returns empty object when persistent storage is unavailable", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { getDepCacheEnv } = await import("./dep-cache");
      expect(getDepCacheEnv()).toEqual({});
    });

    it("returns npm_config_cache when npm-cache dir exists", async () => {
      mkdirSync(`${TEST_PERSISTENT}/npm-cache`, { recursive: true });
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return true;
            if (p === "/persistent/npm-cache") return true;
            if (p === "/persistent/pnpm-store") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { getDepCacheEnv } = await import("./dep-cache");
      const env = getDepCacheEnv();
      expect(env.npm_config_cache).toBe("/persistent/npm-cache");
      expect(env.npm_config_store_dir).toBeUndefined();
    });

    it("returns npm_config_store_dir when pnpm-store dir exists", async () => {
      mkdirSync(`${TEST_PERSISTENT}/pnpm-store`, { recursive: true });
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return true;
            if (p === "/persistent/npm-cache") return false;
            if (p === "/persistent/pnpm-store") return true;
            return actual.existsSync(p);
          },
        };
      });
      const { getDepCacheEnv } = await import("./dep-cache");
      const env = getDepCacheEnv();
      expect(env.npm_config_store_dir).toBe("/persistent/pnpm-store");
      expect(env.npm_config_cache).toBeUndefined();
    });

    it("returns both env vars when both dirs exist", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return true;
            if (p === "/persistent/npm-cache") return true;
            if (p === "/persistent/pnpm-store") return true;
            return actual.existsSync(p);
          },
        };
      });
      const { getDepCacheEnv } = await import("./dep-cache");
      const env = getDepCacheEnv();
      expect(env.npm_config_cache).toBe("/persistent/npm-cache");
      expect(env.npm_config_store_dir).toBe("/persistent/pnpm-store");
    });
  });

  describe("isCacheReady / waitForCache", () => {
    it("is not ready before initDepCache is called", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { isCacheReady } = await import("./dep-cache");
      expect(isCacheReady()).toBe(false);
    });

    it("becomes ready after initDepCache when no persistent storage", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { initDepCache, isCacheReady } = await import("./dep-cache");
      initDepCache();
      expect(isCacheReady()).toBe(true);
    });

    it("waitForCache resolves immediately when already ready", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { initDepCache, waitForCache } = await import("./dep-cache");
      initDepCache();
      // Should resolve immediately
      await waitForCache();
    });

    it("waitForCache resolves when initDepCache is called later", async () => {
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          existsSync: (p: string) => {
            if (p === "/persistent") return false;
            return actual.existsSync(p);
          },
        };
      });
      const { initDepCache, waitForCache } = await import("./dep-cache");
      let resolved = false;
      const promise = waitForCache().then(() => {
        resolved = true;
      });
      expect(resolved).toBe(false);
      initDepCache();
      await promise;
      expect(resolved).toBe(true);
    });
  });

  describe("DEP_CACHE_PATHS", () => {
    it("exports expected paths", async () => {
      const { DEP_CACHE_PATHS } = await import("./dep-cache");
      expect(DEP_CACHE_PATHS.npmCache).toBe("/persistent/npm-cache");
      expect(DEP_CACHE_PATHS.pnpmStore).toBe("/persistent/pnpm-store");
    });
  });
});
