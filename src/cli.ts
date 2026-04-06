#!/usr/bin/env node
import { Command } from "commander";
import { registerAppendCommand } from "./commands/log/append.js";
import { registerReadCommand } from "./commands/log/read.js";
import { registerPlaceCommand } from "./commands/call/place.js";
import { registerListenCommand } from "./commands/call/listen.js";
import { registerStatusCommand as registerCallStatusCommand } from "./commands/call/status.js";
import { registerHangupCommand } from "./commands/call/hangup.js";
import { registerInitCommand } from "./commands/init.js";
import { registerTeardownCommand } from "./commands/teardown.js";
import { registerStatusCommand } from "./commands/runtimeStatus.js";

const program = new Command();

program
  .name("outreach")
  .description("Agent-native outreach CLI — calls, SMS, email")
  .version("0.1.0");

// --- top-level lifecycle commands ---
registerInitCommand(program);
registerTeardownCommand(program);
registerStatusCommand(program);

// --- call subcommand group ---
const call = program.command("call").description("Voice call commands");

registerPlaceCommand(call);
registerListenCommand(call);
registerCallStatusCommand(call);
registerHangupCommand(call);

// --- log subcommand group ---
const log = program.command("log").description("Session log commands");
registerAppendCommand(log);
registerReadCommand(log);

program.parse();
