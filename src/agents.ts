export type AgentName = "claude" | "codex";

export interface AgentAdapter {
  /** Args for first invocation (no prior session). First element is the executable. */
  buildCreateArgs(prompt: string): string[];
  /** Args for resume invocation. First element is the executable. */
  buildResumeArgs(sessionId: string, prompt: string): string[];
  /** Extract session ID from agent's structured output (stdout). */
  parseSessionId(output: string): string | undefined;
}

const CLAUDE: AgentAdapter = {
  buildCreateArgs: (p) => [
    "claude",
    "--dangerously-skip-permissions",
    "-p",
    p,
    "--output-format",
    "json",
  ],
  buildResumeArgs: (id, p) => [
    "claude",
    "--resume",
    id,
    "--dangerously-skip-permissions",
    "-p",
    p,
    "--output-format",
    "json",
  ],
  parseSessionId: (out) => {
    const parsed = JSON.parse(out) as { session_id?: unknown };
    return typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  },
};

const CODEX: AgentAdapter = {
  buildCreateArgs: (p) => ["codex", "exec", "--yolo", "--json", p],
  buildResumeArgs: (id, p) => [
    "codex",
    "exec",
    "resume",
    id,
    "--yolo",
    "--json",
    p,
  ],
  // Codex emits NDJSON — the first line is `{"type":"thread.started","thread_id":"..."}`.
  parseSessionId: (out) => {
    const first = out.split("\n").find((l) => l.trim().length > 0);
    if (!first) return undefined;
    const parsed = JSON.parse(first) as { thread_id?: unknown };
    return typeof parsed.thread_id === "string" ? parsed.thread_id : undefined;
  },
};

const AGENTS: Record<AgentName, AgentAdapter> = {
  claude: CLAUDE,
  codex: CODEX,
};

export function getAgentAdapter(name: string): AgentAdapter {
  if (!(name in AGENTS)) {
    throw new Error(
      `Unsupported callback_agent "${name}". Supported: ${Object.keys(AGENTS).join(", ")}.`,
    );
  }
  return AGENTS[name as AgentName];
}

export function isAgentName(name: string): name is AgentName {
  return name in AGENTS;
}
