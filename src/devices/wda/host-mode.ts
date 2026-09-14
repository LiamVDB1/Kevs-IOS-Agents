export type WdaBackend = 'xcode' | 'remotexpc';

export function resolveWdaBackend(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): WdaBackend {
    const configured = env.WDA_BACKEND?.trim().toLowerCase();
    if (configured) {
        if (configured === 'xcode' || configured === 'remotexpc') return configured;
        throw new Error(`WDA_BACKEND must be "xcode" or "remotexpc"; received ${env.WDA_BACKEND}`);
    }
    return platform === 'darwin' ? 'xcode' : 'remotexpc';
}

export function resolveWdaRunnerBundleId(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.WDA_RUNNER_BUNDLE_ID?.trim();
    if (explicit) return explicit;
    const base = env.WDA_BUNDLE_ID?.trim();
    if (!base) throw new Error('WDA_BUNDLE_ID is required to derive the preinstalled WDA runner bundle id');
    return base.endsWith('.xctrunner') ? base : `${base}.xctrunner`;
}

export function remoteXpcLaunchEnvironment({
    wdaRemotePort,
    mjpegRemotePort,
    env = process.env,
}: {
    wdaRemotePort: number;
    mjpegRemotePort: number;
    env?: NodeJS.ProcessEnv;
}): Record<string, string> {
    return {
        USE_PORT: String(wdaRemotePort),
        MJPEG_SERVER_PORT: String(mjpegRemotePort),
        MJPEG_SCALING_FACTOR: env.MJPEG_SCALING_FACTOR ?? '40',
        MJPEG_SERVER_SCREENSHOT_QUALITY: env.MJPEG_SERVER_SCREENSHOT_QUALITY ?? '25',
    };
}
