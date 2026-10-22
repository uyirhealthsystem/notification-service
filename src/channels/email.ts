import { sendEmail, emailProvider, type Email } from "../lib/mailer";
import type { Delivery } from "../notifications/deliver";

// The EMAIL channel, in the shape deliver() takes. Each future channel gets a
// module like this one (sms.ts -> Twilio/MSG91, push.ts -> FCM, whatsapp.ts ->
// WhatsApp Cloud API): it renders nothing, it just knows how to hand a message
// to its provider and report the provider's message id.
export function emailDelivery(email: Email, opts: { template: string; referenceId?: string }): Delivery {
  return {
    channel: "EMAIL",
    template: opts.template,
    recipient: email.to,
    referenceId: opts.referenceId,
    provider: emailProvider,
    send: async () => {
      const { messageId } = await sendEmail(email);
      return { providerMessageId: messageId };
    },
  };
}
