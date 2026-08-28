import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import sharp from "sharp";

const OUTPUT_DIR = path.resolve(process.cwd(), "assets/custom_emojis");
const HIGHRES_DIR = path.resolve(OUTPUT_DIR, "original_highres");

for (const dir of [OUTPUT_DIR, HIGHRES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Complete 1:1 Mapping to the official Microsoft Fluent 3D open-source assets
const FLUENT_MAPPING: Record<string, { code: string; name: string }> = {
  status_available: { code: "1f7e2", name: "Green Circle" },
  status_partially_available: { code: "1f7e1", name: "Yellow Circle" },
  status_limited: { code: "1f538", name: "Small Orange Diamond" },
  status_sold_out: { code: "1f534", name: "Red Circle" },
  status_live: { code: "1f4e1", name: "Satellite Antenna / Radar" },
  status_standby: { code: "1f4a4", name: "Zzz Sleep" },
  status_delay: { code: "26a0", name: "Warning Sign" },
  pool_flagship: { code: "1f680", name: "Rocket" },
  pool_frontier: { code: "26a1", name: "High Voltage Bolt" },
  pool_core: { code: "1f9e0", name: "Brain" },
  pool_generic: { code: "1f4e6", name: "Package Box" },
  region_asia: { code: "1f30f", name: "Globe Asia-Australia" },
  region_europe: { code: "1f30d", name: "Globe Europe-Africa" },
  region_americas: { code: "1f30e", name: "Globe Americas" },
  region_all: { code: "1f310", name: "Globe with Meridians" },
  event_slot_drop: { code: "26a1", name: "Zap Lightning" },
  event_slot_sold: { code: "1f512", name: "Locked Padlock" },
  event_price_drop: { code: "1f4c9", name: "Chart Decreasing" },
  event_price_hike: { code: "1f4c8", name: "Chart Increasing" },
  event_model_upgrade: { code: "1f680", name: "Rocket Launch" },
  event_tier_update: { code: "1f4dd", name: "Memo / Blueprint" },
  event_new_pool: { code: "2728", name: "Sparkles" },
  event_batch_drop: { code: "1f195", name: "NEW Badge" },
  event_hot_slot: { code: "1f525", name: "Fire Flame" },
  ai_robot: { code: "1f916", name: "Robot" },
  ai_deepseek: { code: "1f40b", name: "Whale" },
  ai_claude: { code: "2728", name: "Sparkles Star" },
  ai_qwen: { code: "1f52e", name: "Crystal Ball" },
  ai_glm: { code: "1f9ec", name: "DNA Double Helix" },
  ai_llama: { code: "1f999", name: "Llama" },
  ai_mistral: { code: "1f32a", name: "Tornado Vortex" },
  nav_back: { code: "2b05", name: "Left Arrow" },
  nav_refresh: { code: "1f504", name: "Counterclockwise Arrows" },
  nav_settings: { code: "2699", name: "Gear Cog" },
  nav_admin: { code: "1f451", name: "Crown" },
  nav_guide: { code: "1f4d6", name: "Open Book" },
  nav_author: { code: "1f4bb", name: "Laptop Computer" },
  nav_language: { code: "1f310", name: "Language Globe" },
  nav_chart: { code: "1f4ca", name: "Bar Chart" },
  nav_cart: { code: "1f6d2", name: "Shopping Cart" },
  nav_link: { code: "1f517", name: "Link Chains" },
  nav_clock: { code: "1f552", name: "Three O Clock" },
  notify_bell_on: { code: "1f514", name: "Bell" },
  notify_bell_off: { code: "1f515", name: "Bell with Slash" },
  notify_loud: { code: "1f50a", name: "Speaker High Volume" },
  notify_mute: { code: "1f507", name: "Muted Speaker" },
  toggle_on: { code: "2705", name: "Check Mark Button" },
  toggle_off: { code: "274c", name: "Cross Mark Button" },
  price_tag: { code: "1f3f7", name: "Price Label" },
  price_money: { code: "1f4b0", name: "Money Bag" },
  price_dollar: { code: "1f4b5", name: "Dollar Banknote" },
  price_all_time_low: { code: "1f525", name: "Fire Supernova" },
  price_fair: { code: "2696", name: "Balance Scale" },
  prediction_crystal: { code: "1f52e", name: "Crystal Ball" },
};

function downloadUrl(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location!).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch ${url} (HTTP ${res.statusCode})`));
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchPureUntouchedFluentAssets() {
  console.log("🚀 Downloading 100% PURE, UNTOUCHED official Microsoft Fluent 3D Emojis...");

  const manifest = JSON.parse(
    fs.readFileSync(path.join(OUTPUT_DIR, "manifest.json"), "utf-8")
  );

  let successCount = 0;

  for (const item of manifest.icons) {
    const mapping = FLUENT_MAPPING[item.key];
    if (!mapping) continue;

    const url = `https://cdn.jsdelivr.net/gh/shuding/fluentui-emoji-unicode/assets/${mapping.code}_3d.png`;
    const targetPng = path.join(OUTPUT_DIR, item.filename);
    const highresTarget = path.join(HIGHRES_DIR, item.filename);

    try {
      const buffer = await downloadUrl(url);

      // 1. Save pure untouched original file (High-Res)
      fs.writeFileSync(highresTarget, buffer);

      // 2. Save Telegram-ready 100x100 PNG with pure bicubic sampling
      await sharp(buffer)
        .resize(100, 100, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(targetPng);

      console.log(`  ✅ [${item.index}/54] ${item.key} (${mapping.name}) -> ${item.filename}`);
      successCount++;
    } catch (err: any) {
      console.warn(`  ⚠️ Failed for ${item.key} (${mapping.code}): ${err.message}`);
    }
  }

  console.log(`\n🎉 Successfully fetched ${successCount}/54 pure original Microsoft Fluent 3D Emojis!`);
  console.log(`📂 High-res originals saved in: ${HIGHRES_DIR}`);
  console.log(`📂 Telegram 100x100 assets in: ${OUTPUT_DIR}`);
}

fetchPureUntouchedFluentAssets().catch(console.error);
