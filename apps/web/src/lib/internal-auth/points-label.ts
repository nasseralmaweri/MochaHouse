import "server-only";
import { getInternalSession } from "./session";
import { pointsLabelOrDefault } from "@/lib/loyalty-label";

// SC4f-3b — the ACTIVE business's name for its loyalty points, for Admin
// server components (React-cached /internal/me, shared with the layout).
export async function adminPointsLabel(): Promise<string> {
  const session = await getInternalSession();
  return pointsLabelOrDefault(session?.loyaltyPointsLabel);
}
