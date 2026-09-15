/**
 * Старт-экран. Нужен на каждый запуск: разрешение на захват экрана даётся
 * на сессию, поэтому без явного клика звук взять невозможно.
 */

export interface StartScreenHandlers {
  onStart(): Promise<void>;
}

export class StartScreen {
  readonly element = document.createElement('div');
  private readonly button = document.createElement('button');
  private readonly error = document.createElement('p');

  constructor(private readonly handlers: StartScreenHandlers) {
    this.element.className = 'start';
    this.element.innerHTML = `
      <div class="start__card">
        <h1 class="start__title">SoundVision</h1>
        <p class="start__subtitle">Аудио-реактивная светомузыка для телевизора</p>
        <ol class="start__steps">
          <li>Нажмите «Запустить визуализацию».</li>
          <li>В окне выбора источника откройте вкладку <b>«Весь экран»</b> и выберите экран.
              Захват отдельной вкладки звук стороннего плеера <b>не отдаёт</b>.</li>
          <li>Включите галочку <b>«Также предоставить доступ к системному аудио»</b>.</li>
          <li>Запустите музыку в Spotify, YouTube Music — в чём угодно.</li>
        </ol>
        <p class="start__hint">Картинка появится сама. Панель настроек — клавиша <kbd>S</kbd>,
           полный экран — <kbd>F</kbd>, новый вариант визуала — <kbd>R</kbd>.</p>
      </div>
    `;

    this.button.className = 'start__button';
    this.button.textContent = 'Запустить визуализацию';
    this.button.addEventListener('click', () => void this.start());

    this.error.className = 'start__error';
    this.error.hidden = true;

    this.element.querySelector('.start__card')?.append(this.button, this.error);
  }

  show(): void {
    this.element.classList.remove('start--hidden');
    this.button.disabled = false;
    this.button.textContent = 'Запустить визуализацию';
  }

  hide(): void {
    this.element.classList.add('start--hidden');
  }

  showError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = false;
    this.button.disabled = false;
    this.button.textContent = 'Попробовать снова';
  }

  private async start(): Promise<void> {
    this.button.disabled = true;
    this.button.textContent = 'Ждём разрешения…';
    this.error.hidden = true;
    try {
      await this.handlers.onStart();
    } catch (err) {
      this.showError((err as Error).message);
    }
  }
}
