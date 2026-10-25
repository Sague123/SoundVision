/**
 * Виртуальные аудио-устройства: то, через что система отдаёт «звук, который
 * играет», как обычный вход. BlackHole, Soundflower, Loopback на macOS;
 * VB-Cable и «Стерео микшер» на Windows.
 *
 * Микрофон сюда не попадает намеренно: шоу должно слушать системный вывод,
 * а не комнату.
 */

export interface DeviceLike {
  deviceId: string;
  label: string;
  kind: string;
}

const VIRTUAL = /blackhole|soundflower|loopback audio|vb-?cable|cable output|vb-audio|stereo mix|стерео ?микшер|what u hear|wave out mix|monitor of/i;

export function isVirtualLoopback(label: string): boolean {
  return VIRTUAL.test(label);
}

/** Первое подходящее устройство; BlackHole с большим числом каналов — позже простого. */
export function pickVirtualDevice<T extends DeviceLike>(devices: readonly T[]): T | null {
  const candidates = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && isVirtualLoopback(d.label));
  if (candidates.length === 0) return null;
  const rank = (label: string): number => {
    const channels = /(\d+)ch/i.exec(label);
    return channels ? Number(channels[1]) : 0;
  };
  return [...candidates].sort((a, b) => rank(a.label) - rank(b.label))[0];
}
