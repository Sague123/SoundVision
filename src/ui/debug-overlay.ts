/**
 * Дебаг-оверлей: сырые числа и скользящие графики фич.
 * Нужен на этапе подбора порогов — без него калибровать onset и section вслепую.
 */

import type { MoodVector } from '../audio/mood-vector.ts';
import type { CompositorStats } from '../render/compositor.ts';
import { IMPULSE_KIND_LABELS, SUBSTANCE_LABELS } from '../render/scene.ts';

const HISTORY = 240;
const GRAPH_HEIGHT = 34;

interface Trace {
  key: 'energy' | 'flux' | 'brightness' | 'noisiness';
  label: string;
  color: string;
  values: Float32Array;
}

export class DebugOverlay {
  readonly element = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly readout = document.createElement('pre');
  private readonly onsets = new Uint8Array(HISTORY);
  private writeIndex = 0;

  private readonly traces: Trace[] = [
    { key: 'energy', label: 'energy', color: '#6ee7ff', values: new Float32Array(HISTORY) },
    { key: 'flux', label: 'flux', color: '#ff7ad9', values: new Float32Array(HISTORY) },
    { key: 'brightness', label: 'bright', color: '#ffd166', values: new Float32Array(HISTORY) },
    { key: 'noisiness', label: 'noise', color: '#9dff8f', values: new Float32Array(HISTORY) },
  ];

  constructor() {
    this.element.className = 'debug debug--hidden';
    this.canvas.width = HISTORY;
    this.canvas.height = GRAPH_HEIGHT * this.traces.length;
    this.canvas.className = 'debug__canvas';
    this.readout.className = 'debug__readout';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D-контекст недоступен');
    this.ctx = ctx;
    this.element.append(this.canvas, this.readout);
  }

  setVisible(visible: boolean): void {
    this.element.classList.toggle('debug--hidden', !visible);
  }

  update(mood: MoodVector, stats: CompositorStats): void {
    if (this.element.classList.contains('debug--hidden')) return;

    for (const trace of this.traces) trace.values[this.writeIndex] = mood[trace.key];
    this.onsets[this.writeIndex] = mood.onset ? 1 : 0;
    this.writeIndex = (this.writeIndex + 1) % HISTORY;

    this.drawGraphs();
    // Самый свежий импульс: по нему видно, как классифицировался удар.
    const lastImpulse = stats.scene.impulses[stats.scene.impulses.length - 1] ?? null;
    this.readout.textContent = [
      `fps      ${stats.fps.toFixed(1)}   кадр ${stats.frameMs.toFixed(1)} мс   quality ${(stats.effectiveQuality * 100).toFixed(0)}%`,
      `energy   ${bar(mood.energy)} ${mood.energy.toFixed(3)}`,
      `flux     ${bar(mood.flux)} ${mood.flux.toFixed(3)}`,
      `bright   ${bar(mood.brightness)} ${mood.brightness.toFixed(3)}`,
      `noise    ${bar(mood.noisiness)} ${mood.noisiness.toFixed(3)}`,
      `bpm      ${mood.bpm.toFixed(1)} (conf ${mood.beatConfidence.toFixed(2)}, phase ${mood.beatPhase.toFixed(2)})`,
      `key      ${mood.key.tonic} ${mood.key.mode} (conf ${mood.key.confidence.toFixed(2)})`,
      `section  ${mood.section}  slope ${mood.energySlope.toFixed(3)}`,
      `chroma   ${[...mood.chroma].map((v) => v.toFixed(1)).join(' ')}`,
      `вещество ${SUBSTANCE_LABELS[stats.scene.substance.nearest]} ось ${stats.scene.substance.axis.toFixed(2)}` +
        ` жёстк ${stats.scene.substance.stiffness.toFixed(2)} деформ ${stats.scene.substance.deformation.toFixed(2)}`,
      `свет     угол ${stats.scene.light.angle.toFixed(2)} инт ${stats.scene.light.intensity.toFixed(2)}` +
        ` вспышка ${stats.scene.light.flash.toFixed(2)} тепло ${stats.scene.light.warmth.toFixed(2)}`,
      `камера   x ${stats.scene.camera.x.toFixed(3)} y ${stats.scene.camera.y.toFixed(3)}` +
        ` zoom ${stats.scene.camera.zoom.toFixed(3)} крен ${stats.scene.camera.roll.toFixed(3)}`,
      `импульсы ${stats.scene.impulses.length} (эхо ${stats.scene.impulses.filter((i) => i.echo).length})` +
        ` энергия ${stats.scene.impulseEnergy.toFixed(2)}`,
      `палитра  ${stats.harmonyName}, оттенок ${stats.palette.hue.toFixed(0)}°`,
      `base     ${stats.baseId}`,
      `active   ${stats.activePrimitives.join(', ') || '—'}`,
      `частицы  ${stats.transient.particles} кольца ${stats.transient.rings}` +
        ` вспышка ${stats.transient.flash.toFixed(2)}`,
      `импакт   волн ${stats.scene.impact.shockwaves.length} ряби ${stats.scene.impact.ripples.length}` +
        ` линза ${stats.scene.impact.lensPulse.toFixed(2)} RGB ${stats.scene.impact.chromaticBurst.toFixed(2)}` +
        ` блоки ${stats.scene.impact.slice.toFixed(2)} давл ${stats.scene.impact.pressure.toFixed(2)}`,
      `деформ   warp ${stats.scene.deformation.domainWarp.toFixed(2)} twist ${stats.scene.deformation.twist.toFixed(2)}` +
        ` wave ${stats.scene.deformation.wave.toFixed(2)} turb ${stats.scene.deformation.turbulence.toFixed(2)}` +
        ` melt ${stats.scene.deformation.melt.toFixed(2)} fold ${stats.scene.deformation.fold.toFixed(2)}` +
        ` ${stats.warpActive ? '[варп]' : '[пропуск]'}`,
      `полосы   низ ${bar(mood.bands.low, 6)} сер ${bar(mood.bands.mid, 6)} верх ${bar(mood.bands.high, 6)}`,
      `удар     ${lastImpulse ? `${IMPULSE_KIND_LABELS[lastImpulse.kind]} сила ${lastImpulse.strength.toFixed(2)}` +
        ` профиль ${lastImpulse.profile.low.toFixed(2)}/${lastImpulse.profile.mid.toFixed(2)}/${lastImpulse.profile.high.toFixed(2)}` +
        `${lastImpulse.echo ? ' (эхо)' : ''}` : '—'}`,
      `seed     ${stats.seedLabel}`,
    ].join('\n');
  }

  private drawGraphs(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.traces.forEach((trace, index) => {
      const top = index * GRAPH_HEIGHT;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, top + GRAPH_HEIGHT - 0.5);
      ctx.lineTo(HISTORY, top + GRAPH_HEIGHT - 0.5);
      ctx.stroke();

      ctx.strokeStyle = trace.color;
      ctx.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        // Пишем по кругу, а рисуем слева направо от самого старого значения.
        const value = trace.values[(this.writeIndex + i) % HISTORY];
        const y = top + GRAPH_HEIGHT - 1 - value * (GRAPH_HEIGHT - 3);
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      }
      ctx.stroke();

      ctx.fillStyle = trace.color;
      ctx.font = '8px monospace';
      ctx.fillText(trace.label, 2, top + 9);
    });

    // Удары — вертикальные засечки поверх всех графиков.
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    for (let i = 0; i < HISTORY; i++) {
      if (this.onsets[(this.writeIndex + i) % HISTORY] === 0) continue;
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, this.canvas.height);
    }
    ctx.stroke();
  }
}

function bar(value: number, width = 16): string {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${'█'.repeat(filled)}${'·'.repeat(width - filled)}`;
}
