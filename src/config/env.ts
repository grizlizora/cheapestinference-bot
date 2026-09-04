import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z
    .string()
    .default(process.env.NODE_ENV === "test" ? "test_mock_token_123456789:ABCdefGHIjklMNOpqrsTUVwxyz" : "")
    .refine((val) => val.length > 0, "BOT_TOKEN is required"),
  ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((val) => {
      if (!val || !val.trim()) return [];
      // Support comma, semicolon, space, newline, pipe, and JSON array brackets
      const cleaned = val.replace(/[\[\]"'\r\n;|\s]+/g, ",");
      const ids = cleaned
        .split(",")
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id) && id > 0);
      return Array.from(new Set(ids));
    }),
  DB_PATH: z.string().default("./data/bot.db"),
  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),
  TELEGRAM_API_ROOT: z.string().optional(),
  CF_WORKER_URL: z.string().optional(),
  CF_WORKER_SECRET: z.string().optional(),
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
    .default("4")
    .transform((val) => parseInt(val, 10)),
  SCRAPE_MAX_INTERVAL_SEC: z
    .string()
    .default("6")
    .transform((val) => parseInt(val, 10)),
  ADMIN_USERNAMES: z
    .string()
    .default("")
    .transform((val) => {
      if (!val || !val.trim()) return [];
      const cleaned = val.replace(/[\[\]"'\r\n;|\s]+/g, ",");
      const names = cleaned
        .split(",")
        .map((u) => u.trim().replace(/^@/, "").toLowerCase())
        .filter((u) => u.length > 0);
      return Array.from(new Set(names));
    }),
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

// O(1) Fast Lookup Sets for Extreme Scale Admin Verification
const adminIdsSet = new Set<number>(config.ADMIN_USER_IDS);
const adminUsernamesSet = new Set<string>(config.ADMIN_USERNAMES);

export function isUserAdmin(
  userId?: number,
  userDao?: { isAdmin: (id: number) => boolean; setAdmin?: (id: number, admin: boolean) => void },
  username?: string
): boolean {
  if (!userId) return false;
  if (adminIdsSet.has(userId)) {
    if (userDao && typeof userDao.setAdmin === "function" && !userDao.isAdmin(userId)) {
      try {
        userDao.setAdmin(userId, true);
      } catch {}
    }
    return true;
  }
  if (userDao && userDao.isAdmin(userId)) {
    return true;
  }
  if (username) {
    const clean = username.replace(/^@/, "").toLowerCase();
    if (adminUsernamesSet.has(clean)) {
      return true;
    }
  }
  return false;
}
