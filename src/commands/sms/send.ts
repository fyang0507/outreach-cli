import { Command } from "commander";
import {
  sendIMessage,
  normalizePhone,
  pickService,
  type Service,
} from "../../providers/messages.js";
import { outputJson, outputError } from "../../output.js";
import {
  SUCCESS,
  INPUT_ERROR,
  INFRA_ERROR,
  OPERATION_FAILED,
} from "../../exitCodes.js";

function withSmsHint(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("not allowed") || lower.includes("not permitted"))
    return `${msg}. Grant Accessibility access to your terminal app in System Settings → Privacy & Security.`;
  if (lower.includes("text message forwarding"))
    return `${msg}`;
  if (lower.includes("not delivered") || lower.includes("error code"))
    return `${msg}. Messages.app reported a terminal failure.`;
  if (lower.includes("status unknown"))
    return `${msg}. Check Messages.app before retrying to avoid a duplicate.`;
  return `${msg}. Check that Messages.app is signed in. Run 'outreach health' to check SMS readiness.`;
}

export function registerSendCommand(parent: Command): void {
  parent
    .command("send")
    .description("Send an iMessage/SMS message")
    .requiredOption("--to <number>", "Recipient phone number")
    .requiredOption("--body <text>", "Message body")
    .option(
      "--service <service>",
      "Messages service: iMessage or SMS (default: auto from history)",
    )
    .action(
      async (opts: {
        to: string;
        body: string;
        service?: string;
      }) => {
        const normalized = normalizePhone(opts.to);

        let service: Service;
        if (opts.service !== undefined) {
          try {
            service = normalizeRequestedService(opts.service);
          } catch (err) {
            outputError(INPUT_ERROR, (err as Error).message);
            process.exit(INPUT_ERROR);
            return;
          }
        } else {
          try {
            service = pickService(normalized);
          } catch (err) {
            outputError(
              INFRA_ERROR,
              `Failed to auto-select SMS service from Messages history: ${(err as Error).message}. Run 'outreach health' or pass --service explicitly.`,
            );
            process.exit(INFRA_ERROR);
            return;
          }
        }

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

        if (sendResult.status === "failed") {
          const code = sendResult.error_code !== undefined
            ? ` (error code ${sendResult.error_code})`
            : "";
          outputError(
            OPERATION_FAILED,
            withSmsHint(
              `Message not delivered${code} over ${sendResult.service}`,
            ),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        if (sendResult.status === "timeout") {
          outputError(
            OPERATION_FAILED,
            withSmsHint(
              `Delivery status unknown after 90s over ${sendResult.service}`,
            ),
          );
          process.exit(OPERATION_FAILED);
          return;
        }

        outputJson({
          to: normalized,
          status: sendResult.status,
          service: sendResult.service,
        });
        // process.exitCode, not process.exit(): see outputJson() in src/output.ts.
        process.exitCode = SUCCESS;
      },
    );
}

function normalizeRequestedService(value: string): Service {
  const normalized = value.toLowerCase();
  if (normalized === "imessage") return "iMessage";
  if (normalized === "sms") return "SMS";
  throw new Error(`Invalid --service '${value}'. Expected iMessage or SMS.`);
}
