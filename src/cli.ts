#!/usr/bin/env node
import { Command } from "commander";
import { registerPlaceCommand } from "./commands/call/place.js";
import { registerListenCommand } from "./commands/call/listen.js";
import { registerStatusCommand as registerCallStatusCommand } from "./commands/call/status.js";
import { registerHangupCommand } from "./commands/call/hangup.js";
import { registerInitCommand } from "./commands/call/init.js";
import { registerTeardownCommand } from "./commands/call/teardown.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerContextCommand } from "./commands/context.js";
import { registerReplyCheckCommand } from "./commands/replyCheck.js";
import { registerCallbackDispatchCommand } from "./commands/callbackDispatch.js";
import { registerAskHumanCommand } from "./commands/askHuman.js";
import { registerAskHumanCheckCommand } from "./commands/askHumanCheck.js";
import { registerWhoamiCommand } from "./commands/whoami.js";
import { registerSendCommand } from "./commands/sms/send.js";
import { registerHistoryCommand } from "./commands/sms/history.js";
import { registerSendCommand as registerEmailSendCommand } from "./commands/email/send.js";
import { registerHistoryCommand as registerEmailHistoryCommand } from "./commands/email/history.js";
import { registerSearchCommand as registerEmailSearchCommand } from "./commands/email/search.js";
import { registerAddCommand as registerCalendarAddCommand } from "./commands/calendar/add.js";
import { registerRemoveCommand as registerCalendarRemoveCommand } from "./commands/calendar/remove.js";

const program = new Command();

program
  .name("outreach")
  .description("Agent-native outreach CLI — calls, SMS, email, calendar")
  .version("2.2.0");

// --- top-level commands ---
registerHealthCommand(program);
registerSetupCommand(program);
registerContextCommand(program);
registerReplyCheckCommand(program);
registerCallbackDispatchCommand(program);
registerAskHumanCommand(program);
registerAskHumanCheckCommand(program);
registerWhoamiCommand(program);

// --- sms subcommand group ---
const sms = program.command("sms").description("SMS / iMessage commands");
registerSendCommand(sms);
registerHistoryCommand(sms);

// --- email subcommand group ---
const email = program.command("email").description("Email / Gmail commands");
registerEmailSendCommand(email);
registerEmailHistoryCommand(email);
registerEmailSearchCommand(email);

// --- calendar subcommand group ---
const calendar = program.command("calendar").description("Google Calendar commands");
registerCalendarAddCommand(calendar);
registerCalendarRemoveCommand(calendar);

// --- call subcommand group ---
const call = program.command("call").description("Voice call commands");

registerInitCommand(call);
registerTeardownCommand(call);
registerPlaceCommand(call);
registerListenCommand(call);
registerCallStatusCommand(call);
registerHangupCommand(call);

program.parse();
