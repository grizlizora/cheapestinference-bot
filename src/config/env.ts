import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN is required"),
  ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((id) => parseInt(id.trim(), 10))
            .filter((id) => !isNaN(id))
        : []
    ),
  DB_PATH: z.string().default("./data/bot.db"),
  TELEGRAM_API_ROOT: z.string().optional(),
  PORT: z
    .string()
    .default("7860")
    .transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  TOR_ENABLED: z
    .string()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  TOR_SOCKS_HOST: z.string().default("127.0.0.1"),
  TOR_SOCKS_PORT: z
    .string()
    .default("9050")
    .transform((val) => parseInt(val, 10)),
  TOR_CONTROL_HOST: z.string().default("127.0.0.1"),
  TOR_CONTROL_PORT: z
    .string()
    .default("9051")
    .transform((val) => parseInt(val, 10)),
  TOR_CONTROL_PASSWORD: z.string().optional(),
  PROXY_LIST: z
    .string()
    .default("")
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        : []
    ),
  ALLOW_DIRECT_FALLBACK: z
    .string()
    .default("true")
    .transform((val) => val !== "false" && val !== "0"),
  SCRAPE_MIN_INTERVAL_SEC: z
    .string()
    .default("15")
    .transform((val) => parseInt(val, 10)),
  SCRAPE_MAX_INTERVAL_SEC: z
    .string()
    .default("35")
    .transform((val) => parseInt(val, 10)),
  ADMIN_USERNAMES: z
    .string()
    .default("grizlizora")
    .transform((val) =>
      val
        ? val
            .split(",")
            .map((u) => u.trim().replace(/^@/, "").toLowerCase())
            .filter((u) => u.length > 0)
        : ["grizlizora"]
    ),
  ADMIN_SECRET: z.string().optional(),
  SCRAPE_MAX_BACKOFF_SEC: z
    .string()
    .default("300")
    .transform((val) => parseInt(val, 10)),
});

export type EnvConfig = z.infer<typeof envSchema>;

function parseEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Environment configuration validation failed:");
    console.error(result.error.format());
    throw new Error("Invalid environment configuration");
  }
  return result.data;
}

export const config = parseEnv();

export function isUserAdmin(
  userId?: number,
  userDao?: { isAdmin: (id: number) => boolean; setAdmin?: (id: number, admin: boolean) => void },
  username?: string
): boolean {
  if (!userId) return false;
  if (config.ADMIN_USER_IDS.length > 0 && config.ADMIN_USER_IDS.includes(userId)) {
    return true;
  }
  if (userDao && userDao.isAdmin(userId)) {
    return true;
  }
  if (username) {
    const clean = username.replace(/^@/, "").toLowerCase();
    if (config.ADMIN_USERNAMES.includes(clean)) {
      if (userDao && typeof userDao.setAdmin === "function") {
        try {
          userDao.setAdmin(userId, true);
        } catch {}
      }
      return true;
    }
  }
  return false;
}
