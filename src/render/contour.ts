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

  constructor(maxSegments = 4096) {
    this.buffer = new Float32Array(maxSegments * 4);
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
    const max = this.buffer.length / 4;

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
          const a = this.edgePoint(edges[i], x, y, topLeft, topRight, bottomRight, bottomLeft, threshold);
          const b = this.edgePoint(edges[i + 1], x, y, topLeft, topRight, bottomRight, bottomLeft, threshold);
          const offset = this.count * 4;
          this.buffer[offset] = a[0];
          this.buffer[offset + 1] = a[1];
          this.buffer[offset + 2] = b[0];
          this.buffer[offset + 3] = b[1];
          this.count++;
        }
      }
    }
    return this.count;
  }

  /**
   * Точка пересечения контура с ребром ячейки.
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
  ): [number, number] {
    switch (edge) {
      case 0: return [x + fraction(topLeft, topRight, threshold), y];
      case 1: return [x + 1, y + fraction(topRight, bottomRight, threshold)];
      case 2: return [x + fraction(bottomLeft, bottomRight, threshold), y + 1];
      default: return [x, y + fraction(topLeft, bottomLeft, threshold)];
    }
  }
}

function fraction(a: number, b: number, threshold: number): number {
  const delta = b - a;
  if (Math.abs(delta) < 1e-6) return 0.5;
  return Math.min(1, Math.max(0, (threshold - a) / delta));
}

/**
 * Отрисовка контура одной линией. Отрезки не соединяются в полилинии
 * намеренно: сортировка стоила бы дороже, а визуально разрывов не видно —
 * соседние отрезки смыкаются концами.
 */
export function strokeContour(
  ctx: CanvasRenderingContext2D,
  builder: ContourBuilder,
  scaleX: number,
  scaleY: number,
): void {
  const segments = builder.segments;
  ctx.beginPath();
  for (let i = 0; i < builder.length; i++) {
    const offset = i * 4;
    ctx.moveTo(segments[offset] * scaleX, segments[offset + 1] * scaleY);
    ctx.lineTo(segments[offset + 2] * scaleX, segments[offset + 3] * scaleY);
  }
  ctx.stroke();
}
