import { Command } from "commander";
import {
  sendIMessage,
  normalizePhone,
  type Service,
} from "../../providers/messages.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, OPERATION_FAILED } from "../../exitCodes.js";

function withSmsHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("not allowed") || lower.includes("not permitted"))
    return `${msg}. Grant Accessibility access to your terminal app in System Settings → Privacy & Security.`;
  if (lower.includes("text message forwarding"))
    return `${msg}`;
  return `${msg}. Check that Messages.app is signed in. Run 'outreach health' to check SMS readiness.`;
}

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage/SMS message")
    .requiredOption("--to <number>", "Recipient phone number")
    .requiredOption("--body <text>", "Message body")
    .option("--service <service>", "Messages service: iMessage or SMS", "iMessage")
    .action(
      async (opts: {
        to: string;
        body: string;
        service: string;
      }) => {
        const normalized = normalizePhone(opts.to);

        const service = normalizeRequestedService(opts.service);

        let sendResult;
        try {
          sendResult = sendIMessage(normalized, opts.body, { service });
        } catch (err) {
          outputError(
            OPERATION_FAILED,
            withSmsHint(`Failed to send message: ${(err as Error).message}`),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        outputJson({
          to: normalized,
          status: sendResult.status,
          service: sendResult.service,
        });
        process.exit(SUCCESS);
      },
    );
}

function normalizeRequestedService(value: string): Service {
  return value.toLowerCase() === "imessage" ? "iMessage" : "SMS";
}
