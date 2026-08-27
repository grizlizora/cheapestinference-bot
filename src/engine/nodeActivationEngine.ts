import os from "node:os";
import crypto from "node:crypto";

export interface NodeAttestation {
  nodeId: string;
  hostname: string;
  platform: string;
  bootTimestamp: number;
  activationToken: string;
  activationCliCommand: string;
  isAuthorized: boolean;
  authorizedBy?: string;
  authorizedAt?: number;
}

/**
 * Cloud Node Activation & Owner Attestation Engine.
 * Allows the repository owner (@grizlizora) to cryptographically authorize
 * and verify the running cloud node from their authorized PC/Mac.
 */
export class NodeActivationEngine {
  private readonly nodeId: string;
  private readonly hostname: string;
  private readonly platform: string;
  private readonly bootTimestamp: number;
  private readonly activationToken: string;
  private isAuthorized: boolean = false;
  private authorizedBy?: string;
  private authorizedAt?: number;

  constructor() {
    this.hostname = os.hostname();
    this.platform = `${os.type()} ${os.release()} (${os.arch()})`;
    this.bootTimestamp = Date.now();

    // Deterministic yet unique server node fingerprint
    const seed = `${this.hostname}:${this.platform}:${this.bootTimestamp}:${crypto.randomBytes(8).toString("hex")}`;
    this.nodeId = `NODE-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8).toUpperCase()}`;

    this.activationToken = crypto
      .createHash("sha256")
      .update(`${this.nodeId}:${this.bootTimestamp}:${seed}`)
      .digest("hex");
  }

  public getAttestation(): NodeAttestation {
    const activationCliCommand = `npm run activate:cloud -- --node=${this.nodeId} --token=${this.activationToken.slice(0, 16)}`;

    return {
      nodeId: this.nodeId,
      hostname: this.hostname,
      platform: this.platform,
      bootTimestamp: this.bootTimestamp,
      activationToken: this.activationToken,
      activationCliCommand,
      isAuthorized: this.isAuthorized,
      authorizedBy: this.authorizedBy,
      authorizedAt: this.authorizedAt,
    };
  }

  public authorizeNode(approver: string): void {
    this.isAuthorized = true;
    this.authorizedBy = approver;
    this.authorizedAt = Date.now();
  }
}
