/**
 * Мелкие строительные блоки панели настроек.
 *
 * Каждый контрол возвращает `sync()` — перечитать значение из настроек.
 * Это нужно при загрузке профиля: настройки меняются целиком, а поля ввода
 * должны показать новое состояние без пересборки панели.
 */

export interface Control {
  element: HTMLElement;
  sync(): void;
}

export function section(title: string, ...children: Array<HTMLElement | Control>): HTMLElement {
  const element = document.createElement('section');
  element.className = 'panel__section';

  const heading = document.createElement('h3');
  heading.className = 'panel__heading';
  heading.textContent = title;
  element.append(heading);

  for (const child of children) {
    element.append('element' in child ? child.element : child);
  }
  return element;
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

interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
  format?(value: number): string;
}

export function slider(options: SliderOptions): Control {
  const element = document.createElement('label');
  element.className = 'panel__control';

  const caption = document.createElement('span');
  caption.className = 'panel__label';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);

  const value = document.createElement('span');
  value.className = 'panel__value';

  const format = options.format ?? ((raw: number) => raw.toFixed(2));
  const sync = (): void => {
    const current = options.get();
    input.value = String(current);
    caption.textContent = options.label;
    value.textContent = format(current);
  };

  input.addEventListener('input', () => {
    options.set(Number(input.value));
    value.textContent = format(Number(input.value));
  });

  element.append(caption, input, value);
  sync();
  return { element, sync };
}

interface ToggleOptions {
  label: string;
  get(): boolean;
  set(value: boolean): void;
}

export function toggle(options: ToggleOptions): Control {
  const element = document.createElement('label');
  element.className = 'panel__control panel__control--toggle';

  const input = document.createElement('input');
  input.type = 'checkbox';

  const caption = document.createElement('span');
  caption.className = 'panel__label';
  caption.textContent = options.label;

  input.addEventListener('change', () => options.set(input.checked));
  element.append(input, caption);

  const sync = (): void => {
    input.checked = options.get();
  };
  sync();
  return { element, sync };
}

interface SelectOptions<T extends string> {
  label: string;
  options: Array<{ value: T; label: string }>;
  get(): T;
  set(value: T): void;
}

export function select<T extends string>(config: SelectOptions<T>): Control {
  const element = document.createElement('label');
  element.className = 'panel__control';

  const caption = document.createElement('span');
  caption.className = 'panel__label';
  caption.textContent = config.label;

  const input = document.createElement('select');
  for (const option of config.options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    input.append(node);
  }

  input.addEventListener('change', () => config.set(input.value as T));
  element.append(caption, input);

  const sync = (): void => {
    input.value = config.get();
  };
  sync();
  return { element, sync };
}

interface TextOptions {
  label: string;
  placeholder?: string;
  get(): string;
  set(value: string): void;
}

export function textField(options: TextOptions): Control {
  const element = document.createElement('label');
  element.className = 'panel__control';

  const caption = document.createElement('span');
  caption.className = 'panel__label';
  caption.textContent = options.label;

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = options.placeholder ?? '';
  input.addEventListener('change', () => options.set(input.value));

  element.append(caption, input);

  const sync = (): void => {
    input.value = options.get();
  };
  sync();
  return { element, sync };
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
  const element = document.createElement('label');
  element.className = 'panel__control';

  const caption = document.createElement('span');
  caption.className = 'panel__label';
  caption.textContent = label;

  const input = document.createElement('input');
  input.type = 'color';
  input.addEventListener('input', () => set(input.value));

  element.append(caption, input);

  const sync = (): void => {
    const value = get();
    // <input type=color> понимает только #rrggbb; 'auto' и hsl() ему не скормить.
    input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  };
  sync();
  return { element, sync };
}
