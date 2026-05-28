import { Command } from "commander";
import { latestTranscriptCallId, readTranscript, transcriptPath, type CallSummaryEvent, type TranscriptEvent } from "../../logs/sessionLog.js";
import { outputJson, outputError } from "../../output.js";
import { SUCCESS, INPUT_ERROR, INFRA_ERROR } from "../../exitCodes.js";

interface LatencyOptions {
  id?: string;
  latest?: boolean;
}

interface LatencyAssessment {
  target_ms: number;
  baseline_range_ms: [number, number];
  status: "pass" | "borderline" | "fail" | "unavailable";
  basis: "pickup_to_audible_greeting_ms" | "stream_start_to_audible_greeting_ms" | "user_speech_to_audible_response_ms" | "unavailable";
  message: string;
  improvement_vs_baseline_min_ms?: number;
  improvement_vs_baseline_min_pct?: number;
  likely_bottleneck?: string;
}

export interface LatencySummaryResult {
  id: string;
  transcript_path: string;
  pickup_to_audible_greeting_ms: number | null;
  pickup_to_audible_greeting_source: string | null;
  stream_start_to_audible_greeting_ms: number | null;
  stream_start_to_audible_greeting_source: string | null;
  mode: "proactive_greeting" | "wait_for_user";
  user_speech_to_audible_response_ms: number | null;
  user_speech_to_audible_response_source: string | null;
  assessment: LatencyAssessment;
  missing_latency_milestones?: string[];
  summary_source: "call_summary" | "computed_from_events";
  summary: CallSummaryEvent;
}

const HUMAN_FEELING_TARGET_MS = 1000;
const BORDERLINE_TARGET_MS = 2500;
const BASELINE_RANGE_MS: [number, number] = [5000, 8000];

function latestSummary(events: Awaited<ReturnType<typeof readTranscript>>): CallSummaryEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "call_summary") return event;
  }
  return undefined;
}

function tsMs(ts?: string): number | undefined {
  if (!ts) return undefined;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function diffMs(later?: string, earlier?: string): number | undefined {
  const laterMs = tsMs(later);
  const earlierMs = tsMs(earlier);
  if (laterMs === undefined || earlierMs === undefined) return undefined;
  return laterMs - earlierMs;
}

function firstEventTs(events: TranscriptEvent[], type: TranscriptEvent["type"]): string | undefined {
  return events.find((event) => event.type === type)?.ts;
}

function missingMilestones(events: TranscriptEvent[], summary: CallSummaryEvent): string[] {
  if (summary.answer_to_first_outbound_audio_played_ms !== undefined) return [];
  if (summary.answer_to_first_outbound_audio_ms !== undefined) return [];

  const missing: string[] = [];
  if (!firstEventTs(events, "call_answered")) missing.push("call_answered");
  if (!firstEventTs(events, "first_outbound_audio")) missing.push("first_outbound_audio");
  if (!firstEventTs(events, "first_outbound_audio_played")) missing.push("first_outbound_audio_played");
  return missing;
}

function streamStartToAudibleGreeting(summary: CallSummaryEvent): number | undefined {
  return summary.stream_to_first_outbound_audio_played_ms ?? summary.stream_to_first_outbound_audio_ms;
}

function userSpeechToAudibleResponse(summary: CallSummaryEvent): { value?: number; source?: string } {
  if (summary.first_remote_audio_activity_end_to_first_outbound_audio_played_ms !== undefined) {
    return {
      value: summary.first_remote_audio_activity_end_to_first_outbound_audio_played_ms,
      source: "first_remote_audio_activity_end_to_first_outbound_audio_played_ms",
    };
  }
  if (summary.first_remote_audio_activity_end_to_first_outbound_audio_ms !== undefined) {
    return {
      value: summary.first_remote_audio_activity_end_to_first_outbound_audio_ms,
      source: "first_remote_audio_activity_end_to_first_outbound_audio_ms",
    };
  }
  if (summary.first_remote_audio_activity_to_first_outbound_audio_played_ms !== undefined) {
    return {
      value: summary.first_remote_audio_activity_to_first_outbound_audio_played_ms,
      source: "first_remote_audio_activity_to_first_outbound_audio_played_ms",
    };
  }
  if (summary.first_remote_audio_activity_to_first_outbound_audio_ms !== undefined) {
    return {
      value: summary.first_remote_audio_activity_to_first_outbound_audio_ms,
      source: "first_remote_audio_activity_to_first_outbound_audio_ms",
    };
  }
  if (summary.first_response_delay_ms !== undefined) {
    return {
      value: summary.first_response_delay_ms,
      source: "first_response_delay_ms",
    };
  }
  return {};
}

function isWaitForUserSummary(summary: CallSummaryEvent): boolean {
  return summary.wait_for_user_before_greeting === true ||
    (
      summary.wait_for_user_before_greeting !== false &&
      summary.stream_to_initial_greeting_request_ms === undefined &&
      summary.first_remote_audio_activity_to_first_outbound_audio_played_ms !== undefined
    );
}

function computeSummary(events: TranscriptEvent[]): CallSummaryEvent {
  const answeredAt = firstEventTs(events, "call_answered");
  const mediaStreamStartedAt = firstEventTs(events, "media_stream_started");
  const firstOutboundAudioAt = firstEventTs(events, "first_outbound_audio");
  const firstOutboundAudioPlayedAt = firstEventTs(events, "first_outbound_audio_played");
  const initialGreetingRequestedAt = firstEventTs(events, "initial_greeting_requested");

  return {
    type: "call_summary",
    ts: new Date().toISOString(),
    duration_ms: 0,
    ...(diffMs(mediaStreamStartedAt, answeredAt) !== undefined && { answer_to_stream_ms: diffMs(mediaStreamStartedAt, answeredAt) }),
    ...(diffMs(initialGreetingRequestedAt, mediaStreamStartedAt) !== undefined && {
      stream_to_initial_greeting_request_ms: diffMs(initialGreetingRequestedAt, mediaStreamStartedAt),
    }),
    ...(diffMs(firstOutboundAudioAt, initialGreetingRequestedAt) !== undefined && {
      initial_greeting_request_to_first_outbound_audio_ms: diffMs(firstOutboundAudioAt, initialGreetingRequestedAt),
    }),
    ...(diffMs(firstOutboundAudioAt, mediaStreamStartedAt) !== undefined && {
      stream_to_first_outbound_audio_ms: diffMs(firstOutboundAudioAt, mediaStreamStartedAt),
    }),
    ...(diffMs(firstOutboundAudioAt, answeredAt) !== undefined && {
      answer_to_first_outbound_audio_ms: diffMs(firstOutboundAudioAt, answeredAt),
    }),
    ...(diffMs(firstOutboundAudioPlayedAt, mediaStreamStartedAt) !== undefined && {
      stream_to_first_outbound_audio_played_ms: diffMs(firstOutboundAudioPlayedAt, mediaStreamStartedAt),
    }),
    ...(diffMs(firstOutboundAudioPlayedAt, answeredAt) !== undefined && {
      answer_to_first_outbound_audio_played_ms: diffMs(firstOutboundAudioPlayedAt, answeredAt),
    }),
  };
}

function largestDiagnostic(summary: CallSummaryEvent): string | undefined {
  const candidates = [
    { name: "answer_to_stream_ms", value: summary.answer_to_stream_ms },
    { name: "stream_to_initial_greeting_request_ms", value: summary.stream_to_initial_greeting_request_ms },
    { name: "initial_greeting_request_to_first_outbound_audio_ms", value: summary.initial_greeting_request_to_first_outbound_audio_ms },
    { name: "stream_to_first_outbound_audio_played_ms", value: summary.stream_to_first_outbound_audio_played_ms },
  ].filter((candidate): candidate is { name: string; value: number } => candidate.value !== undefined);

  candidates.sort((a, b) => b.value - a.value);
  return candidates[0]?.name;
}

function likelyBottleneck(summary: CallSummaryEvent, missing: string[]): string | undefined {
  if (missing.length > 0) return "missing_latency_milestones";
  if (isWaitForUserSummary(summary)) {
    if (summary.first_remote_audio_activity_end_to_first_outbound_audio_played_ms !== undefined) {
      return "local_vad_endpoint_to_playback";
    }
    if (summary.first_remote_audio_activity_to_first_outbound_audio_played_ms !== undefined) {
      return "remote_audio_activity_to_playback";
    }
    return "wait_for_user_turn_detection";
  }
  if (summary.pre_generated_greeting_requested === false) return "greeting_pregeneration_not_requested";
  if (summary.pre_generated_greeting_ended_before_stream === true) return "greeting_pregeneration_ended_before_stream";
  if (summary.pre_generated_greeting_audio_chunks === 0) return "greeting_not_generated_before_stream";
  if (
    summary.pre_generated_greeting_ready_before_stream === true &&
    (summary.answer_to_first_outbound_audio_played_ms ?? 0) > BORDERLINE_TARGET_MS
  ) {
    return "twilio_stream_playback_or_pstn_path";
  }
  return largestDiagnostic(summary);
}

function assessLatency(
  pickupToAudibleGreetingMs: number | undefined,
  streamStartToAudibleGreetingMs: number | undefined,
  userSpeechToAudibleResponseMs: number | undefined,
  summary: CallSummaryEvent,
  missing: string[],
): LatencyAssessment {
  const base = {
    target_ms: HUMAN_FEELING_TARGET_MS,
    baseline_range_ms: BASELINE_RANGE_MS,
  };

  if (isWaitForUserSummary(summary)) {
    if (userSpeechToAudibleResponseMs === undefined) {
      return {
        ...base,
        status: "unavailable",
        basis: "unavailable",
        message: "Wait-for-user turn latency could not be computed from this transcript.",
        likely_bottleneck: likelyBottleneck(summary, missing),
      };
    }

    return {
      ...base,
      status: userSpeechToAudibleResponseMs <= HUMAN_FEELING_TARGET_MS
        ? "pass"
        : userSpeechToAudibleResponseMs <= BORDERLINE_TARGET_MS
          ? "borderline"
          : "fail",
      basis: "user_speech_to_audible_response_ms",
      message: "Wait-for-user call assessed from detected user speech to audible agent response.",
      likely_bottleneck: likelyBottleneck(summary, missing),
    };
  }

  if (pickupToAudibleGreetingMs === undefined) {
    if (streamStartToAudibleGreetingMs !== undefined) {
      return {
        ...base,
        status: streamStartToAudibleGreetingMs <= HUMAN_FEELING_TARGET_MS
          ? "pass"
          : streamStartToAudibleGreetingMs <= BORDERLINE_TARGET_MS
            ? "borderline"
            : "fail",
        basis: "stream_start_to_audible_greeting_ms",
        message: "Strict pickup timing is unavailable because call_answered is missing, but media-stream-start to audible greeting was measured.",
        likely_bottleneck: likelyBottleneck(summary, missing),
      };
    }

    return {
      ...base,
      status: "unavailable",
      basis: "unavailable",
      message: "Pickup-to-greeting latency could not be computed from this transcript.",
      likely_bottleneck: likelyBottleneck(summary, missing),
    };
  }

  const improvementMs = BASELINE_RANGE_MS[0] - pickupToAudibleGreetingMs;
  const improvementPct = Math.round((improvementMs / BASELINE_RANGE_MS[0]) * 100);
  const common = {
    ...base,
    improvement_vs_baseline_min_ms: improvementMs,
    improvement_vs_baseline_min_pct: improvementPct,
    likely_bottleneck: likelyBottleneck(summary, missing),
  };

  if (pickupToAudibleGreetingMs <= HUMAN_FEELING_TARGET_MS) {
    return {
      ...common,
      status: "pass",
      basis: "pickup_to_audible_greeting_ms",
      message: "Pickup-to-greeting latency is in the target range for a natural answer experience.",
    };
  }

  if (pickupToAudibleGreetingMs <= BORDERLINE_TARGET_MS) {
    return {
      ...common,
      status: "borderline",
      basis: "pickup_to_audible_greeting_ms",
      message: "Pickup-to-greeting latency is much better than the 5-8s baseline but may still feel slightly delayed.",
    };
  }

  return {
    ...common,
    status: "fail",
    basis: "pickup_to_audible_greeting_ms",
    message: "Pickup-to-greeting latency is still above the target range; inspect the diagnostic fields for the dominant segment.",
  };
}

export async function summarizeLatency(callId: string): Promise<LatencySummaryResult> {
  const [events, path] = await Promise.all([
    readTranscript(callId),
    transcriptPath(callId),
  ]);
  const existingSummary = latestSummary(events);
  const summary = existingSummary ?? computeSummary(events);

  const pickupToAudibleGreetingMs =
    summary.answer_to_first_outbound_audio_played_ms ??
    summary.answer_to_first_outbound_audio_ms;
  const streamStartToAudibleGreetingMs = streamStartToAudibleGreeting(summary);
  const turnLatency = userSpeechToAudibleResponse(summary);
  const missing = missingMilestones(events, summary);

  return {
    id: callId,
    transcript_path: path,
    pickup_to_audible_greeting_ms: pickupToAudibleGreetingMs ?? null,
    pickup_to_audible_greeting_source:
      summary.answer_to_first_outbound_audio_played_ms !== undefined
        ? "answer_to_first_outbound_audio_played_ms"
        : summary.answer_to_first_outbound_audio_ms !== undefined
          ? "answer_to_first_outbound_audio_ms"
          : null,
    stream_start_to_audible_greeting_ms: streamStartToAudibleGreetingMs ?? null,
    stream_start_to_audible_greeting_source:
      summary.stream_to_first_outbound_audio_played_ms !== undefined
        ? "stream_to_first_outbound_audio_played_ms"
        : summary.stream_to_first_outbound_audio_ms !== undefined
          ? "stream_to_first_outbound_audio_ms"
          : null,
    mode: isWaitForUserSummary(summary) ? "wait_for_user" : "proactive_greeting",
    user_speech_to_audible_response_ms: turnLatency.value ?? null,
    user_speech_to_audible_response_source: turnLatency.source ?? null,
    assessment: assessLatency(pickupToAudibleGreetingMs, streamStartToAudibleGreetingMs, turnLatency.value, summary, missing),
    ...(missing.length > 0 ? { missing_latency_milestones: missing } : {}),
    summary_source: existingSummary ? "call_summary" : "computed_from_events",
    summary,
  };
}

export function registerLatencyCommand(parent: Command): void {
  parent
    .command("latency")
    .description("Summarize latency metrics from a saved call transcript")
    .option("--id <callId>", "Call ID")
    .option("--latest", "Use the newest saved call transcript")
    .action(async (opts: LatencyOptions) => {
      if (!opts.id && !opts.latest) {
        outputError(INPUT_ERROR, "--id is required unless --latest is used");
        process.exit(INPUT_ERROR);
        return;
      }
      if (opts.id && opts.latest) {
        outputError(INPUT_ERROR, "Use either --id or --latest, not both");
        process.exit(INPUT_ERROR);
        return;
      }

      try {
        const callId = opts.latest ? await latestTranscriptCallId() : opts.id;
        if (!callId) {
          outputError(INPUT_ERROR, "No saved call transcripts found");
          process.exit(INPUT_ERROR);
          return;
        }
        outputJson(await summarizeLatency(callId));
        process.exit(SUCCESS);
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          outputError(INPUT_ERROR, `No transcript found for ${opts.id ?? "latest call"}`);
          process.exit(INPUT_ERROR);
          return;
        }
        outputError(INFRA_ERROR, (err as Error).message);
        process.exit(INFRA_ERROR);
      }
    });
}
