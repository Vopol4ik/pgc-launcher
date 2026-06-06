'use strict';

const cp = require('child_process');

/**
 * Переменные окружения Windows: дискретная видеокарта (NVIDIA / AMD) вместо встроенной.
 * @see https://docs.nvidia.com/gameworks/content/technologies/desktop/optimus.htm
 */
function discreteGpuEnv() {
  if (process.platform !== 'win32') {
    return {};
  }
  return {
    SHIM_MCCOMPAT: '0x800000001',
    __NV_PRIME_RENDER_OFFLOAD: '1',
    __NV_PRIME_RENDER_OFFLOAD_PROVIDER: 'NVIDIA',
    __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
    __VK_LAYER_NV_optimus: 'NVIDIA_only',
    AMD_SWITCHABLE_GRAPHICS: '1',
    GPU_FORCE_64BIT_PTR_PREFER_DISCRETE: '0x1',
    D3D12_GPU_PREFERENCE: '1'
  };
}

function applyDiscreteGpuToProcessEnv() {
  Object.assign(process.env, discreteGpuEnv());
}

function isJavaLaunch(command) {
  const c = String(command || '').toLowerCase().replace(/\\/g, '/');
  return c.endsWith('/java.exe') || c.endsWith('/javaw.exe') || c === 'java' || c === 'javaw';
}

/**
 * minecraft-launcher-core не передаёт env в spawn — подменяем только для java.exe.
 */
async function withJavaOnDiscreteGpu(run) {
  if (process.platform !== 'win32') {
    return run();
  }

  const gpuEnv = discreteGpuEnv();
  const originalSpawn = cp.spawn;
  cp.spawn = function patchedSpawn(command, args, options) {
    if (isJavaLaunch(command)) {
      const opts = options && typeof options === 'object' ? { ...options } : {};
      opts.env = { ...process.env, ...gpuEnv, ...(opts.env || {}) };
      return originalSpawn.call(cp, command, args, opts);
    }
    return originalSpawn.call(cp, command, args, options);
  };

  try {
    return await run();
  } finally {
    cp.spawn = originalSpawn;
  }
}

module.exports = {
  discreteGpuEnv,
  applyDiscreteGpuToProcessEnv,
  withJavaOnDiscreteGpu
};
