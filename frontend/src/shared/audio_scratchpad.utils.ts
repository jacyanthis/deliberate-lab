/**
 * Audio scratchpad helpers.
 *
 * The recording orchestration lives in a plain controller (no DOM / Lit) so it
 * can be unit-tested with mocked media APIs. The Lit component wires it to the
 * real `getUserMedia` / `MediaRecorder` and a Firebase Storage uploader.
 */

/** File extension for a MediaRecorder mimeType (defaults to webm). */
export function audioExtensionForMimeType(mimeType?: string): string {
  const type = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  switch (type) {
    case 'audio/mp4':
      return 'mp4';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

/** Storage path for a participant's audio scratchpad recording. */
export function buildAudioScratchpadPath(params: {
  experimentId: string | null | undefined;
  participantId: string | null | undefined;
  stageId: string;
  timestamp: number;
  mimeType?: string;
}): string {
  const exp = params.experimentId || 'unknown-experiment';
  const pid = params.participantId || 'unknown-participant';
  const stage = params.stageId || 'unknown-stage';
  const ext = audioExtensionForMimeType(params.mimeType);
  return `participant_audio/${exp}/${pid}/${stage}_${params.timestamp}.${ext}`;
}

export type AudioRecorderStatus =
  | 'idle'
  | 'recording'
  | 'muted'
  | 'denied'
  | 'unsupported'
  | 'stopped';

export interface MinimalMediaStream {
  getTracks(): Array<{stop(): void; enabled?: boolean}>;
}

export interface MinimalRecorder {
  state: string;
  mimeType?: string;
  ondataavailable: ((event: {data: Blob}) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface AudioRecorderDeps {
  // Undefined when the browser does not support audio capture/recording.
  getUserMedia?: (constraints: {audio: boolean}) => Promise<MinimalMediaStream>;
  createRecorder?: (stream: MinimalMediaStream) => MinimalRecorder;
  upload: (blob: Blob) => Promise<void>;
}

/**
 * Captures the participant's microphone for the duration of a group chat and
 * uploads the recording when stopped. Decoupled from the DOM/Lit for testing.
 */
export class AudioScratchpadRecorder {
  status: AudioRecorderStatus = 'idle';
  private stream: MinimalMediaStream | null = null;
  private recorder: MinimalRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(private readonly deps: AudioRecorderDeps) {}

  async start(): Promise<AudioRecorderStatus> {
    if (this.status === 'recording') return this.status;
    const {getUserMedia, createRecorder} = this.deps;
    if (!getUserMedia || !createRecorder) {
      this.status = 'unsupported';
      return this.status;
    }
    try {
      this.stream = await getUserMedia({audio: true});
    } catch {
      this.status = 'denied';
      return this.status;
    }
    this.chunks = [];
    const recorder = createRecorder(this.stream);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start();
    this.recorder = recorder;
    this.status = 'recording';
    return this.status;
  }

  /** Mute the microphone (disable capture) without ending the recording. */
  mute(): AudioRecorderStatus {
    if (this.status !== 'recording') return this.status;
    this.setTracksEnabled(false);
    this.status = 'muted';
    return this.status;
  }

  /** Re-enable the microphone after a mute. */
  unmute(): AudioRecorderStatus {
    if (this.status !== 'muted') return this.status;
    this.setTracksEnabled(true);
    this.status = 'recording';
    return this.status;
  }

  private setTracksEnabled(enabled: boolean): void {
    this.stream?.getTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => {
          this.flush().finally(() => resolve());
        };
        recorder.stop();
      });
    } else {
      await this.flush();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    if (this.status === 'recording' || this.status === 'muted') {
      this.status = 'stopped';
    }
  }

  private async flush(): Promise<void> {
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, {
      type: this.recorder?.mimeType || 'audio/webm',
    });
    this.chunks = [];
    await this.deps.upload(blob);
  }
}
