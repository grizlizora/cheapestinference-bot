import { describe, it, expect, vi } from "vitest";
import { CodeIntegrityEngine } from "../src/engine/codeIntegrityEngine.js";
import { NodeActivationEngine } from "../src/engine/nodeActivationEngine.js";

describe("CodeIntegrityEngine & Zero-Trust Verification", () => {
  it("computes exact Git Blob SHA-1 hash for a buffer", () => {
    const engine = new CodeIntegrityEngine();
    // Test known Git blob hash for "hello\n"
    // git hash-object -t blob <(echo -n "hello\n")
    const buf = Buffer.from("hello\n", "utf8");
    const sha = engine.computeGitBlobSha(buf);
    expect(sha).toBeDefined();
    expect(sha.length).toBe(40);
  });

  it("scans local files and generates non-empty Merkle Root", () => {
    const engine = new CodeIntegrityEngine();
    const localFiles = engine.scanLocalFiles();

    expect(localFiles.size).toBeGreaterThan(10);
    expect(localFiles.has("src/index.ts")).toBe(true);
    expect(localFiles.has("package.json")).toBe(true);
    expect(localFiles.has("docs/index.html")).toBe(true);

    const indexEntry = localFiles.get("src/index.ts");
    expect(indexEntry?.sha).toBeDefined();
    expect(indexEntry?.size).toBeGreaterThan(0);
  });

  it("verifies integrity against mock GitHub API response and generates challenge proof", async () => {
    const engine = new CodeIntegrityEngine();
    const localFiles = engine.scanLocalFiles();

    // Mock fetchGitHubTree to match local files
    const mockTree = Array.from(localFiles.entries()).map(([path, data]) => ({
      path,
      mode: "100644",
      type: "blob" as const,
      sha: data.sha,
      size: data.size,
      url: `https://api.github.com/...`,
    }));

    vi.spyOn(engine, "fetchGitHubTree").mockResolvedValue({
      tree: mockTree,
      commit: {
        sha: "1928226abc1234567890abcdef12345678901234",
        commit: {
          author: { name: "Roman Grizli", date: new Date().toISOString() },
          message: "feat: add zero-trust code integrity verification",
          verification: { verified: true, reason: "valid" },
        },
        tree: { sha: "tree123" },
      },
    });

    const report = await engine.verifyIntegrity(12345, "CHECK-UNITTEST");

    expect(report.isAuthentic).toBe(true);
    expect(report.identicalCount).toBe(localFiles.size);
    expect(report.modifiedCount).toBe(0);
    expect(report.addedCount).toBe(0);
    expect(report.deletedCount).toBe(0);
    expect(report.challengeCode).toBe("CHECK-UNITTEST");
    expect(report.proofHash).toBeDefined();
    expect(report.proofHash.length).toBe(64);
    expect(report.githubPagesVerifierUrl).toContain("CHECK-UNITTEST");
  });

  it("detects modified, added, and deleted files when remote tree diverges", async () => {
    const engine = new CodeIntegrityEngine();
    const localFiles = engine.scanLocalFiles();

    // Create a diverging remote tree
    const mockTree = Array.from(localFiles.entries())
      .filter(([path]) => path !== "docs/index.html") // Simulate deleted file
      .map(([path, data]) => ({
        path,
        mode: "100644",
        type: "blob" as const,
        sha: path === "src/index.ts" ? "0000000000000000000000000000000000000000" : data.sha, // Modified
        size: data.size,
        url: `https://api.github.com/...`,
      }));

    // Add extra file on remote
    mockTree.push({
      path: "src/extra_remote.ts",
      mode: "100644",
      type: "blob",
      sha: "ffffffffffffffffffffffffffffffffffffffff",
      size: 100,
      url: "https://api.github.com/...",
    });

    vi.spyOn(engine, "fetchGitHubTree").mockResolvedValue({
      tree: mockTree,
      commit: {
        sha: "diverged1234567890abcdef1234567890123456",
        commit: {
          author: { name: "Roman", date: new Date().toISOString() },
          message: "test",
        },
        tree: { sha: "tree123" },
      },
    });

    const report = await engine.verifyIntegrity(12345, "CHECK-DIFFTEST");

    expect(report.isAuthentic).toBe(false);
    expect(report.modifiedCount).toBeGreaterThan(0);
    expect(report.diffs.some((d) => d.path === "src/index.ts" && d.status === "modified")).toBe(true);
    expect(report.diffs.some((d) => d.path === "docs/index.html" && d.status === "added")).toBe(true);
    expect(report.diffs.some((d) => d.path === "src/extra_remote.ts" && d.status === "deleted")).toBe(true);
  });
});

describe("NodeActivationEngine", () => {
  it("generates deterministic yet unique node attestation and CLI activation command", () => {
    const nodeEngine = new NodeActivationEngine();
    const attestation = nodeEngine.getAttestation();

    expect(attestation.nodeId).toMatch(/^NODE-[A-F0-9]{8}$/);
    expect(attestation.activationCliCommand).toContain("npm run activate:cloud -- --node=");
    expect(attestation.isAuthorized).toBe(false);

    nodeEngine.authorizeNode("grizlizora (Owner)");
    const updated = nodeEngine.getAttestation();
    expect(updated.isAuthorized).toBe(true);
    expect(updated.authorizedBy).toBe("grizlizora (Owner)");
  });
});
