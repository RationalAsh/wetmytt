const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async context => {
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch];
  if (context.electronPlatformName !== process.platform || !arch) throw new Error('Build on the target operating system with arm64 or x64.');
  await fs.mkdir(path.join(context.packager.projectDir, 'build/git'), { recursive: true });
  await promisify(execFile)(process.execPath, ['scripts/prepare-git.cjs', arch], { cwd: context.packager.projectDir, maxBuffer: 4 * 1024 * 1024 });
  const embedded = require('dugite/script/embedded-git.json');
  const distribution = embedded[`${context.electronPlatformName}-${arch}`];
  await fs.writeFile(path.join(context.packager.projectDir, 'build/git', arch, 'distribution.json'), JSON.stringify({ ...distribution, sources: 'https://github.com/desktop/dugite-native', license: 'GPL-2.0' }, null, 2));
};
