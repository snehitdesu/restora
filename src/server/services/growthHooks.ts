/**
 * What happens to the guest's side of the books when an order is paid (inside the settlement transaction, so it
 * commits or rolls back with the payment): loyalty points, the referral reward for a first order, and the feedback
 * request that goes out later. Each step is idempotent; each is a no-op for an order without a guest record.
 */
import { type AccessContext } from "@/server/db/scope";
import { type Tx } from "@/server/services/_workflow";
import { awardOrderLoyaltyTx } from "@/server/services/loyalty";
import { rewardReferralTx } from "@/server/services/referrals";
import { scheduleFeedbackRequestTx } from "@/server/services/feedbackLoop";

export async function afterOrderPaidTx(tx: Tx, ctx: AccessContext, orderId: string): Promise<void> {
  await awardOrderLoyaltyTx(tx, ctx, orderId); // no-op without a customer
  await rewardReferralTx(tx, ctx, orderId);
  await scheduleFeedbackRequestTx(tx, ctx, orderId);
}
