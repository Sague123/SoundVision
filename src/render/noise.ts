/** Симплекс-шум 2D/3D с seed'ом — база для flow-field, варпов и морфинга. */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

export class SimplexNoise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(random: () => number = Math.random) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** @returns значение в диапазоне примерно -1..1 */
  noise2D(xin: number, yin: number): number {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;

    const ii = i & 255;
    const jj = j & 255;
    let total = 0;
    total += this.corner2(x0, y0, this.permMod12[ii + this.perm[jj]]);
    total += this.corner2(x1, y1, this.permMod12[ii + i1 + this.perm[jj + j1]]);
    total += this.corner2(x2, y2, this.permMod12[ii + 1 + this.perm[jj + 1]]);
    return 70 * total;
  }

  noise3D(xin: number, yin: number, zin: number): number {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
      else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
    } else {
      if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
      else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
      else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
    }

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let total = 0;
    total += this.corner3(x0, y0, z0, this.permMod12[ii + this.perm[jj + this.perm[kk]]]);
    total += this.corner3(x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3,
      this.permMod12[ii + i1 + this.perm[jj + j1 + this.perm[kk + k1]]]);
    total += this.corner3(x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3,
      this.permMod12[ii + i2 + this.perm[jj + j2 + this.perm[kk + k2]]]);
    total += this.corner3(x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3,
      this.permMod12[ii + 1 + this.perm[jj + 1 + this.perm[kk + 1]]]);
    return 32 * total;
  }

  private corner2(x: number, y: number, gi: number): number {
    let t = 0.5 - x * x - y * y;
    if (t < 0) return 0;
    t *= t;
    return t * t * (GRAD3[gi][0] * x + GRAD3[gi][1] * y);
  }

  private corner3(x: number, y: number, z: number, gi: number): number {
    let t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    t *= t;
    return t * t * (GRAD3[gi][0] * x + GRAD3[gi][1] * y + GRAD3[gi][2] * z);
  }
}
