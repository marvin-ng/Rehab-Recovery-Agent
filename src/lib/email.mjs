// Shared SES send wrapper. One send path for both the nudge and the digest
// Lambdas — no duplicated SES setup between them (same lesson as Phase 3's
// shared isPerformed helper).
//
// SES is in sandbox (Phase 0, D-4): sender AND recipient must both be the one
// verified identity. Sender = recipient = marvin.ngonadi@gmail.com. The
// "therapist-ready" digest is formatted for Marvin to share himself, never an
// automated send to a third party.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const REGION = process.env.AWS_REGION || "us-east-1";
const IDENTITY = process.env.EMAIL_IDENTITY || "marvin.ngonadi@gmail.com";

const ses = new SESv2Client({ region: REGION });

// Send one plain-text email from the verified identity to itself.
export async function sendRehabEmail({ subject, body }) {
  const res = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: IDENTITY,
      Destination: { ToAddresses: [IDENTITY] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: body, Charset: "UTF-8" } },
        },
      },
    })
  );
  return res.MessageId;
}
