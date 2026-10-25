/** Выбор монитора для шоу. Чистые функции, Electron не нужен. */

export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface DisplayChoice {
  /** Номер из `--display=N`, с нуля. */
  cliIndex: number | null;
  /** Монитор из прошлого запуска. */
  savedId: number | null;
  primaryId: number;
}

/**
 * Порядок: явный номер из командной строки → монитор из прошлого запуска
 * (если он ещё подключён) → основной. Телевизор подключают и отключают, поэтому
 * сохранённый монитор может исчезнуть — тогда это не ошибка.
 */
export function pickDisplay<T extends DisplayLike>(displays: readonly T[], choice: DisplayChoice): T {
  if (displays.length === 0) throw new Error('нет ни одного монитора');
  if (choice.cliIndex !== null && choice.cliIndex < displays.length) return displays[choice.cliIndex];
  if (choice.savedId !== null) {
    const saved = displays.find((d) => d.id === choice.savedId);
    if (saved) return saved;
  }
  return displays.find((d) => d.id === choice.primaryId) ?? displays[0];
}

/** Следующий монитор по кругу; мониторы упорядочены слева направо. */
export function nextDisplay<T extends DisplayLike>(displays: readonly T[], currentId: number): T {
  const ordered = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const index = ordered.findIndex((d) => d.id === currentId);
  return ordered[(index + 1) % ordered.length];
}
