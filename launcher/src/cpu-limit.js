'use strict';

const os = require('os');
const { spawnSync } = require('child_process');

function affinityMaskForPercent(maxPercent) {
  const logical = os.cpus().length;
  const allowed = Math.max(1, Math.floor((logical * maxPercent) / 100));
  if (allowed >= logical) return null;
  let mask = 0;
  for (let i = 0; i < allowed; i++) mask |= 1 << i;
  return mask;
}

function setProcessAffinity(pid, maxPercent = 75) {
  if (process.platform !== 'win32' || !pid || pid <= 0) return;
  const mask = affinityMaskForPercent(maxPercent);
  if (mask === null) return;
  const script = [
    'Add-Type -Namespace Win32 -Name Affinity -MemberDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class Affinity {',
    ' [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool b, int pid);',
    ' [DllImport("kernel32.dll")] public static extern bool SetProcessAffinityMask(IntPtr h, IntPtr m);',
    ' [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
    '}"@ -ErrorAction Stop',
    `$h = [Win32.Affinity]::OpenProcess(0x200, $false, ${pid})`,
    'if ($h -eq [IntPtr]::Zero) { exit 1 }',
    `[void][Win32.Affinity]::SetProcessAffinityMask($h, [IntPtr]::new(${mask}))`,
    '[void][Win32.Affinity]::CloseHandle($h)'
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 8000
  });
}

function setProcessPriorityLow(pid) {
  try {
    if (typeof os.setPriority === 'function') {
      os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    }
  } catch {
    // не критично
  }
}

/** Ограничение нагрузки лаунчера (~75%: ядра + пониженный приоритет). */
function applyLauncherCpuLimit(maxPercent = 75, ...pids) {
  for (const pid of pids) {
    if (!pid) continue;
    setProcessAffinity(pid, maxPercent);
    setProcessPriorityLow(pid);
  }
}

module.exports = { applyLauncherCpuLimit, setProcessAffinity };
