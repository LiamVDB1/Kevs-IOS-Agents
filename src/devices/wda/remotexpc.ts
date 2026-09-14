import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RemoteXpcPortForwarder {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface RemoteXpcWdaRuntime {
    createPortForwarder(localPort: number, devicePort: number, udid: string): Promise<RemoteXpcPortForwarder>;
    launchRunner(udid: string, bundleId: string, environment: Record<string, string>): Promise<void>;
    terminateRunner(udid: string, bundleId: string): Promise<void>;
}

type RemoteXpcModule = {
    DevicePortForwarder: new (
        localPort: number,
        devicePort: number,
        options: {
            primaryConnector: () => Promise<unknown>;
            fallbackConnector?: () => Promise<unknown>;
        },
    ) => RemoteXpcPortForwarder;
    connectViaTunnel(udid: string, devicePort: number): Promise<unknown>;
    connectViaUsbmux(udid: string, devicePort: number): Promise<unknown>;
    Services: {
        startDVTService(udid: string): Promise<{
            dvtService: { close(): Promise<void> | void };
            processControl: {
                launch(options: {
                    bundleId: string;
                    environment: Record<string, string>;
                    killExisting: boolean;
                }): Promise<unknown>;
                getPidForBundleIdentifier(bundleId: string): Promise<number | null | undefined>;
                kill(pid: number): Promise<unknown>;
            };
        }>;
    };
};

let modulePromise: Promise<RemoteXpcModule> | undefined;

async function loadRemoteXpcModule(): Promise<RemoteXpcModule> {
    modulePromise ??= (async () => {
        const driverPath = path.resolve(process.env.XCUITEST_DRIVER_PATH
            ?? '.appium2/node_modules/appium-xcuitest-driver');
        const packageRoot = path.join(driverPath, 'node_modules/appium-ios-remotexpc');
        const packageJsonPath = path.join(packageRoot, 'package.json');
        try {
            const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { main?: string };
            const entrypoint = path.join(packageRoot, packageJson.main ?? 'build/src/index.js');
            return await import(pathToFileURL(entrypoint).href) as RemoteXpcModule;
        } catch (error) {
            throw new Error(
                `appium-ios-remotexpc is unavailable under ${driverPath}. `
                + 'Install the current XCUITest driver before using WDA_BACKEND=remotexpc.',
                { cause: error },
            );
        }
    })();
    return modulePromise;
}

export const defaultRemoteXpcWdaRuntime: RemoteXpcWdaRuntime = {
    async createPortForwarder(localPort, devicePort, udid) {
        const remoteXpc = await loadRemoteXpcModule();
        return new remoteXpc.DevicePortForwarder(localPort, devicePort, {
            primaryConnector: () => remoteXpc.connectViaTunnel(udid, devicePort),
            fallbackConnector: () => remoteXpc.connectViaUsbmux(udid, devicePort),
        });
    },
    async launchRunner(udid, bundleId, environment) {
        const remoteXpc = await loadRemoteXpcModule();
        const dvt = await remoteXpc.Services.startDVTService(udid);
        try {
            await dvt.processControl.launch({
                bundleId,
                environment,
                killExisting: true,
            });
        } finally {
            await dvt.dvtService.close();
        }
    },
    async terminateRunner(udid, bundleId) {
        const remoteXpc = await loadRemoteXpcModule();
        const dvt = await remoteXpc.Services.startDVTService(udid);
        try {
            const pid = await dvt.processControl.getPidForBundleIdentifier(bundleId);
            if (pid) await dvt.processControl.kill(pid);
        } finally {
            await dvt.dvtService.close();
        }
    },
};

export class RemoteXpcWdaSupervisor {
    private wdaForwarder?: RemoteXpcPortForwarder;
    private mjpegForwarder?: RemoteXpcPortForwarder;
    private started = false;

    constructor(private readonly options: {
        udid: string;
        runnerBundleId: string;
        wdaLocalPort: number;
        wdaRemotePort: number;
        mjpegLocalPort: number;
        mjpegRemotePort: number;
        launchEnvironment: Record<string, string>;
        runtime?: RemoteXpcWdaRuntime;
    }) {}

    async start(): Promise<void> {
        if (this.started) return;
        const runtime = this.options.runtime ?? defaultRemoteXpcWdaRuntime;
        this.wdaForwarder = await runtime.createPortForwarder(
            this.options.wdaLocalPort,
            this.options.wdaRemotePort,
            this.options.udid,
        );
        this.mjpegForwarder = await runtime.createPortForwarder(
            this.options.mjpegLocalPort,
            this.options.mjpegRemotePort,
            this.options.udid,
        );
        try {
            await this.wdaForwarder.start();
            await this.mjpegForwarder.start();
            await runtime.launchRunner(
                this.options.udid,
                this.options.runnerBundleId,
                this.options.launchEnvironment,
            );
            this.started = true;
        } catch (error) {
            await this.stopForwarders();
            throw error;
        }
    }

    async stop(): Promise<void> {
        const runtime = this.options.runtime ?? defaultRemoteXpcWdaRuntime;
        if (this.started) {
            await runtime.terminateRunner(this.options.udid, this.options.runnerBundleId).catch(() => undefined);
        }
        this.started = false;
        await this.stopForwarders();
    }

    private async stopForwarders(): Promise<void> {
        const mjpeg = this.mjpegForwarder;
        const wda = this.wdaForwarder;
        this.mjpegForwarder = undefined;
        this.wdaForwarder = undefined;
        if (mjpeg) await mjpeg.stop().catch(() => undefined);
        if (wda) await wda.stop().catch(() => undefined);
    }
}
