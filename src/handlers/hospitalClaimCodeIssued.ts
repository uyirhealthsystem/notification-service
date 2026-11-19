import { hospitalClaimCodeIssuedData } from "../events/schema";
import { hospitalClaimCodeIssuedEmail } from "../templates/hospitalClaimCodeIssued";
import { emailDelivery } from "../channels/email";
import { deliver, type EventContext } from "../notifications/deliver";
import { logger } from "../lib/logger";
import { NonRetryableError } from "../lib/errors";

const TEMPLATE = "hospital_claim_code";

// Handles hospital.events / HospitalClaimCodeIssued: emails a PRO-onboarded hospital its id and one-time
// claim code. hospitalservice publishes one per issued code (INITIAL, then each RESEND); each is a new code,
// so the reference includes expiresAt to keep resends from being de-duplicated against the first email.
export async function handleHospitalClaimCodeIssued(rawData: unknown, ctx: EventContext): Promise<void> {
  const parsed = hospitalClaimCodeIssuedData.safeParse(rawData);
  if (!parsed.success) {
    // Don't echo the payload - it contains the claim code.
    throw new NonRetryableError(
      "HospitalClaimCodeIssued: invalid payload",
      parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  const data = parsed.data;
  logger.info({ hospitalId: data.hospitalId, reason: data.reason }, "HospitalClaimCodeIssued: emailing hospital");
  await deliver(
    ctx,
    emailDelivery(hospitalClaimCodeIssuedEmail(data), {
      template: TEMPLATE,
      referenceId: `${data.hospitalId}:${data.expiresAt}`,
    }),
  );
}
