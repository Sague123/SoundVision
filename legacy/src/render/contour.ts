/**
 * Изолинии скалярного поля методом marching squares.
 *
 * Зачем: «заливочные» примитивы раньше считали поле в низком разрешении и
 * растягивали его на весь кадр — отсюда блочные края и сплошная заливка в
 * средних тонах. Контур решает обе проблемы сразу: поле по-прежнему грубое и
 * дешёвое, но из него достаётся геометрия, а она рисуется линиями в
 * физическом разрешении экрана. Граница получается гладкой, а кадр остаётся
 * тёмным, потому что светятся только линии.
 */

/** Отрезки контура в координатах поля: x1, y1, x2, y2 подряд. */
export type ContourSegments = Float32Array;

/**
 * Таблица marching squares.
 *
 * Индекс — битовая маска четырёх углов ячейки (выше порога или нет). Значения —
 * пары рёбер, между которыми идёт отрезок: 0 — верх, 1 — право, 2 — низ, 3 — лево.
 * Неоднозначные случаи 5 и 10 (диагональ) режем одним и тем же способом: для
 * наших полей выбор ветви на глаз не различим.
 */
const EDGE_TABLE: number[][] = [
  [], [2, 3], [1, 2], [1, 3],
  [0, 1], [0, 3, 1, 2], [0, 2], [0, 3],
  [0, 3], [0, 2], [0, 1, 2, 3], [0, 1],
  [1, 3], [1, 2], [2, 3], [],
];

export class ContourBuilder {
  private buffer: Float32Array;
  private count = 0;
  /** Id ребра сетки у каждого конца отрезка: по нему отрезки сшиваются. */
  private endEdges: Int32Array;
  /** Какие отрезки выходят на ребро: не больше двух, по одному из каждой ячейки. */
  private slotA = new Int32Array(0);
  private slotB = new Int32Array(0);
  private visited: Uint8Array;
  /** Точки полилиний подряд (x, y) и начала полилиний в этом массиве. */
  private points: Float32Array;
  private chainStart: Int32Array;
  private chainCount = 0;
  private pointCount = 0;
  private chained = false;

  constructor(maxSegments = 4096) {
    this.buffer = new Float32Array(maxSegments * 4);
    this.endEdges = new Int32Array(maxSegments * 2);
    this.visited = new Uint8Array(maxSegments);
    // Полилиния из n отрезков — n + 1 точка; с запасом на замыкание петли.
    this.points = new Float32Array(maxSegments * 2 * 2 + 16);
    this.chainStart = new Int32Array(maxSegments + 1);
  }

  /** Сколько отрезков в последнем построении. */
  get length(): number {
    return this.count;
  }

  get segments(): ContourSegments {
    return this.buffer;
  }

  /**
   * @param field значения по сетке cols×rows, построчно
   * @param threshold уровень изолинии
   */
  build(field: Float32Array, cols: number, rows: number, threshold: number): number {
    this.count = 0;
    this.chained = false;
    const max = this.buffer.length / 4;
    const edgeIds = cols * rows * 2;
    if (this.slotA.length < edgeIds) {
      this.slotA = new Int32Array(edgeIds);
      this.slotB = new Int32Array(edgeIds);
    }
    this.slotA.fill(-1, 0, edgeIds);
    this.slotB.fill(-1, 0, edgeIds);
    const vertical = cols * rows;

    for (let y = 0; y < rows - 1; y++) {
      for (let x = 0; x < cols - 1; x++) {
        const topLeft = field[y * cols + x];
        const topRight = field[y * cols + x + 1];
        const bottomRight = field[(y + 1) * cols + x + 1];
        const bottomLeft = field[(y + 1) * cols + x];

        // Порядок битов совпадает с порядком рёбер в таблице.
        const mask = (topLeft > threshold ? 8 : 0)
          | (topRight > threshold ? 4 : 0)
          | (bottomRight > threshold ? 2 : 0)
          | (bottomLeft > threshold ? 1 : 0);
        const edges = EDGE_TABLE[mask];
        if (edges.length === 0) continue;

        for (let i = 0; i + 1 < edges.length; i += 2) {
          if (this.count >= max) return this.count;
          const offset = this.count * 4;
          this.edgePoint(edges[i], x, y, topLeft, topRight, bottomRight, bottomLeft, threshold, offset);
          this.edgePoint(edges[i + 1], x, y, topLeft, topRight, bottomRight, bottomLeft, threshold, offset + 2);
          const a = edgeId(edges[i], x, y, cols, vertical);
          const b = edgeId(edges[i + 1], x, y, cols, vertical);
          this.endEdges[this.count * 2] = a;
          this.endEdges[this.count * 2 + 1] = b;
          this.attach(a, this.count);
          this.attach(b, this.count);
          this.count++;
        }
      }
    }
    return this.count;
  }

  /**
   * Сшить отрезки в полилинии. Считается один раз на построение: соседние
   * ячейки делят ребро, и по id ребра видно, какой отрезок продолжает какой.
   */
  chain(): void {
    if (this.chained) return;
    this.chained = true;
    this.chainCount = 0;
    this.pointCount = 0;
    this.visited.fill(0, 0, this.count);

    for (let s = 0; s < this.count; s++) {
      if (this.visited[s]) continue;
      // Назад до открытого конца (или до себя же — тогда это петля).
      let start = s;
      let open = this.endEdges[s * 2];
      for (let guard = 0; guard < this.count; guard++) {
        const prev = this.neighbour(start, open);
        if (prev < 0 || prev === s) break;
        open = this.otherEnd(prev, open);
        start = prev;
      }

      this.chainStart[this.chainCount++] = this.pointCount;
      let current = start;
      let entry = open;
      this.pushPoint(current, entry);
      for (let guard = 0; guard <= this.count; guard++) {
        this.visited[current] = 1;
        const exit = this.otherEnd(current, entry);
        this.pushPoint(current, exit);
        const next = this.neighbour(current, exit);
        if (next < 0 || this.visited[next]) break;
        current = next;
        entry = exit;
      }
    }
    this.chainStart[this.chainCount] = this.pointCount;
  }

  /** Число полилиний после `chain()`. */
  get chains(): number {
    return this.chainCount;
  }

  /** Точки полилиний: пары x, y; полилиния i — точки [chainStart[i], chainStart[i+1]). */
  get chainPoints(): Float32Array {
    return this.points;
  }

  get chainOffsets(): Int32Array {
    return this.chainStart;
  }

  private attach(edge: number, segment: number): void {
    if (this.slotA[edge] < 0) this.slotA[edge] = segment;
    else this.slotB[edge] = segment;
  }

  private neighbour(segment: number, edge: number): number {
    const a = this.slotA[edge];
    return a === segment ? this.slotB[edge] : a;
  }

  private otherEnd(segment: number, edge: number): number {
    const a = this.endEdges[segment * 2];
    return a === edge ? this.endEdges[segment * 2 + 1] : a;
  }

  /** Точку конца `edge` отрезка `segment` — в буфер полилиний. */
  private pushPoint(segment: number, edge: number): void {
    if (this.pointCount * 2 + 2 > this.points.length) return;
    const end = this.endEdges[segment * 2] === edge ? 0 : 2;
    this.points[this.pointCount * 2] = this.buffer[segment * 4 + end];
    this.points[this.pointCount * 2 + 1] = this.buffer[segment * 4 + end + 1];
    this.pointCount++;
  }

  /**
   * Точка пересечения контура с ребром ячейки — сразу в буфер отрезков.
   * Интерполяция линейная — именно она делает контур гладким, а не ступенчатым.
   */
  private edgePoint(
    edge: number,
    x: number,
    y: number,
    topLeft: number,
    topRight: number,
    bottomRight: number,
    bottomLeft: number,
    threshold: number,
    offset: number,
  ): void {
    const out = this.buffer;
    switch (edge) {
      case 0: out[offset] = x + fraction(topLeft, topRight, threshold); out[offset + 1] = y; break;
      case 1: out[offset] = x + 1; out[offset + 1] = y + fraction(topRight, bottomRight, threshold); break;
      case 2: out[offset] = x + fraction(bottomLeft, bottomRight, threshold); out[offset + 1] = y + 1; break;
      default: out[offset] = x; out[offset + 1] = y + fraction(topLeft, bottomLeft, threshold);
    }
  }
}

/**
 * Id ребра сетки: горизонтальные рёбра — `y * cols + x`, вертикальные — со
 * сдвигом на `cols * rows`. Верх ячейки (x, y) и низ ячейки (x, y - 1) — одно
 * и то же ребро, поэтому соседние отрезки получают одинаковый id.
 */
function edgeId(edge: number, x: number, y: number, cols: number, vertical: number): number {
  switch (edge) {
    case 0: return y * cols + x;
    case 1: return vertical + y * cols + x + 1;
    case 2: return (y + 1) * cols + x;
    default: return vertical + y * cols + x;
  }
}

function fraction(a: number, b: number, threshold: number): number {
  const delta = b - a;
  if (Math.abs(delta) < 1e-6) return 0.5;
  return Math.min(1, Math.max(0, (threshold - a) / delta));
}

/**
 * Отрисовка контура сглаженными полилиниями.
 *
 * Раньше отрезки рисовались по отдельности: при ячейке в 9-13 пикселей
 * изолиния состояла из видимых прямых кусков, и плавная граница читалась
 * гранёной — та самая «пиксельность». Теперь отрезки сшиваются по общим
 * рёбрам сетки, а полилиния идёт квадратичными кривыми через середины
 * отрезков: излом сглаживается без роста разрешения поля.
 */
export function strokeContour(
  ctx: CanvasRenderingContext2D,
  builder: ContourBuilder,
  scaleX: number,
  scaleY: number,
): void {
  builder.chain();
  const points = builder.chainPoints;
  const offsets = builder.chainOffsets;
  ctx.beginPath();
  for (let c = 0; c < builder.chains; c++) {
    const from = offsets[c];
    const to = offsets[c + 1];
    const n = to - from;
    if (n < 2) continue;
    const x0 = points[from * 2] * scaleX;
    const y0 = points[from * 2 + 1] * scaleY;
    ctx.moveTo(x0, y0);
    if (n === 2) {
      ctx.lineTo(points[from * 2 + 2] * scaleX, points[from * 2 + 3] * scaleY);
      continue;
    }
    for (let i = from + 1; i < to - 1; i++) {
      const x = points[i * 2] * scaleX;
      const y = points[i * 2 + 1] * scaleY;
      const nx = points[i * 2 + 2] * scaleX;
      const ny = points[i * 2 + 3] * scaleY;
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    ctx.lineTo(points[(to - 1) * 2] * scaleX, points[(to - 1) * 2 + 1] * scaleY);
  }
  ctx.stroke();
}
