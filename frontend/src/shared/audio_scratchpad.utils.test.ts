import {
  AudioScratchpadRecorder,
  buildAudioScratchpadPath,
  MinimalRecorder,
} from './audio_scratchpad.utils';

describe('buildAudioScratchpadPath', () => {
  it('builds a per-participant, per-stage path', () => {
    expect(
      buildAudioScratchpadPath({
        experimentId: 'exp1',
        participantId: 'pid1',
        stageId: 'stage1',
        timestamp: 123,
      }),
    ).toBe('participant_audio/exp1/pid1/stage1_123.webm');
  });

  it('uses the file extension matching the recorded mimeType', () => {
    expect(
      buildAudioScratchpadPath({
        experimentId: 'exp1',
        participantId: 'pid1',
        stageId: 'stage1',
        timestamp: 123,
        mimeType: 'audio/mp4;codecs=mp4a.40.2',
      }),
    ).toBe('participant_audio/exp1/pid1/stage1_123.mp4');
  });

  it('falls back to placeholders when ids are missing', () => {
    expect(
      buildAudioScratchpadPath({
        experimentId: null,
        participantId: undefined,
        stageId: '',
        timestamp: 5,
      }),
    ).toBe(
      'participant_audio/unknown-experiment/unknown-participant/unknown-stage_5.webm',
    );
  });
});

/** A controllable fake MediaRecorder. */
function makeFakeRecorder(): MinimalRecorder & {emitData(blob: Blob): void} {
  return {
    state: 'inactive',
    mimeType: 'audio/webm',
    ondataavailable: null,
    onstop: null,
    start() {
      this.state = 'recording';
    },
    stop() {
      this.state = 'inactive';
      if (this.onstop) this.onstop();
    },
    emitData(blob: Blob) {
      if (this.ondataavailable) this.ondataavailable({data: blob});
    },
  };
}

describe('AudioScratchpadRecorder', () => {
  it('reports unsupported when media APIs are missing', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const rec = new AudioScratchpadRecorder({upload});
    expect(await rec.start()).toBe('unsupported');
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports denied when getUserMedia rejects', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const rec = new AudioScratchpadRecorder({
      getUserMedia: () => Promise.reject(new Error('denied')),
      createRecorder: () => makeFakeRecorder(),
      upload,
    });
    expect(await rec.start()).toBe('denied');
  });

  it('records and uploads the captured audio on stop', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const track = {stop: jest.fn()};
    const fakeRecorder = makeFakeRecorder();
    const rec = new AudioScratchpadRecorder({
      getUserMedia: () => Promise.resolve({getTracks: () => [track]}),
      createRecorder: () => fakeRecorder,
      upload,
    });

    expect(await rec.start()).toBe('recording');
    fakeRecorder.emitData(new Blob(['audio-data'], {type: 'audio/webm'}));
    await rec.stop();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(track.stop).toHaveBeenCalled();
    expect(rec.status).toBe('stopped');
  });

  it('does not upload when no audio was captured', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const rec = new AudioScratchpadRecorder({
      getUserMedia: () => Promise.resolve({getTracks: () => []}),
      createRecorder: () => makeFakeRecorder(),
      upload,
    });
    await rec.start();
    await rec.stop();
    expect(upload).not.toHaveBeenCalled();
  });

  it('mutes and unmutes by toggling track.enabled', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const track = {stop: jest.fn(), enabled: true};
    const rec = new AudioScratchpadRecorder({
      getUserMedia: () => Promise.resolve({getTracks: () => [track]}),
      createRecorder: () => makeFakeRecorder(),
      upload,
    });

    expect(await rec.start()).toBe('recording');
    expect(rec.mute()).toBe('muted');
    expect(track.enabled).toBe(false);
    expect(rec.unmute()).toBe('recording');
    expect(track.enabled).toBe(true);
  });

  it('mute/unmute are no-ops when not recording', () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const rec = new AudioScratchpadRecorder({upload});
    expect(rec.mute()).toBe('idle');
    expect(rec.unmute()).toBe('idle');
  });

  it('still uploads the recording after muting, on stop', async () => {
    const upload = jest.fn().mockResolvedValue(undefined);
    const track = {stop: jest.fn(), enabled: true};
    const fakeRecorder = makeFakeRecorder();
    const rec = new AudioScratchpadRecorder({
      getUserMedia: () => Promise.resolve({getTracks: () => [track]}),
      createRecorder: () => fakeRecorder,
      upload,
    });

    await rec.start();
    fakeRecorder.emitData(new Blob(['audio-data'], {type: 'audio/webm'}));
    rec.mute();
    await rec.stop();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(rec.status).toBe('stopped');
  });
});
