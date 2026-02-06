import { useStore } from '../stores/useStore';

function playSound(url: string): void {
  const store = useStore.getState();
  if (store.outputMuted) return;

  const audio = new Audio(url);
  audio.volume = 0.5;

  // Set output device if configured
  const outputDeviceId = store.audioOutputDeviceId;
  if (outputDeviceId && 'setSinkId' in audio) {
    (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
      .setSinkId(outputDeviceId)
      .catch(() => {});
  }

  audio.play().catch(() => {});
}

export function playJoinSound(): void {
  playSound('/sounds/join.wav');
}

export function playLeaveSound(): void {
  playSound('/sounds/leave.wav');
}

export function playMentionSound(): void {
  playSound('/sounds/mention.wav');
}
