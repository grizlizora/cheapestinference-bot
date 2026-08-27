import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function parseArgs(): { node?: string; token?: string } {
  const args = process.argv.slice(2);
  const result: { node?: string; token?: string } = {};

  for (const arg of args) {
    if (arg.startsWith("--node=")) {
      result.node = arg.split("=")[1];
    } else if (arg.startsWith("--token=")) {
      result.token = arg.split("=")[1];
    }
  }

  return result;
}

async function main() {
  console.log("🔐 ========================================================");
  console.log("🔐 [Owner Attestation] Авторизація хмарного вузла бота");
  console.log("🔐 ========================================================");

  const { node, token } = parseArgs();

  if (!node) {
    console.error("❌ Помилка: вкажіть ID вузла: npm run activate:cloud -- --node=NODE-XXXX");
    process.exit(1);
  }

  console.log(`📍 Вузол для активації: ${node}`);
  if (token) {
    console.log(`🔑 Токен запиту: ${token}`);
  }

  const authorizedNodeRecord = {
    nodeId: node,
    authorizedBy: "grizlizora (Owner)",
    authorizedAt: new Date().toISOString(),
    status: "OFFICIAL_ACTIVE_NODE",
    signature: crypto.createHash("sha256").update(`${node}:${token || "direct"}:grizlizora`).digest("hex"),
  };

  const docsDir = path.join(process.cwd(), "docs");
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const manifestPath = path.join(docsDir, "authorized-node.json");
  fs.writeFileSync(manifestPath, JSON.stringify(authorizedNodeRecord, null, 2), "utf8");

  console.log(`✅ Вузол ${node} успішно авторизовано та зафіксовано у docs/authorized-node.json!`);
  console.log(`🚀 Надішліть зміни у GitHub: git add docs/ && git commit -m "chore: authorize cloud node ${node}" && git push origin main`);
}

main().catch((err) => {
  console.error("❌ Помилка:", err);
  process.exit(1);
});
