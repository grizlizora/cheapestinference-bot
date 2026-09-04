import net from "node:net";

export interface TorManagerOptions {
  socksHost?: string;
  socksPort?: number;
  controlHost?: string;
  controlPort?: number;
  controlPassword?: string;
  minNewnymIntervalMs?: number;
}

export class TorManager {
  private readonly socksHost: string;
  private readonly socksPort: number;
  private readonly controlHost: string;
  private readonly controlPort: number;
  private readonly controlPassword?: string;
  private readonly minInterval: number;
  private lastNewnymTime = 0;
  private renewalPromise: Promise<boolean> | null = null;

  constructor(opts: TorManagerOptions = {}) {
    this.socksHost = opts.socksHost ?? "127.0.0.1";
    this.socksPort = opts.socksPort ?? 9050;
    this.controlHost = opts.controlHost ?? "127.0.0.1";
    this.controlPort = opts.controlPort ?? 9051;
    this.controlPassword = opts.controlPassword;
    this.minInterval = opts.minNewnymIntervalMs ?? 10_000;
  }

  private sessionNonce = Date.now().toString(36);

  public rotateStreamIsolation(): string {
    this.sessionNonce = process.hrtime.bigint().toString(36);
    return this.getSocksUrl();
  }

  public getSocksUrl(): string {
    return `socks5h://tor_${this.sessionNonce}:auth@${this.socksHost}:${this.socksPort}`;
  }

  public async isSocksReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socksPort, this.socksHost, () => {
        socket.destroy();
        resolve(true);
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Polls Tor ControlPort until bootstrap reaches 100% (circuits ready for traffic)
   */
  public async waitUntilBootstrapped(timeoutMs = 12_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const isReady = await this.checkBootstrapStatus();
      if (isReady) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private getAuthCmd(): string {
    if (!this.controlPassword) {
      return 'AUTHENTICATE ""\r\n';
    }
    const sanitized = this.controlPassword.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `AUTHENTICATE "${sanitized}"\r\n`;
  }

  private async checkBootstrapStatus(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.controlPort, this.controlHost, () => {
        socket.write(this.getAuthCmd());
      });

      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });

      let isAuthenticated = false;

      socket.on("data", (data) => {
        const res = data.toString();
        if (!isAuthenticated) {
          if (res.startsWith("250")) {
            isAuthenticated = true;
            socket.write("GETINFO status/bootstrap-phase\r\n");
          } else {
            socket.destroy();
            resolve(false);
          }
        } else {
          socket.destroy();
          if (res.includes("PROGRESS=100") || res.includes("TAG=done")) {
            resolve(true);
          } else {
            resolve(false);
          }
        }
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Request a new Tor identity circuit with mutex deduplication
   */
  public renewCircuit(): Promise<boolean> {
    if (this.renewalPromise) {
      return this.renewalPromise;
    }
    this.renewalPromise = this.executeRenewal().finally(() => {
      this.renewalPromise = null;
    });
    return this.renewalPromise;
  }

  private async executeRenewal(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastNewnymTime < this.minInterval) {
      const waitMs = this.minInterval - (now - this.lastNewnymTime);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return new Promise((resolve) => {
      const socket = net.createConnection(this.controlPort, this.controlHost, () => {
        socket.write(this.getAuthCmd());
      });

      socket.setTimeout(5000, () => {
        socket.destroy();
        resolve(false);
      });

      let isAuthenticated = false;

      socket.on("data", (data) => {
        const res = data.toString();

        if (!isAuthenticated) {
          if (res.startsWith("250")) {
            isAuthenticated = true;
            socket.write("SIGNAL NEWNYM\r\n");
          } else {
            socket.destroy();
            resolve(false);
          }
        } else {
          if (res.startsWith("250")) {
            this.lastNewnymTime = Date.now();
            socket.destroy();
            console.log("🧅 [Tor] Successfully acquired new Tor circuit identity (SIGNAL NEWNYM)");
            resolve(true);
          } else {
            socket.destroy();
            resolve(false);
          }
        }
      });

      socket.on("error", (err) => {
        console.warn(`⚠️ [Tor] ControlPort error: ${err.message}`);
        socket.destroy();
        resolve(false);
      });
    });
  }
}
