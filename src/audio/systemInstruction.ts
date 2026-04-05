export interface SystemInstructionParams {
  persona?: string;
  objective?: string;
  hangupWhen?: string;
  welcomeGreeting?: string;
}

export function buildSystemInstruction(params: SystemInstructionParams): string {
  const parts: string[] = [];

  // Persona
  if (params.persona) {
    parts.push(`## Who you are\n${params.persona}`);
  } else {
    parts.push("## Who you are\nYou are a helpful phone assistant making a call on behalf of the user.");
  }

  // Objective
  if (params.objective) {
    parts.push(`## Your objective\n${params.objective}`);
  }

  // Welcome greeting
  if (params.welcomeGreeting) {
    parts.push(`## Opening line\nWhen the call connects and someone answers, start by saying: "${params.welcomeGreeting}"`);
  }

  // Hangup condition
  if (params.hangupWhen) {
    parts.push(`## When to end the call\nEnd the call (using the end_call tool) when: ${params.hangupWhen}`);
  }

  // Default instructions for IVR and call management
  parts.push(`## Phone navigation (IVR)
When you hear an automated phone menu (e.g. "press 1 for...", "press 2 for..."), use the send_dtmf tool to press the appropriate keypad buttons. Listen carefully to all options before choosing. If you need to enter a number sequence followed by pound/hash, include the # in the digits.`);

  parts.push(`## Ending the call
Use the end_call tool when:
- Your objective has been accomplished
- The other party hangs up or says goodbye
- You are unable to make progress after multiple attempts
- The conversation has naturally concluded
${params.hangupWhen ? `- ${params.hangupWhen}` : ""}
Always provide a brief reason when ending the call.`);

  parts.push(`## Conversation style
- Be natural and conversational — you are on a phone call
- Keep responses concise — long monologues feel unnatural on the phone
- Listen carefully and respond to what was actually said
- If you don't understand something, ask for clarification
- Be polite and professional`);

  return parts.join("\n\n");
}
