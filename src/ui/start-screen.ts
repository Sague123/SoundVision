/**
 * Старт-экран.
 *
 * Главный путь — YouTube Music через расширение: звук и трек приходят через
 * локальный мост, и визуализация стартует сама, без клика. Экран в это время
 * показывает, чего ждёт. Захват экрана и микрофон — запасные пути для других
 * плееров: разрешение на них даётся на сессию, поэтому там нужен клик.
 */

export type AudioSourceKind = 'system' | 'microphone';

/** Что сейчас с источником «YouTube Music без захвата». */
export type BridgeWaitState =
  | 'disabled'      // выключено в настройках
  | 'no-bridge'     // мост не отвечает
  | 'waiting'       // мост есть, звука ещё нет
  | 'track-no-audio' // трек из YouTube Music виден, а звук не идёт
  | 'native';        // сборка-exe: берём звук Windows сами

const BRIDGE_TEXT: Record<BridgeWaitState, string> = {
  disabled: 'Звук из YouTube Music выключен в настройках (клавиша S → «Источники»).',
  'no-bridge': 'Мост не отвечает. Запустите его: npm run bridge — и держите окно открытым.',
  waiting: 'Мост на связи. Включите музыку в YouTube Music — картинка запустится сама.',
  'track-no-audio': 'Трек из YouTube Music виден, а звука нет. Кликните один раз по странице '
    + 'YouTube Music: без клика браузер не даёт расширению подключиться к звуку.',
  native: 'Берём звук Windows — включите музыку в любом плеере, картинка запустится сама.',
};

export interface StartScreenHandlers {
  onStart(source: AudioSourceKind): Promise<void>;
}

export class StartScreen {
  readonly element = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly micButton = document.createElement('button');
  private readonly error = document.createElement('p');
  private bridgeState: BridgeWaitState | null = null;

  constructor(private readonly handlers: StartScreenHandlers) {
    this.element.className = 'start';
    this.element.innerHTML = `
      <div class="start__card">
        <h1 class="start__title">SoundVision</h1>
        <p class="start__subtitle">Аудио-реактивная светомузыка для телевизора</p>
        <p class="start__lead">Включите музыку в <b>YouTube Music</b> — визуализация запустится сама.
           Звук, название и обложку расширение берёт прямо из плеера: ничего выбирать не нужно.</p>
        <p class="start__status" data-state="no-bridge"></p>
        <p class="start__hint">Панель настроек — клавиша <kbd>S</kbd>, полный экран — <kbd>F</kbd>,
           новый вариант визуала — <kbd>R</kbd>.</p>
        <p class="start__other">Другой плеер? Тогда звук берётся захватом: «Весь экран» и галочка
           «Также предоставить доступ к системному аудио».</p>
      </div>
    `;

    // Обе кнопки — запасной путь, поэтому обе тихие: главный путь без клика.
    this.button.className = 'start__button start__button--secondary';
    this.button.textContent = 'Захват экрана со звуком';
    this.button.addEventListener('click', () => void this.start('system'));

    // Живой режим: микрофон или линейный вход — концерт, пульт, колонки в комнате.
    this.micButton.className = 'start__button start__button--secondary';
    this.micButton.textContent = 'Микрофон или линейный вход';
    this.micButton.addEventListener('click', () => void this.start('microphone'));

    this.error.className = 'start__error';
    this.error.hidden = true;

    this.element.querySelector('.start__card')?.append(this.button, this.micButton, this.error);
  }

  show(): void {
    this.element.classList.remove('start--hidden');
    this.button.disabled = false;
    this.micButton.disabled = false;
    this.button.textContent = 'Захват экрана со звуком';
  }

  get visible(): boolean {
    return !this.element.classList.contains('start--hidden');
  }

  /** Строка о том, чего ждём от YouTube Music. */
  setBridgeState(state: BridgeWaitState): void {
    if (state === this.bridgeState) return;
    this.bridgeState = state;
    const status = this.element.querySelector<HTMLElement>('.start__status');
    if (!status) return;
    status.textContent = BRIDGE_TEXT[state];
    status.dataset.state = state;
  }

  hide(): void {
    this.element.classList.add('start--hidden');
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.button.disabled = false;
    this.micButton.disabled = false;
    this.button.textContent = 'Захват экрана со звуком';
  }

  private async start(source: AudioSourceKind): Promise<void> {
    this.button.disabled = true;
    this.micButton.disabled = true;
    this.button.textContent = 'Ждём разрешения…';
    this.error.hidden = true;
    try {
      await this.handlers.onStart(source);
    } catch (err) {
      this.showError((err as Error).message);
    }
  }
}
