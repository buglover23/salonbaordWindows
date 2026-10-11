// The messages are written for Windows (npm.cmd, 起動.bat). Applied once where text leaves the process (the CLI and
// launcher writers), so on a Mac the owner reads the command and the file name that exist there.

/** `text` as the owner should read it on `platform`: unchanged on Windows; npm instead of npm.cmd elsewhere. */
export function forPlatform(text: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return text;
  const npm = text.replaceAll('npm.cmd', 'npm');
  return platform === 'darwin' ? npm.replaceAll('起動.bat', '起動.command') : npm;
}
