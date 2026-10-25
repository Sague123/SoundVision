/** Порядок стратегий захвата звука — без DOM, чтобы проверять обычным тестом. */

export type StrategyId = 'native-tap' | 'loopback' | 'virtual-device' | 'test-tone';

export interface OrderOptions {
  testTone: boolean;
  platform: string;
  /** Заглушка помощника: проверка цепочки без настоящего Mac. */
  fakeHelper: boolean;
}

/**
 * Порядок стратегий. На macOS loopback Electron не работает вовсе, поэтому его
 * там не пробуем: он только добавил бы ошибку в отчёт и мигание запроса прав.
 */
export function strategyOrder(options: OrderOptions): StrategyId[] {
  if (options.testTone) return ['test-tone'];
  if (options.platform === 'darwin') return ['native-tap', 'virtual-device'];
  if (options.fakeHelper) return ['native-tap'];
  return ['loopback', 'virtual-device'];
}
