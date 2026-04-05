#!/usr/bin/env node
import { Command } from "commander";
import { registerAppendCommand } from "./commands/log/append.js";
import { registerReadCommand } from "./commands/log/read.js";
import { registerPlaceCommand } from "./commands/call/place.js";
import { registerListenCommand } from "./commands/call/listen.js";
import { registerSayCommand } from "./commands/call/say.js";
import { registerDtmfCommand } from "./commands/call/dtmf.js";
import { registerStatusCommand } from "./commands/call/status.js";
import { registerHangupCommand } from "./commands/call/hangup.js";

const program = new Command();

program
  .name("outreach")
  .description("Agent-native outreach CLI — calls, SMS, email")
  .version("0.1.0");

// --- call subcommand group ---
const call = program.command("call").description("Voice call commands");

registerPlaceCommand(call);
registerListenCommand(call);
registerSayCommand(call);
registerDtmfCommand(call);
registerStatusCommand(call);
registerHangupCommand(call);

// --- log subcommand group ---
const log = program.command("log").description("Session log commands");
registerAppendCommand(log);
registerReadCommand(log);

program.parse();
