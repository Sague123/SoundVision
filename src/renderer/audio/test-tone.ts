/**
 * Тестовый источник: бочка и хэты на 120 ударов в минуту.
 *
 * Нужен только чтобы гонять цепочку «поток → воркер → панель» там, где нет
 * настоящего звука (сборочная машина, контейнер). Это НЕ музыка: по ней нельзя
 * оценивать картинку или реакцию на удары — на таком сигнале всё работает
 * идеально и ни о чём не говорит. Источник всегда подписан как тестовый.
 */

const BPM = 120;
const LOOKAHEAD_S = 0.4;

export function createTestToneStream(): { stream: MediaStream; stop: () => void } {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const master = context.createGain();
  master.gain.value = 0.7;
  master.connect(destination);

  const beat = 60 / BPM;
  let next = context.currentTime + 0.05;
  let step = 0;

  const kick = (when: number): void => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    gain.gain.setValueAtTime(1, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
    osc.connect(gain).connect(master);
    osc.start(when);
    osc.stop(when + 0.32);
  };

  const hat = (when: number): void => {
    const length = Math.floor(context.sampleRate * 0.05);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const gain = context.createGain();
    gain.gain.value = 0.25;
    source.connect(filter).connect(gain).connect(master);
    source.start(when);
  };

  const timer = window.setInterval(() => {
    while (next < context.currentTime + LOOKAHEAD_S) {
      if (step % 2 === 0) kick(next);
      else hat(next);
      next += beat / 2;
      step++;
    }
  }, 50);

  return {
    stream: destination.stream,
    stop: () => {
      window.clearInterval(timer);
      void context.close();
    },
  };
}
