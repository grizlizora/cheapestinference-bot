import net from "node:net";

export interface TorManagerOptions {
  socksHost: string;
  socksPort: number;
  controlHost: string;
  controlPort: number;
  controlPassword?: string;
  minNewnymIntervalMs?: number;
}

export class TorManager {
  private lastNewnymTime = 0;
  private minInterval: number;

  constructor(private readonly opts: TorManagerOptions) {
    this.minInterval = opts.minNewnymIntervalMs ?? 10_000;
  }

  public getSocksUrl(): string {
    // socks5h forces remote DNS resolution through Tor exit nodes
    return `socks5h://${this.opts.socksHost}:${this.opts.socksPort}`;
  }

  public async isSocksReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(
        { host: this.opts.socksHost, port: this.opts.socksPort },
        () => {
          socket.destroy();
          resolve(true);
        }
      );
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Request a new Tor identity/circuit via the ControlPort (SIGNAL NEWNYM)
   */
  public async renewCircuit(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastNewnymTime < this.minInterval) {
      const waitMs = this.minInterval - (now - this.lastNewnymTime);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    return new Promise((resolve) => {
      const socket = net.createConnection(
        { host: this.opts.controlHost, port: this.opts.controlPort },
        () => {
          const authCmd = this.opts.controlPassword
            ? `AUTHENTICATE "${this.opts.controlPassword}"\r\n`
            : `AUTHENTICATE ""\r\n`;
          socket.write(authCmd);
        }
      );

      let step: "auth" | "signal" = "auth";

      socket.on("data", (data) => {
        const response = data.toString();
        if (step === "auth") {
          if (response.startsWith("250")) {
            step = "signal";
            socket.write("SIGNAL NEWNYM\r\n");
          } else {
            console.warn(`[TorManager] ControlPort auth failed: ${response.trim()}`);
            socket.destroy();
            resolve(false);
          }
        } else if (step === "signal") {
          socket.destroy();
          if (response.startsWith("250")) {
            this.lastNewnymTime = Date.now();
            console.log("🧅 [TorManager] Tor circuit rotated successfully (NEWNYM).");
            resolve(true);
          } else {
            console.warn(`[TorManager] SIGNAL NEWNYM failed: ${response.trim()}`);
            resolve(false);
          }
        }
      });

      socket.on("error", (err) => {
        console.warn(`[TorManager] ControlPort connection error: ${err.message}`);
        socket.destroy();
        resolve(false);
      });

      socket.setTimeout(4000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }
}
