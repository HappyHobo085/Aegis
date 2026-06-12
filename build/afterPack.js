// build/afterPack.js
// electron-builder afterPack hook — flips Electron security "fuses" on the packed
// binary BEFORE signing. Hardens the runtime: no RunAsNode, no Node CLI inspect,
// no NODE_OPTIONS, only load the app from asar, encrypt cookies, and (Windows/
// macOS only) validate embedded asar integrity. Runs for every builder target.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const executableName = packager.executableName || packager.appInfo.productFilename;

  let binaryPath;
  if (electronPlatformName === 'darwin') {
    binaryPath = path.join(appOutDir, `${executableName}.app`, 'Contents', 'MacOS', executableName);
  } else if (electronPlatformName === 'win32') {
    binaryPath = path.join(appOutDir, `${executableName}.exe`);
  } else {
    binaryPath = path.join(appOutDir, executableName);
  }

  await flipFuses(binaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    // asar-integrity validation is supported on Windows/macOS but NOT Linux on
    // this Electron version; electron-builder injects the header hash when on.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: electronPlatformName !== 'linux',
  });

  // eslint-disable-next-line no-console
  console.log(`[afterPack] flipped security fuses on ${binaryPath}`);
};
