# CheapestInference FastPath Edge Proxy (Cloudflare Worker)

Це допоміжний мікро-проксі на Cloudflare Workers, призначений для запобігання блокувань та обходу обмежень швидкості з боку Cloudflare WAF при зверненні до CheapestInference API.

> [!NOTE]
> Цей воркер **не є кодом Telegram-бота**! Сам Telegram-бот працює як довгоживучий Node.js демон (через залежності від C++ SQLite, Tor SOCKS5 та perpetual long-polling). Воркер — це лише опціональний швидкісний рівень проксі Tier 0.

## Деплой воркера

```bash
cd tools/edge-proxy
npx wrangler deploy
```

Після деплою скопіюйте отриманий URL (наприклад, `https://cheapestinference-fastpath-proxy.yourname.workers.dev`) і додайте його у `.env` основного бота:
```env
CF_WORKER_URL=https://cheapestinference-fastpath-proxy.yourname.workers.dev
CF_WORKER_SECRET=optional_shared_secret
```
