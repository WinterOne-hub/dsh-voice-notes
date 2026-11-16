import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const secureDirectory = String.raw`
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$identity = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$trustedOwners = @($identity.Value, $system.Value, 'S-1-5-32-544')
$root = [System.IO.DirectoryInfo]::new($env:DSH_VOICE_PRIVATE_DIRECTORY)

function Assert-OrdinaryItem($item) {
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'Linked item in Voice Notes data directory'
  }
}

Assert-OrdinaryItem $root
$previous = $root.GetAccessControl()
if ($previous.GetOwner($sidType).Value -notin $trustedOwners) {
  throw 'Unexpected Voice Notes directory owner'
}

$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
foreach ($account in @($identity, $system)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $account, 'FullControl', $inherit, 'None', 'Allow'
  )
  $acl.AddAccessRule($rule)
}
$root.SetAccessControl($acl)

# Existing files can carry explicit rules that survive inheritance changes.
# Verify them without resetting ACLs on individual files or following links.
$pending = [System.Collections.Generic.Stack[System.IO.FileSystemInfo]]::new()
$pending.Push($root)
while ($pending.Count -gt 0) {
  $item = $pending.Pop()
  Assert-OrdinaryItem $item
  $current = $item.GetAccessControl()
  $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($current.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl -or $current.GetOwner($sidType).Value -notin $trustedOwners) {
    throw 'Unexpected access control in Voice Notes data directory'
  }
  foreach ($rule in $current.GetAccessRules($true, $true, $sidType)) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trustedOwners) {
      throw 'Unexpected access grant in Voice Notes data directory'
    }
  }
  if ($item -is [System.IO.DirectoryInfo]) {
    foreach ($child in $item.EnumerateFileSystemInfos()) { $pending.Push($child) }
  }
}
`;

/** Protect the already-created, plugin-owned directory on Windows. */
export async function protectWindowsDirectory(directory) {
  const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(secureDirectory, 'utf16le').toString('base64');
  try {
    await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      env: { ...process.env, DSH_VOICE_PRIVATE_DIRECTORY: directory },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    });
  } catch {
    throw new Error('Unable to protect the Voice Notes data directory with Windows access controls.');
  }
}
