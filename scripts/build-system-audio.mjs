import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`${command} failed`);
};
if (process.platform === 'darwin' && process.arch === 'arm64') {
  const app = join(root, 'native/bin/darwin-arm64/VoiceNotesAudio.app/Contents');
  await mkdir(join(app, 'MacOS'), { recursive: true });
  await copyFile(join(root, 'native/macos/Info.plist'), join(app, 'Info.plist'));
  run('xcrun', ['swiftc', 'native/macos/SystemAudio.swift', '-o', 'native/bin/darwin-arm64/VoiceNotesAudio.app/Contents/MacOS/VoiceNotesAudio',
    '-O', '-target', 'arm64-apple-macos14.2', '-module-cache-path', '/tmp/voice-notes-swift-cache', '-framework', 'CoreAudio', '-framework', 'AVFoundation']);
  run('codesign', ['--force', '--sign', '-', '--identifier', 'org.winterone.voice-notes.audio', '--timestamp=none', 'native/bin/darwin-arm64/VoiceNotesAudio.app']);
  run('codesign', ['--verify', '--strict', 'native/bin/darwin-arm64/VoiceNotesAudio.app']);
} else if (process.platform === 'win32' && process.arch === 'x64') {
  await mkdir(join(root, 'native/bin/win32-x64'), { recursive: true });
  run('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/O2', '/MT', '/Brepro', 'native/windows/system-audio.cpp',
    '/Fo:native/bin/win32-x64/system-audio.obj', '/Fe:native/bin/win32-x64/system-audio.exe', '/link', 'ole32.lib', 'uuid.lib', '/INCREMENTAL:NO']);
} else throw new Error('Native capture builds require macOS arm64 or Windows x64.');
const platform = `${process.platform}-${process.arch}`;
const paths = platform === 'darwin-arm64'
  ? ['darwin-arm64/VoiceNotesAudio.app/Contents/MacOS/VoiceNotesAudio', 'darwin-arm64/VoiceNotesAudio.app/Contents/Info.plist', 'darwin-arm64/VoiceNotesAudio.app/Contents/_CodeSignature/CodeResources']
  : ['win32-x64/system-audio.exe'];
const files = {};
for (const path of paths) files[path] = createHash('sha256').update(await readFile(join(root, 'native/bin', path))).digest('hex');
await writeFile(join(root, 'native/bin', `${platform}.json`), JSON.stringify({ version: pkg.version, files }, null, 2) + '\n');
