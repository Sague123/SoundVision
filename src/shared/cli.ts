/**
 * Параметры командной строки. Нужны для запуска без интерфейса (проверки на
 * сборочных машинах) и для запуска на другом мониторе.
 *
 *   --fake-helper         вместо настоящего помощника — заглушка с тремя треками
 *   --audio=auto|test     test — тестовый тон вместо захвата (проверка цепочки,
 *                         но не картинки: это не музыка)
 *   --display=N           номер монитора, с нуля
 *   --windowed            окно вместо полного экрана
 *   --selfcheck-exit      пройти самопроверку, сохранить отчёт и выйти
 *   --report=ПУТЬ         куда писать отчёт (по умолчанию — папка данных)
 */

export interface CliOptions {
  fakeHelper: boolean;
  audio: 'auto' | 'test';
  display: number | null;
  windowed: boolean;
  selfcheckExit: boolean;
  reportPath: string | null;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    fakeHelper: false, audio: 'auto', display: null, windowed: false, selfcheckExit: false, reportPath: null,
  };
  for (const arg of argv) {
    if (arg === '--fake-helper') options.fakeHelper = true;
    else if (arg === '--windowed') options.windowed = true;
    else if (arg === '--selfcheck-exit') options.selfcheckExit = true;
    else if (arg.startsWith('--audio=')) options.audio = arg.slice(8) === 'test' ? 'test' : 'auto';
    else if (arg.startsWith('--display=')) {
      const n = Number(arg.slice(10));
      options.display = Number.isInteger(n) && n >= 0 ? n : null;
    } else if (arg.startsWith('--report=')) options.reportPath = arg.slice(9) || null;
  }
  return options;
}
