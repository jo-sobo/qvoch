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
let audioContext: AudioContext | null = null;
let localAnalyser: AnalyserNode | null = null;

let localAudioReadyResolve: (() => void) | null = null;
let localAudioPromise: Promise<void> | null = null;

export function resetLocalAudioPromise(): void {
  localAudioPromise = new Promise<void>((resolve) => {
    localAudioReadyResolve = resolve;
  });
}

function resolveLocalAudioPromise(): void {
  if (localAudioReadyResolve) {
    localAudioReadyResolve();
    localAudioReadyResolve = null;
  }
}

const remoteStreams = new Map<
  string,
  {
    audio: HTMLAudioElement;
    analyser: AnalyserNode | null;
    gainNode: GainNode | null;
    sourceNode: MediaStreamAudioSourceNode | null;
  }
>();

type VolumeCallback = (volumes: Map<string, number>) => void;
let volumeCallback: VolumeCallback | null = null;
let volumeAnimFrame: number | null = null;

type LocalVolumeCallback = (volume: number) => void;
let localVolumeCallback: LocalVolumeCallback | null = null;

export function setVolumeCallback(cb: VolumeCallback | null): void {
  volumeCallback = cb;
}

export function setLocalVolumeCallback(cb: LocalVolumeCallback | null): void {
  localVolumeCallback = cb;
  // Start monitoring loop if not already running (needed when alone in room)
  if (cb && !volumeAnimFrame) {
    startVolumeMonitoring();
  }
}

export async function initLocalAudio(deviceId?: string | null): Promise<MediaStream> {
  if (localStream && !deviceId) {
    resolveLocalAudioPromise();
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

  const newStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (localStream && deviceId) {
    for (const track of localStream.getAudioTracks()) {
      track.stop();
    }
  }

  localStream = newStream;

  ensureAudioContext();
  if (audioContext) {
    try {
      const source = audioContext.createMediaStreamSource(newStream);
      localAnalyser = audioContext.createAnalyser();
      localAnalyser.fftSize = 256;
      source.connect(localAnalyser);
    } catch {
    }
  }

  resolveLocalAudioPromise();

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

export function ensureAudioContext(): void {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}

export async function handleOffer(sdp: string): Promise<void> {
  if (localAudioPromise) {
    await localAudioPromise;
  }

  createPeerConnection();
  if (!pc) return;

  const offer = new RTCSessionDescription({ type: 'offer', sdp });

  try {
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (pc.localDescription) {
      send('answer', { sdp: pc.localDescription.sdp });
    }
  } catch (err) {
    console.error('Failed to handle offer:', err);
  }
}

export function handleCandidate(candidate: string, sdpMid: string, sdpMLineIndex: number | null): void {
  if (!pc) return;

  const ice: RTCIceCandidateInit = {
    candidate,
    sdpMid: sdpMid || undefined,
    sdpMLineIndex: sdpMLineIndex ?? undefined,
  };

  pc.addIceCandidate(new RTCIceCandidate(ice)).catch((err) =>
    console.error('Failed to add ICE candidate:', err)
  );
}

function createPeerConnection(): void {
  if (pc) {
    pc.close();
    pc = null;
  }

  for (const [, entry] of remoteStreams) {
    entry.audio.pause();
    entry.audio.srcObject = null;
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
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    const streamId = stream.id;

    if (remoteStreams.has(streamId)) return;

    ensureAudioContext();

    let analyser: AnalyserNode | null = null;
    let gainNode: GainNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    const audio = new Audio();

    if (audioContext) {
      try {
        sourceNode = audioContext.createMediaStreamSource(stream);
        gainNode = audioContext.createGain();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const userId = extractUserIdFromStreamId(streamId);
        const userVolumes = useStore.getState().userVolumes;
        gainNode.gain.value = userId && userVolumes[userId] != null
          ? userVolumes[userId] / 100
          : 1.0;

        sourceNode.connect(gainNode);
        gainNode.connect(analyser);
        gainNode.connect(audioContext.destination);
      } catch {
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.play().catch(() => {});
      }
    } else {
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.play().catch(() => {});
    }

    remoteStreams.set(streamId, { audio, analyser, gainNode, sourceNode });

    if (!volumeAnimFrame) {
      startVolumeMonitoring();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('RTC connection state:', pc?.connectionState);
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
    if (volumeCallback && remoteStreams.size > 0) {
      const volumes = new Map<string, number>();
      for (const [streamId, { analyser }] of remoteStreams) {
        if (!analyser) continue;
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((sum, val) => sum + val, 0) / data.length;
        volumes.set(streamId, avg);
      }
      volumeCallback(volumes);
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
  if (localStream) {
    for (const track of localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }
}

export function setOutputMuted(muted: boolean): void {
  for (const [, entry] of remoteStreams) {
    if (entry.gainNode) {
      if (muted) {
        entry.gainNode.gain.value = 0;
      } else {
        const streamId = [...remoteStreams.entries()].find(([, v]) => v === entry)?.[0];
        const userId = streamId ? extractUserIdFromStreamId(streamId) : null;
        const userVolumes = useStore.getState().userVolumes;
        entry.gainNode.gain.value = userId && userVolumes[userId] != null
          ? userVolumes[userId] / 100
          : 1.0;
      }
    }
    entry.audio.muted = muted;
  }
}

export function setOutputDevice(deviceId: string): void {
  for (const [, { audio }] of remoteStreams) {
    if ('setSinkId' in audio) {
      (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
        .setSinkId(deviceId)
        .catch((err) => console.error('Failed to set output device:', err));
    }
  }
}

export function setUserVolume(userId: string, volume: number): void {
  const gain = volume / 100;
  const streamId = `stream-${userId}`;
  const entry = remoteStreams.get(streamId);
  if (entry?.gainNode) {
    entry.gainNode.gain.value = gain;
  }
}

export function getLocalVolume(): number {
  if (!localAnalyser) return 0;
  const data = new Uint8Array(localAnalyser.frequencyBinCount);
  localAnalyser.getByteFrequencyData(data);
  return data.reduce((sum, val) => sum + val, 0) / data.length;
}

export function closeWebRTC(): void {
  if (volumeAnimFrame) {
    cancelAnimationFrame(volumeAnimFrame);
    volumeAnimFrame = null;
  }

  for (const [, entry] of remoteStreams) {
    entry.audio.pause();
    entry.audio.srcObject = null;
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

  localAnalyser = null;

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  localAudioPromise = null;
  localAudioReadyResolve = null;
}
