/**
 * src/bot/views/capacityBar.ts
 * Generates 3D animated orbs or Unicode capacity bars.
 */
import { icon, getRawUnicode } from "./iconTheme.js";

export function renderCapacityBar(
  availableCount: number,
  totalBlocks: number = 3,
  mode: "html" | "unicode" = "html"
): string {
  const total = Math.max(1, totalBlocks);
  const available = Math.max(0, Math.min(availableCount, total));
  const soldOut = total - available;

  if (mode === "unicode") {
    const green = getRawUnicode("status_available") || "🟢";
    const red = getRawUnicode("status_sold_out") || "🔴";
    const orbs: string[] = [];
    for (let i = 0; i < available; i++) orbs.push(green);
    for (let i = 0; i < soldOut; i++) orbs.push(red);
    return orbs.join(" ");
  }

  const greenOrb = icon("status_available");
  const redOrb = icon("status_sold_out");
  const orbs: string[] = [];

  for (let i = 0; i < available; i++) {
    orbs.push(greenOrb);
  }
  for (let i = 0; i < soldOut; i++) {
    orbs.push(redOrb);
  }

  return orbs.join(" ");
}
