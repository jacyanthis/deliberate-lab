import '../../pair-components/button';

import {MobxLitElement} from '@adobe/lit-mobx';
import {CSSResultGroup, html, nothing, TemplateResult} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import {ref as storageRef, uploadBytes} from 'firebase/storage';

import {core} from '../../core/core';
import {FirebaseService} from '../../services/firebase.service';
import {ParticipantService} from '../../services/participant.service';
import {
  AudioRecorderStatus,
  AudioScratchpadRecorder,
  MinimalMediaStream,
  MinimalRecorder,
  buildAudioScratchpadPath,
} from '../../shared/audio_scratchpad.utils';
import {styles} from './audio_scratchpad.scss';

/**
 * When true, the participant's microphone is held open for the whole group
 * chat (in addition to any scratchpad or quiz), with a visible notification.
 * Toggle; not surfaced in the experiment-builder UI.
 */
export const SCRATCHPAD_AS_AUDIO = true;

/**
 * Holds the participant's microphone open for the duration of a group chat and
 * uploads the recording when the stage unmounts.
 *
 * The microphone does not turn on until the participant explicitly
 * acknowledges it (a consent gate shown before the mic activates). Once on, a
 * mic button lets them mute; muting pauses the discussion behind an overlay
 * (no new messages appear) until they unmute, mirroring the quiz pause.
 */
@customElement('audio-scratchpad')
export class AudioScratchpad extends MobxLitElement {
  static override styles: CSSResultGroup = [styles];

  private readonly firebaseService = core.getService(FirebaseService);
  private readonly participantService = core.getService(ParticipantService);

  @property() stageId = '';
  @state() private status: AudioRecorderStatus = 'idle';

  private recorder: AudioScratchpadRecorder | null = null;

  override connectedCallback() {
    super.connectedCallback();
    const mediaDevices = navigator.mediaDevices;
    const supported =
      !!mediaDevices &&
      typeof mediaDevices.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined';
    this.recorder = new AudioScratchpadRecorder({
      getUserMedia: supported
        ? (constraints) =>
            mediaDevices.getUserMedia(
              constraints as MediaStreamConstraints,
            ) as unknown as Promise<MinimalMediaStream>
        : undefined,
      createRecorder: supported
        ? (stream) =>
            new MediaRecorder(
              stream as unknown as MediaStream,
            ) as unknown as MinimalRecorder
        : undefined,
      upload: (blob) => this.uploadBlob(blob),
    });
    // The mic stays OFF until the participant acknowledges it below. Surface an
    // unsupported browser immediately instead of showing the consent gate.
    this.status = supported ? 'idle' : 'unsupported';
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    void this.recorder?.stop();
    this.recorder = null;
  }

  /** Consent gate: turn the mic on only after the participant acknowledges. */
  private async acknowledge() {
    if (!this.recorder) return;
    this.status = await this.recorder.start();
  }

  private mute() {
    if (!this.recorder) return;
    this.status = this.recorder.mute();
  }

  private unmute() {
    if (!this.recorder) return;
    this.status = this.recorder.unmute();
  }

  private async uploadBlob(blob: Blob): Promise<void> {
    const path = buildAudioScratchpadPath({
      experimentId: this.participantService.experimentId,
      participantId: this.participantService.profile?.publicId,
      stageId: this.stageId,
      timestamp: Date.now(),
      mimeType: blob.type,
    });
    try {
      await uploadBytes(storageRef(this.firebaseService.storage, path), blob);
    } catch (error) {
      // Best-effort: a failed upload (e.g. storage rules / offline) must not
      // disrupt the chat.
      console.warn('Audio scratchpad upload failed', error);
    }
  }

  private renderOverlay(opts: {
    icon: string;
    title: string;
    body: string;
    action: string;
    onAction: () => void;
    paused?: boolean;
  }): TemplateResult {
    return html`
      <div class="audio-overlay">
        <div class="audio-card">
          ${opts.paused
            ? html`<div class="audio-paused">The discussion is paused.</div>`
            : nothing}
          <div class="audio-icon">${opts.icon}</div>
          <div class="audio-title">${opts.title}</div>
          <div class="audio-body">${opts.body}</div>
          <pr-button variant="tonal" @click=${opts.onAction}>
            ${opts.action}
          </pr-button>
        </div>
      </div>
    `;
  }

  override render() {
    switch (this.status) {
      case 'unsupported':
        return html`<div class="audio-banner unsupported">
          Audio recording is not supported in this browser.
        </div>`;
      case 'stopped':
        return nothing;
      case 'idle':
        // Consent gate, shown before the mic turns on.
        return this.renderOverlay({
          icon: '🎤',
          title: 'This discussion uses your microphone',
          body: 'Your microphone will turn on and record for the whole discussion once you continue. Please make sure you are ready to be recorded.',
          action: 'Turn on microphone & continue',
          onAction: () => this.acknowledge(),
        });
      case 'denied':
        // 'denied' covers any getUserMedia failure (an explicit block, a
        // pre-existing site block, or a device error), so show a generic
        // allow-and-retry prompt rather than assuming a transient failure.
        return this.renderOverlay({
          icon: '🎤',
          title: 'Microphone access is blocked',
          body: "Your browser is blocking access to your microphone. To turn it on, click the camera (or lock) icon in your browser's address bar, allow microphone access for this site, then try again.",
          action: 'Try again',
          onAction: () => this.acknowledge(),
        });
      case 'muted':
        // Muting pauses the discussion behind this overlay until they unmute.
        return this.renderOverlay({
          icon: '🔇',
          title: 'Your microphone is muted',
          body: 'The discussion is paused while your microphone is muted. Unmute to continue and see new messages.',
          action: 'Unmute microphone',
          onAction: () => this.unmute(),
          paused: true,
        });
      case 'recording':
      default:
        return html`
          <div class="audio-banner recording">
            <span class="audio-banner-text">
              🎤 Your microphone is on and recording for this discussion.
            </span>
            <pr-button
              size="small"
              color="neutral"
              variant="tonal"
              @click=${() => this.mute()}
            >
              🔇 Mute
            </pr-button>
          </div>
        `;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'audio-scratchpad': AudioScratchpad;
  }
}
