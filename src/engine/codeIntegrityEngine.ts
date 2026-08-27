import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { request } from "undici";

export interface FileDiffResult {
  path: string;
  status: "identical" | "modified" | "added" | "deleted";
  localSha?: string;
  remoteSha?: string;
  sizeBytes?: number;
}

export interface VerificationReport {
  isAuthentic: boolean;
  commitSha: string;
  commitShortSha: string;
  commitMessage: string;
  commitAuthor: string;
  commitDate: string;
  isGpgVerified: boolean;
  gpgReason?: string;
  totalMonitoredFiles: number;
  identicalCount: number;
  modifiedCount: number;
  addedCount: number;
  deletedCount: number;
  merkleRoot: string;
  challengeCode: string;
  proofHash: string;
  verifiedAt: number;
  executionTimeMs: number;
  diffs: FileDiffResult[];
  githubTreeUrl: string;
  githubPagesVerifierUrl: string;
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

interface GitHubCommitResponse {
  sha: string;
  commit: {
    author: { name: string; date: string };
    message: string;
    verification?: { verified: boolean; reason: string };
  };
  tree: { sha: string };
}

export class CodeIntegrityEngine {
  private readonly repoOwner: string;
  private readonly repoName: string;
  private readonly rootDir: string;
  private readonly githubToken?: string;

  // In-memory cache & request coalescing to protect GitHub rate limits
  private cachedTree: {
    tree: GitHubTreeEntry[];
    commit: GitHubCommitResponse;
    fetchedAt: number;
    etag?: string;
  } | null = null;
  private inFlightPromise: Promise<{ tree: GitHubTreeEntry[]; commit: GitHubCommitResponse }> | null = null;
  private readonly CACHE_TTL_MS = 60 * 1000; // 60 seconds

  constructor(options?: { repoOwner?: string; repoName?: string; rootDir?: string; githubToken?: string }) {
    this.repoOwner = options?.repoOwner || "grizlizora";
    this.repoName = options?.repoName || "cheapestinference-bot";
    this.rootDir = options?.rootDir || process.cwd();
    this.githubToken = options?.githubToken || process.env.GITHUB_TOKEN;
  }

  /**
   * Computes Git Blob SHA-1 of a Buffer: sha1("blob " + length + "\0" + content)
   */
  public computeGitBlobSha(buffer: Buffer): string {
    const header = Buffer.from(`blob ${buffer.length}\0`, "utf8");
    const combined = Buffer.concat([header, buffer]);
    return crypto.createHash("sha1").update(combined).digest("hex");
  }

  /**
   * Scans local filesystem for all tracked source and configuration files
   */
  public scanLocalFiles(): Map<string, { sha: string; size: number; rawSha256: string }> {
    const fileMap = new Map<string, { sha: string; size: number; rawSha256: string }>();
    const includeExtensions = new Set([".ts", ".json", ".js", ".mjs", ".sh", ".yml", ".yaml", ".md", ".html", ".css", ".sql"]);
    const singleFiles = new Set(["Dockerfile", "package.json", "tsconfig.json", "docker-compose.yml", "LICENSE", "README.md", ".gitignore"]);

    const scanDir = (dir: string, baseRelative: string = "") => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = baseRelative ? `${baseRelative}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          if (["node_modules", ".git", "dist", "data", "tmp", ".gemini", "coverage"].includes(entry.name)) {
            continue;
          }
          scanDir(fullPath, relPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (includeExtensions.has(ext) || singleFiles.has(entry.name)) {
            try {
              let buf = fs.readFileSync(fullPath);
              // Normalize CRLF to LF for source text files to prevent false OS line-ending diffs
              if (includeExtensions.has(ext) || entry.name.endsWith(".json")) {
                const text = buf.toString("utf8").replace(/\r\n/g, "\n");
                buf = Buffer.from(text, "utf8");
              }
              const blobSha = this.computeGitBlobSha(buf);
              const rawSha256 = crypto.createHash("sha256").update(buf).digest("hex");
              fileMap.set(relPath, { sha: blobSha, size: buf.length, rawSha256 });
            } catch (err) {
              console.warn(`⚠️ [Integrity] Failed to read ${fullPath}:`, err);
            }
          }
        }
      }
    };

    // Scan /src, /docker, /docs, and root files
    scanDir(path.join(this.rootDir, "src"), "src");
    scanDir(path.join(this.rootDir, "docker"), "docker");
    scanDir(path.join(this.rootDir, "docs"), "docs");

    for (const file of singleFiles) {
      const fullPath = path.join(this.rootDir, file);
      if (fs.existsSync(fullPath)) {
        try {
          let buf = fs.readFileSync(fullPath);
          const text = buf.toString("utf8").replace(/\r\n/g, "\n");
          buf = Buffer.from(text, "utf8");
          const blobSha = this.computeGitBlobSha(buf);
          const rawSha256 = crypto.createHash("sha256").update(buf).digest("hex");
          fileMap.set(file, { sha: blobSha, size: buf.length, rawSha256 });
        } catch {}
      }
    }

    return fileMap;
  }

  /**
   * Fetches latest tree and commit metadata from GitHub with caching & promise coalescing
   */
  public async fetchGitHubTree(): Promise<{ tree: GitHubTreeEntry[]; commit: GitHubCommitResponse }> {
    const now = Date.now();
    if (this.cachedTree && now - this.cachedTree.fetchedAt < this.CACHE_TTL_MS) {
      return { tree: this.cachedTree.tree, commit: this.cachedTree.commit };
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = (async () => {
      try {
        const headers: Record<string, string> = {
          "User-Agent": "CheapestInference-IntegrityGuard/1.0",
          "Accept": "application/vnd.github.v3+json",
        };
        if (this.githubToken) {
          headers["Authorization"] = `Bearer ${this.githubToken}`;
        }
        if (this.cachedTree?.etag) {
          headers["If-None-Match"] = this.cachedTree.etag;
        }

        // 1. Fetch Commit metadata
        const commitUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/commits/main`;
        const commitRes = await request(commitUrl, { headers });
        if (commitRes.statusCode === 304 && this.cachedTree) {
          this.cachedTree.fetchedAt = Date.now();
          return { tree: this.cachedTree.tree, commit: this.cachedTree.commit };
        }
        if (commitRes.statusCode >= 400) {
          throw new Error(`GitHub Commit API error HTTP ${commitRes.statusCode}`);
        }
        const commitData = (await commitRes.body.json()) as GitHubCommitResponse;

        // 2. Fetch Tree
        const treeUrl = `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/git/trees/${commitData.sha}?recursive=1`;
        const treeRes = await request(treeUrl, { headers });
        if (treeRes.statusCode >= 400) {
          throw new Error(`GitHub Tree API error HTTP ${treeRes.statusCode}`);
        }
        const treeData = (await treeRes.body.json()) as { tree: GitHubTreeEntry[] };
        const newEtag = (treeRes.headers["etag"] as string) || undefined;

        this.cachedTree = {
          tree: treeData.tree,
          commit: commitData,
          fetchedAt: Date.now(),
          etag: newEtag,
        };

        return { tree: treeData.tree, commit: commitData };
      } finally {
        this.inFlightPromise = null;
      }
    })();

    return this.inFlightPromise;
  }

  /**
   * Executes full verification comparing local disk against remote GitHub
   */
  public async verifyIntegrity(telegramUserId?: number, customChallenge?: string): Promise<VerificationReport> {
    const startTime = Date.now();
    const challengeCode =
      customChallenge?.trim() ||
      `CHECK-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const [{ tree: remoteTree, commit }, localFiles] = await Promise.all([
      this.fetchGitHubTree(),
      Promise.resolve(this.scanLocalFiles()),
    ]);

    const remoteFileMap = new Map<string, GitHubTreeEntry>();
    for (const entry of remoteTree) {
      if (entry.type === "blob") {
        if (
          entry.path.startsWith("src/") ||
          entry.path.startsWith("docker/") ||
          entry.path.startsWith("docs/") ||
          ["package.json", "tsconfig.json", "Dockerfile", "docker-compose.yml", "LICENSE", "README.md", ".gitignore"].includes(entry.path)
        ) {
          remoteFileMap.set(entry.path, entry);
        }
      }
    }

    const diffs: FileDiffResult[] = [];
    let identicalCount = 0;
    let modifiedCount = 0;
    let addedCount = 0;
    let deletedCount = 0;

    for (const [relPath, local] of localFiles.entries()) {
      const remote = remoteFileMap.get(relPath);
      if (!remote) {
        addedCount++;
        diffs.push({ path: relPath, status: "added", localSha: local.sha, sizeBytes: local.size });
      } else if (remote.sha.toLowerCase() === local.sha.toLowerCase()) {
        identicalCount++;
        diffs.push({ path: relPath, status: "identical", localSha: local.sha, remoteSha: remote.sha, sizeBytes: local.size });
      } else {
        modifiedCount++;
        diffs.push({ path: relPath, status: "modified", localSha: local.sha, remoteSha: remote.sha, sizeBytes: local.size });
      }
    }

    for (const [relPath, remote] of remoteFileMap.entries()) {
      if (!localFiles.has(relPath)) {
        deletedCount++;
        diffs.push({ path: relPath, status: "deleted", remoteSha: remote.sha, sizeBytes: remote.size });
      }
    }

    // Compute composite Merkle Root of all local monitored files
    const sortedKeys = Array.from(localFiles.keys()).sort();
    const merkleLeafHashes = sortedKeys.map((k) => `${k}:${localFiles.get(k)!.sha}`).join("\n");
    const merkleRoot = crypto.createHash("sha256").update(merkleLeafHashes).digest("hex");

    // Dynamic Challenge-Response Proof Hash (binds Merkle Root with ephemeral challenge)
    const proofHash = crypto
      .createHash("sha256")
      .update(`${merkleRoot}:${challengeCode}:${commit.sha}`)
      .digest("hex");

    const isAuthentic = modifiedCount === 0 && addedCount === 0 && deletedCount === 0;
    const commitShortSha = commit.sha.slice(0, 7);

    const githubPagesVerifierUrl = `https://${this.repoOwner}.github.io/${this.repoName}/?code=${encodeURIComponent(
      challengeCode
    )}&hash=${proofHash}&commit=${commitShortSha}`;

    return {
      isAuthentic,
      commitSha: commit.sha,
      commitShortSha,
      commitMessage: commit.commit.message.split("\n")[0] || "",
      commitAuthor: commit.commit.author.name,
      commitDate: commit.commit.author.date,
      isGpgVerified: commit.commit.verification?.verified ?? false,
      gpgReason: commit.commit.verification?.reason,
      totalMonitoredFiles: localFiles.size,
      identicalCount,
      modifiedCount,
      addedCount,
      deletedCount,
      merkleRoot,
      challengeCode,
      proofHash,
      verifiedAt: Date.now(),
      executionTimeMs: Date.now() - startTime,
      diffs,
      githubTreeUrl: `https://github.com/${this.repoOwner}/${this.repoName}/tree/${commit.sha}`,
      githubPagesVerifierUrl,
    };
  }
}
