#!/usr/bin/env node
import { Command } from "commander";
import { registerPlaceCommand } from "./commands/call/place.js";
import { registerListenCommand } from "./commands/call/listen.js";
import { registerSteerCommand } from "./commands/call/steer.js";
import { registerStatusCommand as registerCallStatusCommand } from "./commands/call/status.js";
import { registerHangupCommand } from "./commands/call/hangup.js";
import { registerInitCommand } from "./commands/call/init.js";
import { registerTeardownCommand } from "./commands/call/teardown.js";
import { registerLatencyCommand } from "./commands/call/latency.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerSendCommand } from "./commands/sms/send.js";
import { registerHistoryCommand } from "./commands/sms/history.js";
import { registerSendCommand as registerEmailSendCommand } from "./commands/email/send.js";
import { registerHistoryCommand as registerEmailHistoryCommand } from "./commands/email/history.js";
import { registerSearchCommand as registerEmailSearchCommand } from "./commands/email/search.js";
import { registerPostCommand as registerDiscordPostCommand } from "./commands/discord/post.js";
import { registerChannelsCommand as registerDiscordChannelsCommand } from "./commands/discord/channels.js";
import { registerHistoryCommand as registerDiscordHistoryCommand } from "./commands/discord/history.js";

const program = new Command();

program
  .name("outreach")
  .description("Outreach utility CLI — calls, SMS/iMessage, email, Discord")
  .version("4.3.0");

// --- top-level commands ---
registerHealthCommand(program);

// --- sms subcommand group ---
const sms = program.command("sms").description("SMS / iMessage commands");
registerSendCommand(sms);
registerHistoryCommand(sms);

// --- email subcommand group ---
const email = program.command("email").description("Email / Gmail commands");
registerEmailSendCommand(email);
registerEmailHistoryCommand(email);
registerEmailSearchCommand(email);

// --- discord subcommand group ---
const discord = program.command("discord").description("Discord operator updates");
registerDiscordPostCommand(discord);
registerDiscordChannelsCommand(discord);
registerDiscordHistoryCommand(discord);

// --- call subcommand group ---
const call = program.command("call").description("Voice call commands");

registerInitCommand(call);
registerTeardownCommand(call);
registerPlaceCommand(call);
registerListenCommand(call);
registerSteerCommand(call);
registerCallStatusCommand(call);
registerHangupCommand(call);
registerLatencyCommand(call);

program.parse();
