#!/usr/bin/env node
import { Command } from "commander";
import { registerPlaceCommand } from "./commands/call/place.js";
import { registerListenCommand } from "./commands/call/listen.js";
import { registerStatusCommand as registerCallStatusCommand } from "./commands/call/status.js";
import { registerHangupCommand } from "./commands/call/hangup.js";
import { registerInitCommand } from "./commands/call/init.js";
import { registerTeardownCommand } from "./commands/call/teardown.js";
import { registerHealthCommand } from "./commands/health.js";

const program = new Command();

program
  .name("outreach")
  .description("Agent-native outreach CLI — calls, SMS, email")
  .version("0.1.0");

// --- top-level commands ---
registerHealthCommand(program);

// --- call subcommand group ---
const call = program.command("call").description("Voice call commands");

registerInitCommand(call);
registerTeardownCommand(call);
registerPlaceCommand(call);
registerListenCommand(call);
registerCallStatusCommand(call);
registerHangupCommand(call);

program.parse();
