import { describe, expect, it } from 'vitest';
import { pickVirtualDevice } from '../src/renderer/audio/devices';

const dev = (label: string, kind = 'audioinput', deviceId = label) => ({ deviceId, label, kind });

describe('pickVirtualDevice', () => {
  it('находит BlackHole и не трогает микрофон', () => {
    const list = [dev('MacBook Pro Microphone'), dev('BlackHole 2ch'), dev('Default', 'audioinput', 'default')];
    expect(pickVirtualDevice(list)?.label).toBe('BlackHole 2ch');
  });
  it('на Windows — Стерео микшер и VB-Cable', () => {
    expect(pickVirtualDevice([dev('Микрофон (Realtek)'), dev('Стерео микшер (Realtek)')])?.label).toMatch(/микшер/i);
    expect(pickVirtualDevice([dev('CABLE Output (VB-Audio Virtual Cable)')])).not.toBeNull();
  });
  it('предпочитает меньше каналов — их проще слушать', () => {
    expect(pickVirtualDevice([dev('BlackHole 16ch'), dev('BlackHole 2ch')])?.label).toBe('BlackHole 2ch');
  });
  it('только микрофоны — ничего', () => {
    expect(pickVirtualDevice([dev('Микрофон'), dev('Webcam mic')])).toBeNull();
    expect(pickVirtualDevice([dev('BlackHole 2ch', 'audiooutput')])).toBeNull();
  });
});
