/**
 * src/bot/views/icons/iconRegistry.ts
 * Master Design Token Registry & Custom Telegram Emoji Definitions
 */

export interface IconDefinition {
  readonly customEmojiId: string;
  readonly unicodeFallback: string;
  readonly name: string;
  readonly category?: string;
}

export const ICON_REGISTRY = {
  // Status & Health
  status_available: {
    customEmojiId: "5416081784641168838",
    unicodeFallback: "🟢",
    name: "Animated Green Status Orb",
    category: "status",
  },
  status_partially_available: {
    customEmojiId: "5251305755172169919",
    unicodeFallback: "🟡",
    name: "Animated Yellow Status Orb",
    category: "status",
  },
  status_limited: {
    customEmojiId: "5251305755172169919",
    unicodeFallback: "🟡",
    name: "Animated Yellow Status Orb",
    category: "status",
  },
  status_sold_out: {
    customEmojiId: "5411225014148014586",
    unicodeFallback: "🔴",
    name: "Animated Red Status Orb",
    category: "status",
  },
  status_live: {
    customEmojiId: "5416081784641168838",
    unicodeFallback: "🟢",
    name: "Animated Live Green Ping",
    category: "status",
  },
  status_standby: {
    customEmojiId: "5451959871257713464",
    unicodeFallback: "💤",
    name: "3D Slumber Zzz",
    category: "status",
  },
  status_delay: {
    customEmojiId: "5251305755172169919",
    unicodeFallback: "⚠️",
    name: "Animated Warning Orb",
    category: "status",
  },
  onboarding_wave: {
    customEmojiId: "5199885118214255386",
    unicodeFallback: "👋",
    name: "3D Waving Hand",
    category: "status",
  },

  // Compute Pools & Tiers
  pool_flagship: {
    customEmojiId: "5445284980978621387",
    unicodeFallback: "🚀",
    name: "3D Hyperdrive Rocket",
    category: "pool",
  },
  pool_frontier: {
    customEmojiId: "5456140674028019486",
    unicodeFallback: "⚡",
    name: "Animated Electric Cyan Bolt",
    category: "pool",
  },
  pool_core: {
    customEmojiId: "5237799019329105246",
    unicodeFallback: "🧠",
    name: "3D Cyber Brain",
    category: "pool",
  },
  pool_generic: {
    customEmojiId: "5854908544712707500",
    unicodeFallback: "📦",
    name: "Animated Moving 3D Box",
    category: "pool",
  },

  // Geographic Regions & 8h Blocks
  region_asia: {
    customEmojiId: "5397753673130463064",
    unicodeFallback: "🌏",
    name: "3D Asia Globe",
    category: "region",
  },
  region_europe: {
    customEmojiId: "5399898266265475100",
    unicodeFallback: "🌍",
    name: "3D Europe Globe",
    category: "region",
  },
  region_americas: {
    customEmojiId: "5397575638146110953",
    unicodeFallback: "🌎",
    name: "3D Americas Globe",
    category: "region",
  },
  region_all: {
    customEmojiId: "5399898266265475100",
    unicodeFallback: "🌐",
    name: "3D Planetary Globe",
    category: "region",
  },

  // Event Triggers & Badges
  event_slot_drop: {
    customEmojiId: "5456140674028019486",
    unicodeFallback: "⚡",
    name: "Animated Slot Drop Lightning",
    category: "event",
  },
  event_slot_sold: {
    customEmojiId: "5296369303661067030",
    unicodeFallback: "🔒",
    name: "Animated Shut Padlock",
    category: "event",
  },
  event_price_drop: {
    customEmojiId: "5361748661640372834",
    unicodeFallback: "📉",
    name: "3D Price Drop Trend",
    category: "event",
  },
  event_price_hike: {
    customEmojiId: "5373001317042101552",
    unicodeFallback: "📈",
    name: "3D Price Hike Trend",
    category: "event",
  },
  event_model_upgrade: {
    customEmojiId: "5445284980978621387",
    unicodeFallback: "🚀",
    name: "3D Rocket Upgrade",
    category: "event",
  },
  event_tier_update: {
    customEmojiId: "5334882760735598374",
    unicodeFallback: "📝",
    name: "3D Memo Spec",
    category: "event",
  },
  event_new_pool: {
    customEmojiId: "5325547803936572038",
    unicodeFallback: "✨",
    name: "3D Sparkle",
    category: "event",
  },
  event_batch_drop: {
    customEmojiId: "5361979468887893611",
    unicodeFallback: "🆕",
    name: "3D NEW Badge",
    category: "event",
  },
  event_hot_slot: {
    customEmojiId: "5420315771991497307",
    unicodeFallback: "🔥",
    name: "3D Hot Flame",
    category: "event",
  },

  // AI Models & Compute Architecture
  ai_robot: {
    customEmojiId: "5372981976804366741",
    unicodeFallback: "🤖",
    name: "3D Android Robot",
    category: "model",
  },
  ai_deepseek: {
    customEmojiId: "5222292529533167322",
    unicodeFallback: "🐋",
    name: "3D DeepSeek Whale",
    category: "model",
  },
  ai_claude: {
    customEmojiId: "5325547803936572038",
    unicodeFallback: "✨",
    name: "3D Claude Sparkle",
    category: "model",
  },
  ai_qwen: {
    customEmojiId: "5361837567463399422",
    unicodeFallback: "🔮",
    name: "3D Qwen Crystal Ball",
    category: "model",
  },
  ai_glm: {
    customEmojiId: "5217444336089714383",
    unicodeFallback: "😖",
    name: "3D GLM Neural",
    category: "model",
  },
  ai_kimi: {
    customEmojiId: "5449569374065152798",
    unicodeFallback: "🌙",
    name: "3D Kimi Moon",
    category: "model",
  },
  ai_mimo: {
    customEmojiId: "5407025283456835913",
    unicodeFallback: "📱",
    name: "3D Xiaomi Phone",
    category: "model",
  },
  ai_minimax: {
    customEmojiId: "5397575638146110953",
    unicodeFallback: "🌊",
    name: "3D Ocean Wave",
    category: "model",
  },
  ai_llama: {
    customEmojiId: "5343553685525899318",
    unicodeFallback: "🦙",
    name: "3D Cyber Llama",
    category: "model",
  },
  ai_mistral: {
    customEmojiId: "6332347924063717264",
    unicodeFallback: "🌪️",
    name: "Animated Mistral Vortex",
    category: "model",
  },

  // Navigation, Controls & Settings
  nav_back: {
    customEmojiId: "5361748661640372834",
    unicodeFallback: "⬅️",
    name: "3D Back",
    category: "navigation",
  },
  nav_refresh: {
    customEmojiId: "5264727218734524899",
    unicodeFallback: "🔄",
    name: "3D Sync Refresh",
    category: "navigation",
  },
  nav_settings: {
    customEmojiId: "5341715473882955310",
    unicodeFallback: "⚙️",
    name: "Animated 3D Spinning Gear",
    category: "navigation",
  },
  nav_admin: {
    customEmojiId: "5467406098367521267",
    unicodeFallback: "👑",
    name: "3D Crown",
    category: "navigation",
  },
  nav_guide: {
    customEmojiId: "5226512880362332956",
    unicodeFallback: "📖",
    name: "3D Guide Book",
    category: "navigation",
  },
  nav_author: {
    customEmojiId: "5190498849440931467",
    unicodeFallback: "👨‍💻",
    name: "3D Hacker",
    category: "navigation",
  },
  nav_language: {
    customEmojiId: "5399898266265475100",
    unicodeFallback: "🌐",
    name: "3D Language Globe",
    category: "navigation",
  },
  flag_uk: {
    customEmojiId: "5447309366568953338",
    unicodeFallback: "🇺🇦",
    name: "Ukrainian Flag",
    category: "language",
  },
  flag_en: {
    customEmojiId: "5202196682497859879",
    unicodeFallback: "🇬🇧",
    name: "British Flag",
    category: "language",
  },
  flag_ru: {
    customEmojiId: "5449408995691341691",
    unicodeFallback: "🇷🇺",
    name: "Russian Flag",
    category: "language",
  },
  admin_users: {
    customEmojiId: "5372926953978341366",
    unicodeFallback: "👥",
    name: "3D Group Users",
    category: "admin",
  },
  admin_spider: {
    customEmojiId: "5445149053853637789",
    unicodeFallback: "🕷",
    name: "3D Web Spider",
    category: "admin",
  },
  nav_chart: {
    customEmojiId: "5431577498364158238",
    unicodeFallback: "📊",
    name: "3D Bar Chart",
    category: "navigation",
  },
  nav_cart: {
    customEmojiId: "5431499171045581032",
    unicodeFallback: "🛒",
    name: "3D Shopping Cart",
    category: "navigation",
  },
  nav_link: {
    customEmojiId: "5375129357373165375",
    unicodeFallback: "🔗",
    name: "3D Chain Link",
    category: "navigation",
  },
  nav_clock: {
    customEmojiId: "5451732530048802485",
    unicodeFallback: "⏳",
    name: "3D Animated Hourglass",
    category: "navigation",
  },

  // Notifications & Toggles
  notify_bell_on: {
    customEmojiId: "5242628160297641831",
    unicodeFallback: "🔔",
    name: "3D Alert Bell",
    category: "notify",
  },
  notify_bell_off: {
    customEmojiId: "5244807637157029775",
    unicodeFallback: "🔕",
    name: "3D Muted Bell",
    category: "notify",
  },
  notify_loud: {
    customEmojiId: "5242628160297641831",
    unicodeFallback: "🔊",
    name: "3D Speaker",
    category: "notify",
  },
  notify_mute: {
    customEmojiId: "5244807637157029775",
    unicodeFallback: "🔇",
    name: "3D Mute",
    category: "notify",
  },
  toggle_on: {
    customEmojiId: "5427009714745517609",
    unicodeFallback: "✅",
    name: "3D Checkmark",
    category: "notify",
  },
  toggle_off: {
    customEmojiId: "5465665476971471368",
    unicodeFallback: "❌",
    name: "3D Cross",
    category: "notify",
  },

  // Pricing & Intelligence
  price_tag: {
    customEmojiId: "5375296873982604963",
    unicodeFallback: "🏷️",
    name: "3D Price Gold",
    category: "price",
  },
  price_money: {
    customEmojiId: "5375296873982604963",
    unicodeFallback: "💰",
    name: "3D Gold Money Bag",
    category: "price",
  },
  price_dollar: {
    customEmojiId: "5375296873982604963",
    unicodeFallback: "💵",
    name: "3D Dollar",
    category: "price",
  },
  price_all_time_low: {
    customEmojiId: "5420315771991497307",
    unicodeFallback: "🔥",
    name: "3D Supernova Flame",
    category: "price",
  },
  price_fair: {
    customEmojiId: "5431577498364158238",
    unicodeFallback: "⚖️",
    name: "3D Scales Metric",
    category: "price",
  },
  prediction_crystal: {
    customEmojiId: "5361837567463399422",
    unicodeFallback: "🔮",
    name: "3D Crystal Ball",
    category: "price",
  },

  // Day/Night Shifts & Hierarchy
  shift_night: {
    customEmojiId: "5451959871257713464",
    unicodeFallback: "🌌",
    name: "3D Night Cosmos",
    category: "shift",
  },
  shift_day: {
    customEmojiId: "5472164874886846699",
    unicodeFallback: "☀️",
    name: "3D Day Sun",
    category: "shift",
  },
  shift_evening: {
    customEmojiId: "5397575638146110953",
    unicodeFallback: "🌆",
    name: "3D Evening Sunset",
    category: "shift",
  },
  rank_diamond: {
    customEmojiId: "5471952986970267163",
    unicodeFallback: "💎",
    name: "3D Animated Sparkling Diamond",
    category: "rank",
  },
  diamond: {
    customEmojiId: "5471952986970267163",
    unicodeFallback: "💎",
    name: "3D Animated Sparkling Diamond",
    category: "rank",
  },
  rank_shield: {
    customEmojiId: "5237799019329105246",
    unicodeFallback: "🛡️",
    name: "3D Security Shield",
    category: "rank",
  },
  rank_heart: {
    customEmojiId: "5449505950283078474",
    unicodeFallback: "❤️",
    name: "3D Animated Pulsing Red Heart",
    category: "rank",
  },
  heart: {
    customEmojiId: "5449505950283078474",
    unicodeFallback: "❤️",
    name: "3D Animated Pulsing Red Heart",
    category: "rank",
  },
  rank_infinity: {
    customEmojiId: "6298717844804733009",
    unicodeFallback: "♾️",
    name: "3D Animated Infinity Loop",
    category: "rank",
  },
  infinity: {
    customEmojiId: "6298717844804733009",
    unicodeFallback: "♾️",
    name: "3D Animated Infinity Loop",
    category: "rank",
  },
  zap: {
    customEmojiId: "5456140674028019486",
    unicodeFallback: "⚡",
    name: "3D Electric Cyan Bolt",
    category: "rank",
  },
  rocket: {
    customEmojiId: "5445284980978621387",
    unicodeFallback: "🚀",
    name: "3D Hyperdrive Rocket",
    category: "rank",
  },

  // Donations & Stars
  coffee: {
    customEmojiId: "5307845791283425776",
    unicodeFallback: "☕",
    name: "3D Hot Coffee Cup",
    category: "donation",
  },
  star: {
    customEmojiId: "5456658836062479826",
    unicodeFallback: "⭐",
    name: "3D Animated Telegram Star",
    category: "donation",
  },
  tip_lightbulb: {
    customEmojiId: "5422439311196834318",
    unicodeFallback: "💡",
    name: "3D Glowing Lightbulb",
    category: "donation",
  },
  git_octopus: {
    customEmojiId: "5352815688010441881",
    unicodeFallback: "🐙",
    name: "3D Git Octopus",
    category: "donation",
  },
  writing_hand: {
    customEmojiId: "5470060791883374114",
    unicodeFallback: "✍️",
    name: "3D Writing Hand",
    category: "donation",
  },

  // User Profile & Community
  user: {
    customEmojiId: "5373012449597335010",
    unicodeFallback: "👤",
    name: "3D Glowing User Avatar",
    category: "profile",
  },
  user_profile: {
    customEmojiId: "5373012449597335010",
    unicodeFallback: "👤",
    name: "3D Glowing User Avatar",
    category: "profile",
  },
  users_group: {
    customEmojiId: "5372926953978341366",
    unicodeFallback: "👥",
    name: "3D Users Group",
    category: "profile",
  },
  id_badge: {
    customEmojiId: "5422683699130933153",
    unicodeFallback: "🪪",
    name: "3D ID Security Badge",
    category: "profile",
  },
} as const satisfies Record<string, IconDefinition>;

export type IconKey = keyof typeof ICON_REGISTRY;
