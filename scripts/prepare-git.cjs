// Download the checksum-verified Git distribution for a packaging target without
// replacing the host architecture's development installation.
const path = require('node:path');
const arch = process.argv[2];
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported Git architecture: ${arch}`);
process.env.npm_config_arch = arch;
const configPath = require.resolve('dugite/script/config');
const original = require(configPath);
require.cache[configPath].exports = () => ({ ...original(), outputPath: path.resolve('build/git', arch) });
require('dugite/script/download-git');
