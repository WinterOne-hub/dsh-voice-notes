import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRecordingStore } from '../storage.js';

test('Windows archives inherit a private ACL and refuse pre-existing grants to Everyone', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "voice notes 测试 ' "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'recordings');
  const store = createRecordingStore(root);
  await store.initialize();
  const saved = await store.save({ text: 'test transcript', audio: Buffer.from('test audio') });
  const audio = join(root, saved.audioFile);
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = Get-Acl -LiteralPath $env:VOICE_NOTES_TEST_ROOT
if (!$root.AreAccessRulesProtected) { throw 'The archive must not inherit parent access rules' }
$file = Get-Acl -LiteralPath $env:VOICE_NOTES_TEST_FILE
$sidType = [System.Security.Principal.SecurityIdentifier]
$user = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
$approved = @($user, 'S-1-5-18')
$rights = @($file.GetAccessRules($true, $true, $sidType) | Where-Object { $_.AccessControlType -eq 'Allow' })
if ($rights.Count -ne 2 -or @($rights | Where-Object { $_.IdentityReference.Value -notin $approved }).Count -ne 0) {
  throw 'The recording file must allow only its user and SYSTEM'
}
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow')
$file.AddAccessRule($rule)
Set-Acl -LiteralPath $env:VOICE_NOTES_TEST_FILE -AclObject $file
`;
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, VOICE_NOTES_TEST_ROOT: root, VOICE_NOTES_TEST_FILE: audio },
    windowsHide: true,
  });
  await assert.rejects(createRecordingStore(root).initialize(), /Windows access controls/);
});
