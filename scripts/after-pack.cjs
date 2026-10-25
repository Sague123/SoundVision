// Ad-hoc подпись macOS-сборки. Без сертификата Apple Silicon не запускает
// неподписанные программы, а ad-hoc подпись («-») этого достаточно: первый
// запуск делается через «Открыть» в контекстном меню.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = join(context.appOutDir, appName);
  const helper = join(appPath, 'Contents', 'Resources', 'helpers', 'NowPlayingHelper');
  if (existsSync(helper)) execFileSync('codesign', ['--force', '--sign', '-', helper], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  console.log(`ad-hoc подпись: ${appPath}`);
};
