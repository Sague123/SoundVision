import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/main/config';
import { nextDisplay, pickDisplay } from '../src/main/display';
import { parseCli } from '../src/shared/cli';

const d = (id: number, x: number) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 } });

describe('config', () => {
  it('пишет и читает, битый файл — значения по умолчанию', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv-'));
    const file = join(dir, 'nested', 'config.json');
    saveConfig(file, { displayId: 7, showPanel: false });
    expect(loadConfig(file)).toEqual({ displayId: 7, showPanel: false });
    writeFileSync(file, '{oops');
    expect(loadConfig(file)).toEqual(DEFAULT_CONFIG);
    expect(loadConfig(join(dir, 'нет-такого.json'))).toEqual(DEFAULT_CONFIG);
  });

  it('не оставляет временный файл', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv-'));
    const file = join(dir, 'c.json');
    saveConfig(file, DEFAULT_CONFIG);
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });
});

describe('display', () => {
  const displays = [d(11, 0), d(22, 1920), d(33, 3840)];
  it('номер из командной строки главнее всего', () => {
    expect(pickDisplay(displays, { cliIndex: 2, savedId: 22, primaryId: 11 }).id).toBe(33);
  });
  it('сохранённый монитор, если он подключён', () => {
    expect(pickDisplay(displays, { cliIndex: null, savedId: 22, primaryId: 11 }).id).toBe(22);
  });
  it('отключили телевизор — основной монитор', () => {
    expect(pickDisplay(displays, { cliIndex: null, savedId: 99, primaryId: 11 }).id).toBe(11);
    expect(pickDisplay(displays, { cliIndex: 9, savedId: null, primaryId: 22 }).id).toBe(22);
  });
  it('следующий монитор идёт слева направо по кругу', () => {
    expect(nextDisplay([d(2, 1920), d(1, 0), d(3, 3840)], 1).id).toBe(2);
    expect(nextDisplay(displays, 33).id).toBe(11);
  });
});

describe('parseCli', () => {
  it('разбирает флаги и не верит мусору', () => {
    expect(parseCli(['--fake-helper', '--audio=test', '--display=2', '--windowed', '--selfcheck-exit', '--report=/x.json']))
      .toEqual({ fakeHelper: true, audio: 'test', display: 2, windowed: true, selfcheckExit: true, reportPath: '/x.json' });
    expect(parseCli(['--display=-1', '--audio=что-то', '--display=abc'])).toMatchObject({ display: null, audio: 'auto' });
    expect(parseCli([])).toMatchObject({ fakeHelper: false, windowed: false, reportPath: null });
  });
});
