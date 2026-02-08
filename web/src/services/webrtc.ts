import { send } from './socket';
import { useStore } from '../stores/useStore';

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let captureStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let localAnalyser: AnalyserNode | null = null;
let localManualMuted = false;
let localVoiceGateOpen = true;

const MAX_USER_VOLUME_MULTIPLIER = 2;

type PendingCandidate = {
  ice: RTCIceCandidateInit;
  seq: number;
  epoch: number;
};

let pendingCandidates: PendingCandidate[] = [];
let offerQueue: Promise<void> = Promise.resolve();
let lastProcessedSeq = 0;
let activeOfferSeq = 0;
let currentEpoch = 0;

// No-ops: mic is now requested before create/join, so handleOffer no longer
// needs to wait for local audio. Kept as exports for API compatibility.
export function resetLocalAudioPromise(): void {}

type RemoteStreamEntry = {
  audio: HTMLAudioElement;
  analyser: AnalyserNode | null;
  gainNode: GainNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  outputNode: MediaStreamAudioDestinationNode | null;
  userGain: number;
};

const remoteStreams = new Map<string, RemoteStreamEntry>();

type VolumeCallback = (volumes: Map<string, number>) => void;
const volumeCallbacks = new Set<VolumeCallback>();
let volumeAnimFrame: number | null = null;

type LocalVolumeCallback = (volume: number) => void;
let localVolumeCallback: LocalVolumeCallback | null = null;

type VoiceTransmissionCallback = (active: boolean) => void;
const voiceTransmissionCallbacks = new Set<VoiceTransmissionCallback>();
let localTransmissionActive = false;

export function setVolumeCallback(cb: VolumeCallback | null): void {
  volumeCallbacks.clear();
  if (cb) {
    volumeCallbacks.add(cb);
    if (!volumeAnimFrame) {
      startVolumeMonitoring();
    }
  }
}

export function subscribeVolumeCallback(cb: VolumeCallback): () => void {
  volumeCallbacks.add(cb);
  if (!volumeAnimFrame) {
    startVolumeMonitoring();
  }
  return () => {
    volumeCallbacks.delete(cb);
  };
}

export function setLocalVolumeCallback(cb: LocalVolumeCallback | null): void {
  localVolumeCallback = cb;
  if (cb && !volumeAnimFrame) {
    startVolumeMonitoring();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function volumePercentToGain(volume: number): number {
  return clamp(volume / 100, 0, MAX_USER_VOLUME_MULTIPLIER);
}

function applyLocalTrackState(): void {
  if (!localStream) {
    setLocalTransmissionState(false);
    return;
  }
  const enabled = !localManualMuted && localVoiceGateOpen;
  for (const track of localStream.getAudioTracks()) {
    track.enabled = enabled;
  }
  setLocalTransmissionState(enabled && localStream.getAudioTracks().length > 0);
}

function setLocalTransmissionState(active: boolean): void {
  if (localTransmissionActive === active) return;
  localTransmissionActive = active;
  for (const cb of voiceTransmissionCallbacks) {
    cb(active);
  }
}

function applyAudioOutputDevice(audio: HTMLAudioElement, deviceId: string | null): void {
  if (deviceId == null || !('setSinkId' in audio)) return;
  (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
    .setSinkId(deviceId)
    .catch((err) => console.error('Failed to set output device:', err));
}

function setEntryGain(entry: RemoteStreamEntry, gain: number): void {
  entry.userGain = clamp(gain, 0, MAX_USER_VOLUME_MULTIPLIER);
  if (entry.gainNode) {
    entry.gainNode.gain.value = entry.userGain;
    entry.audio.volume = 1;
    return;
  }
  entry.audio.volume = clamp(entry.userGain, 0, 1);
}

function buildRemoteAudioGraph(entry: RemoteStreamEntry, stream: MediaStream): void {
  entry.sourceNode?.disconnect();
  entry.gainNode?.disconnect();
  entry.outputNode?.disconnect();
  entry.sourceNode = null;
  entry.gainNode = null;
  entry.outputNode = null;
  entry.analyser = null;
  entry.audio.srcObject = stream;

  if (!audioContext) return;

  try {
    const sourceNode = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const gainNode = audioContext.createGain();
    const outputNode = audioContext.createMediaStreamDestination();

    sourceNode.connect(analyser);
    sourceNode.connect(gainNode);
    gainNode.connect(outputNode);

    entry.sourceNode = sourceNode;
    entry.analyser = analyser;
    entry.gainNode = gainNode;
    entry.outputNode = outputNode;
    entry.audio.srcObject = outputNode.stream;
  } catch {
    // no-op; fallback is direct audio element playback
  }
}

function configureRemoteEntry(entry: RemoteStreamEntry, streamId: string, stream: MediaStream): void {
  ensureAudioContext();
  buildRemoteAudioGraph(entry, stream);

  const userId = extractUserIdFromStreamId(streamId);
  const { userVolumes, outputMuted, audioOutputDeviceId } = useStore.getState();
  const volumePct = userId && userVolumes[userId] != null ? userVolumes[userId] : 100;
  setEntryGain(entry, volumePercentToGain(volumePct));
  entry.audio.muted = outputMuted;
  applyAudioOutputDevice(entry.audio, audioOutputDeviceId);
  entry.audio.play().catch(() => {});
}

export async function initLocalAudio(deviceId?: string | null): Promise<MediaStream> {
  if (localStream && !deviceId) {
    return localStream;
  }

  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };

  const newCaptureStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (captureStream && deviceId) {
    for (const track of captureStream.getAudioTracks()) {
      track.stop();
    }
  }
  if (localStream && deviceId) {
    for (const track of localStream.getAudioTracks()) {
      track.stop();
    }
  }

  captureStream = newCaptureStream;
  const captureTrack = newCaptureStream.getAudioTracks()[0];
  localStream = captureTrack ? new MediaStream([captureTrack.clone()]) : new MediaStream();

  localManualMuted = useStore.getState().muted;
  applyLocalTrackState();

  ensureAudioContext();
  if (audioContext) {
    try {
      const source = audioContext.createMediaStreamSource(newCaptureStream);
      localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 256;
      source.connect(localAnalyser);
    } catch {
      // no-op
    }
  }

  return localStream;
}

export async function switchAudioInput(deviceId: string): Promise<void> {
  const newStream = await initLocalAudio(deviceId);
  const newTrack = newStream.getAudioTracks()[0];
  if (!newTrack || !pc) return;

  for (const sender of pc.getSenders()) {
    if (sender.track?.kind === 'audio') {
      await sender.replaceTrack(newTrack);
    }
  }
}

export function isLocalAudioReady(): boolean {
  return localStream !== null;
}

export function ensureAudioContext(): void {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  for (const [, entry] of remoteStreams) {
    if (entry.audio.paused && entry.audio.srcObject) {
      entry.audio.play().catch(() => {});
    }
  }
}

export function handleOffer(sdp: string, reset: boolean | undefined, seq: number, epoch: number): void {
  offerQueue = offerQueue
    .then(async () => {
      if (reset) {
        if (epoch < currentEpoch) {
          console.warn(`Dropping stale reset offer epoch=${epoch}, current=${currentEpoch}`);
          return;
        }
        currentEpoch = epoch;
        lastProcessedSeq = 0;
      } else {
        if (epoch !== currentEpoch) {
          console.warn(`Dropping offer: epoch mismatch ${epoch} vs current ${currentEpoch}`);
          return;
        }
      }

      if (seq <= lastProcessedSeq) {
        console.warn(`Dropping stale offer seq=${seq}, last=${lastProcessedSeq}`);
        return;
      }

      await processOffer(sdp, !!reset, seq);
      lastProcessedSeq = seq;
    })
    .catch((err) => {
      console.error('Offer processing error:', err);
    });
}

async function processOffer(sdp: string, reset: boolean, seq: number): Promise<void> {
  const canReuse = !reset
    && pc !== null
    && pc.connectionState !== 'failed'
    && pc.connectionState !== 'closed';

  if (!canReuse) {
    createPeerConnection();
  }

  const currentPc = pc;
  if (!currentPc) return;

  activeOfferSeq = seq;
  const offer = new RTCSessionDescription({ type: 'offer', sdp });

  try {
    await currentPc.setRemoteDescription(offer);

    const pendingForCurrent = pendingCandidates.filter((item) => item.epoch === currentEpoch);
    pendingCandidates = pendingCandidates.filter((item) => item.epoch !== currentEpoch);

    for (const item of pendingForCurrent) {
      currentPc.addIceCandidate(new RTCIceCandidate(item.ice)).catch((err) =>
        console.error('Failed to add buffered ICE candidate:', err)
      );
    }

    const answer = await currentPc.createAnswer();
    await currentPc.setLocalDescription(answer);

    if (currentPc.localDescription) {
      send('answer', { sdp: currentPc.localDescription.sdp, seq, epoch: currentEpoch });
    }
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

export function handleCandidate(
  candidate: string,
  sdpMid: string,
  sdpMLineIndex: number | null,
  seq: number,
  epoch: number,
): void {
  if (epoch !== currentEpoch) {
    return;
  }

  const ice: RTCIceCandidateInit = {
    candidate,
    sdpMid: sdpMid || undefined,
    sdpMLineIndex: sdpMLineIndex ?? undefined,
  };

  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push({ ice, seq, epoch });
    return;
  }

  pc.addIceCandidate(new RTCIceCandidate(ice)).catch((err) =>
    console.error('Failed to add ICE candidate:', err)
  );
}

function createPeerConnection(): void {
  if (typeof RTCPeerConnection === 'undefined') {
    console.error('WebRTC is not available in this browser. Check that WebRTC is enabled (Firefox: about:config → media.peerconnection.enabled) and no extensions are blocking it.');
    useStore.getState().setWebrtcUnavailable(true);
    return;
  }

  pendingCandidates = [];
  lastProcessedSeq = 0;
  activeOfferSeq = 0;

  if (pc) {
    pc.close();
    pc = null;
  }

  for (const [, entry] of remoteStreams) {
    entry.audio.pause();
    entry.audio.srcObject = null;
    entry.sourceNode?.disconnect();
    entry.gainNode?.disconnect();
    entry.outputNode?.disconnect();
  }
  remoteStreams.clear();

  pc = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      pc.addTrack(track, localStream);
    }
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send('candidate', {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid || '0',
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
        seq: activeOfferSeq,
        epoch: currentEpoch,
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const streamId = stream.id;

    if (remoteStreams.has(streamId)) {
      const existing = remoteStreams.get(streamId)!;
      configureRemoteEntry(existing, streamId, stream);

      attachTrackLifecycle(event.track, streamId);
      return;
    }

    const audio = new Audio();
    audio.autoplay = true;
    const entry: RemoteStreamEntry = {
      audio,
      analyser: null,
      gainNode: null,
      sourceNode: null,
      outputNode: null,
      userGain: 1,
    };

    configureRemoteEntry(entry, streamId, stream);
    remoteStreams.set(streamId, entry);
    attachTrackLifecycle(event.track, streamId);

    if (!volumeAnimFrame) {
      startVolumeMonitoring();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('RTC connection state:', pc?.connectionState);
  };
}

function attachTrackLifecycle(track: MediaStreamTrack, streamId: string): void {
  track.onended = () => {
    const entry = remoteStreams.get(streamId);
    if (entry) {
      entry.audio.pause();
      entry.audio.srcObject = null;
      entry.sourceNode?.disconnect();
      entry.gainNode?.disconnect();
      entry.outputNode?.disconnect();
      remoteStreams.delete(streamId);
    }
  };
}

function extractUserIdFromStreamId(streamId: string): string | null {
  if (streamId.startsWith('stream-')) {
    return streamId.substring(7);
  }
  return null;
}

function startVolumeMonitoring(): void {
  const check = () => {
    if (volumeCallbacks.size > 0 && remoteStreams.size > 0) {
      const volumes = new Map<string, number>();
      for (const [streamId, { analyser }] of remoteStreams) {
        if (!analyser) continue;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((sum, val) => sum + val, 0) / data.length;
        volumes.set(streamId, avg);
      }
      for (const cb of volumeCallbacks) {
        cb(volumes);
      }
    }

    if (localVolumeCallback && localAnalyser) {
      const data = new Uint8Array(localAnalyser.frequencyBinCount);
      localAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((sum, val) => sum + val, 0) / data.length;
      localVolumeCallback(avg);
    }

    volumeAnimFrame = requestAnimationFrame(check);
  };
  volumeAnimFrame = requestAnimationFrame(check);
}

export function setMuted(muted: boolean): void {
  localManualMuted = muted;
  applyLocalTrackState();
}

export function setVoiceTransmissionActive(active: boolean): void {
  localVoiceGateOpen = active;
  applyLocalTrackState();
}

export function setOutputMuted(muted: boolean): void {
  for (const [, entry] of remoteStreams) {
    entry.audio.muted = muted;
  }
}

export function setOutputDevice(deviceId: string): void {
  for (const [, { audio }] of remoteStreams) {
    applyAudioOutputDevice(audio, deviceId);
  }
}

export function setUserVolume(userId: string, volume: number): void {
  const streamId = `stream-${userId}`;
  const entry = remoteStreams.get(streamId);
  if (entry) {
    setEntryGain(entry, volumePercentToGain(volume));
  }
}

export function getLocalVolume(): number {
  if (!localAnalyser) return 0;
  const data = new Uint8Array(localAnalyser.frequencyBinCount);
  localAnalyser.getByteFrequencyData(data);
  return data.reduce((sum, val) => sum + val, 0) / data.length;
}

export function getVoiceTransmissionActive(): boolean {
  return localTransmissionActive;
}

export function subscribeVoiceTransmissionCallback(cb: VoiceTransmissionCallback): () => void {
  voiceTransmissionCallbacks.add(cb);
  cb(localTransmissionActive);
  return () => {
    voiceTransmissionCallbacks.delete(cb);
  };
}

export function closeWebRTC(): void {
  if (volumeAnimFrame) {
    cancelAnimationFrame(volumeAnimFrame);
    volumeAnimFrame = null;
  }

  for (const [, entry] of remoteStreams) {
    entry.audio.pause();
    entry.audio.srcObject = null;
    entry.sourceNode?.disconnect();
    entry.gainNode?.disconnect();
    entry.outputNode?.disconnect();
  }
  remoteStreams.clear();

  if (pc) {
    pc.close();
    pc = null;
  }

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
    localStream = null;
  }
  if (captureStream) {
    for (const track of captureStream.getTracks()) {
      track.stop();
    }
    captureStream = null;
  }

  localAnalyser = null;
  localManualMuted = false;
  localVoiceGateOpen = true;
  setLocalTransmissionState(false);

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  pendingCandidates = [];
  offerQueue = Promise.resolve();
  lastProcessedSeq = 0;
  activeOfferSeq = 0;
  currentEpoch = 0;
}
