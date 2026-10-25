/**
 * Мелкие строительные блоки панели настроек.
 *
 * Каждый контрол умеет три вещи помимо собственно ввода:
 * - `sync()` — перечитать значение из настроек. Нужно при загрузке пресета:
 *   настройки меняются целиком, а поля должны показать новое состояние без
 *   пересборки панели.
 * - поиск — `searchText` собирает название и подсказку в одну строку, панель
 *   по ней фильтрует. Разделов много, без поиска параметр не найти.
 * - сброс — кнопка у самого параметра, а не одна общая на всю панель.
 *   Она появляется только когда значение отличается от умолчания.
 */

export interface Control {
  element: HTMLElement;
  sync(): void;
  /** Название и подсказка в нижнем регистре — по ним ищет панель. */
  searchText: string;
}

/** Раздел панели: сворачивается и умеет прятаться целиком при поиске. */
export interface SectionHandle {
  element: HTMLElement;
  /** Показать/скрыть раздел — панель дёргает это при фильтрации. */
  setVisible(visible: boolean): void;
  /** Раскрыть раздел принудительно: найденное должно быть видно сразу. */
  expand(): void;
}

export function section(title: string, ...children: Array<HTMLElement | Control>): HTMLElement {
  return collapsible(title, ...children).element;
}

export function collapsible(
  title: string,
  ...children: Array<HTMLElement | Control>
): SectionHandle {
  const element = document.createElement('section');
  element.className = 'panel__section';

  const heading = document.createElement('button');
  heading.type = 'button';
  heading.className = 'panel__heading';
  heading.textContent = title;
  heading.setAttribute('aria-expanded', 'true');

  const content = document.createElement('div');
  content.className = 'panel__content';

  heading.addEventListener('click', () => {
    const open = element.classList.toggle('panel__section--collapsed');
    heading.setAttribute('aria-expanded', open ? 'false' : 'true');
  });

  element.append(heading, content);
  for (const child of children) {
    content.append('element' in child ? child.element : child);
  }

  return {
    element,
    setVisible: (visible) => { element.hidden = !visible; },
    expand: () => {
      element.classList.remove('panel__section--collapsed');
      heading.setAttribute('aria-expanded', 'true');
    },
  };
}

export function row(...children: Array<HTMLElement | Control>): HTMLElement {
  const element = document.createElement('div');
  element.className = 'panel__row';
  for (const child of children) element.append('element' in child ? child.element : child);
  return element;
}

export function note(text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'panel__note';
  element.textContent = text;
  return element;
}

interface FieldOptions {
  label: string;
  hint?: string;
}

/**
 * Общая обвязка любого параметра: подпись, кнопка сброса и место под значение.
 * Кнопка сброса прячется, когда значение уже умолчательное, — иначе панель
 * превращается в частокол одинаковых иконок.
 */
function field(options: FieldOptions, onReset: (() => void) | null): {
  element: HTMLLabelElement;
  caption: HTMLSpanElement;
  value: HTMLSpanElement;
  setModified(modified: boolean): void;
} {
  const element = document.createElement('label');
  element.className = 'panel__control';

  const head = document.createElement('span');
  head.className = 'panel__head';

  const caption = document.createElement('span');
  caption.className = 'panel__label';
  caption.textContent = options.label;

  const value = document.createElement('span');
  value.className = 'panel__value';

  head.append(caption);

  let reset: HTMLButtonElement | null = null;
  if (onReset) {
    reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'panel__reset';
    reset.textContent = '↺';
    reset.title = 'Вернуть значение по умолчанию';
    reset.hidden = true;
    // Клик по кнопке внутри <label> иначе доходит до поля ввода.
    reset.addEventListener('click', (event) => { event.preventDefault(); onReset(); });
    head.append(reset);
  }

  head.append(value);
  element.append(head);

  if (options.hint) {
    const hint = document.createElement('span');
    hint.className = 'panel__hint';
    hint.textContent = options.hint;
    element.append(hint);
  }

  return {
    element,
    caption,
    value,
    setModified: (modified) => { if (reset) reset.hidden = !modified; },
  };
}

function searchable(label: string, hint?: string): string {
  return `${label} ${hint ?? ''}`.toLowerCase();
}

interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
  format?(value: number): string;
  /** Значение по умолчанию; без него кнопки сброса не будет. */
  def?: number;
  hint?: string;
}

export function slider(options: SliderOptions): Control {
  const hasDefault = options.def !== undefined;
  const apply = (value: number): void => {
    options.set(value);
    sync();
  };

  const frame = field(options, hasDefault ? () => apply(options.def as number) : null);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);

  const format = options.format ?? ((raw: number) => raw.toFixed(2));

  function sync(): void {
    const current = options.get();
    input.value = String(current);
    frame.value.textContent = format(current);
    // Сравнение с допуском в полшага: у дробных шагов точного равенства нет.
    frame.setModified(hasDefault && Math.abs(current - (options.def as number)) > options.step / 2);
  }

  input.addEventListener('input', () => {
    options.set(Number(input.value));
    sync();
  });

  frame.element.append(input);
  sync();
  return { element: frame.element, sync, searchText: searchable(options.label, options.hint) };
}

interface ToggleOptions {
  label: string;
  get(): boolean;
  set(value: boolean): void;
  def?: boolean;
  hint?: string;
}

export function toggle(options: ToggleOptions): Control {
  const hasDefault = options.def !== undefined;
  const frame = field(options, hasDefault
    ? () => { options.set(options.def as boolean); sync(); }
    : null);
  frame.element.classList.add('panel__control--toggle');

  const input = document.createElement('input');
  input.type = 'checkbox';

  function sync(): void {
    input.checked = options.get();
    frame.setModified(hasDefault && input.checked !== options.def);
  }

  input.addEventListener('change', () => {
    options.set(input.checked);
    sync();
  });

  // Флажок стоит перед подписью — так его видно в общем списке.
  frame.element.prepend(input);
  sync();
  return { element: frame.element, sync, searchText: searchable(options.label, options.hint) };
}

interface SelectOptions<T extends string> {
  label: string;
  options: Array<{ value: T; label: string }>;
  get(): T;
  set(value: T): void;
  def?: T;
  hint?: string;
}

export function select<T extends string>(config: SelectOptions<T>): Control {
  const hasDefault = config.def !== undefined;
  const frame = field(config, hasDefault
    ? () => { config.set(config.def as T); sync(); }
    : null);

  const input = document.createElement('select');
  for (const option of config.options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    input.append(node);
  }

  function sync(): void {
    input.value = config.get();
    frame.setModified(hasDefault && input.value !== config.def);
  }

  input.addEventListener('change', () => {
    config.set(input.value as T);
    sync();
  });

  frame.element.append(input);
  sync();
  return {
    element: frame.element,
    sync,
    searchText: searchable(config.label, [config.hint, ...config.options.map((o) => o.label)].join(' ')),
  };
}

interface TextOptions {
  label: string;
  placeholder?: string;
  get(): string;
  set(value: string): void;
  hint?: string;
}

export function textField(options: TextOptions): Control {
  const frame = field(options, null);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = options.placeholder ?? '';
  input.addEventListener('change', () => options.set(input.value));

  frame.element.append(input);

  const sync = (): void => { input.value = options.get(); };
  sync();
  return { element: frame.element, sync, searchText: searchable(options.label, options.hint) };
}

export function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `panel__button ${variant}`.trim();
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

export function colorField(label: string, get: () => string, set: (value: string) => void): Control {
  const frame = field({ label }, null);

  const input = document.createElement('input');
  input.type = 'color';
  input.addEventListener('input', () => set(input.value));

  frame.element.append(input);

  const sync = (): void => {
    const value = get();
    // <input type=color> понимает только #rrggbb; 'auto' и hsl() ему не скормить.
    input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  };
  sync();
  return { element: frame.element, sync, searchText: searchable(label) };
}
