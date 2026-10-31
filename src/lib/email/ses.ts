import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { describeErrorForLog } from "@/lib/errors/safe-error";

// Sending through Amazon SES (v2 API) with the AWS credentials the app
// already has for S3 (AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
// and SES_FROM_ADDRESS as the sender, which must be an address on a domain
// verified in SES (DEPLOY.md, "Emails with SES"). Without SES_FROM_ADDRESS
// nothing is sent: the caller logs and moves on, so a deployment without
// email still runs every job.

let cachedClient: SESv2Client | null = null;

function sesClient(): SESv2Client {
  if (!cachedClient) {
    const region = process.env.AWS_REGION?.trim();
    if (!region) throw new Error("AWS_REGION is not set");
    cachedClient = new SESv2Client({ region });
  }
  return cachedClient;
}

/** The sender (SES_FROM_ADDRESS), or null when email is not configured. */
export function emailFromAddress(): string | null {
  return process.env.SES_FROM_ADDRESS?.trim() || null;
}

export function isEmailConfigured(): boolean {
  return emailFromAddress() !== null;
}

export type OutgoingEmail = { to: string[]; subject: string; text: string; html: string };

/**
 * Sends one message to every address in `to` (one SES call: the recipients
 * are the firm's owner/admins, who may see each other's addresses). Returns
 * SES's message id. Throws when SES refuses or is unreachable; the job that
 * called it is retried by pg-boss.
 */
export async function sendEmail(message: OutgoingEmail): Promise<{ messageId: string | null }> {
  const from = emailFromAddress();
  if (!from) throw new Error("SES_FROM_ADDRESS is not set");
  try {
    const result = await sesClient().send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: message.to },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: message.text, Charset: "UTF-8" },
              Html: { Data: message.html, Charset: "UTF-8" },
            },
          },
        },
      })
    );
    return { messageId: result.MessageId ?? null };
  } catch (err) {
    // The SDK's error names the request; never the addresses in a rethrown message.
    throw new Error(`SES refused the email: ${describeErrorForLog(err)}`);
  }
}
