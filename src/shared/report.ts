/** Отчёт самопроверки этапа 0: то, что проверено на конкретной машине. */

import type { AppInfo } from './ipc';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  /** Одна строка для человека. */
  summary: string;
  data?: Record<string, unknown>;
}

export interface Stage0Report {
  schema: 1;
  createdAt: string;
  durationMs: number;
  app: AppInfo;
  checks: CheckResult[];
  /** Критерии этапа 0 одним взглядом. */
  verdict: Record<string, CheckStatus>;
}
