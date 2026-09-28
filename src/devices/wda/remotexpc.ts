import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const BACKGROUNDING_APP = 'com.apple.Preferences';

export interface RemoteXpcPortForwarder {
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** A live XCTest session hosting WDA; closing it ends the session and the runner. */
export interface RemoteXpcRunnerSession {
    close(): Promise<void>;
}

export interface RemoteXpcWdaRuntime {
    createPortForwarder(localPort: number, devicePort: number, udid: string): Promise<RemoteXpcPortForwarder>;
    launchRunner(udid: string, bundleId: string, environment: Record<string, string>): Promise<RemoteXpcRunnerSession | void>;
    terminateRunner(udid: string, bundleId: string): Promise<void>;
}

type RemoteXpcXcTestRunner = {
    setupAndLaunch(): Promise<void>;
    close(): Promise<void>;
};

type RemoteXpcModule = {
    createXCTestRunner(options: {
        udid: string;
        testRunnerBundleId: string;
        xctestBundleId: string;
        appUnderTestBundleId: string;
        launchEnvironment: Record<string, string>;
        killExisting: boolean;
    }): RemoteXpcXcTestRunner;
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
    // A plain process launch starts the runner app without a testmanagerd test
    // session, so the WDA test never runs and :8100 never opens. Open the same
    // XCTest session Xcode would and keep it alive for as long as WDA serves.
    async launchRunner(udid, bundleId, environment) {
        const remoteXpc = await loadRemoteXpcModule();
        const runner = remoteXpc.createXCTestRunner({
            udid,
            testRunnerBundleId: bundleId,
            xctestBundleId: bundleId.replace(/\.xctrunner$/, ''),
            appUnderTestBundleId: bundleId,
            launchEnvironment: environment,
            killExisting: true,
        });
        try {
            await runner.setupAndLaunch();
            // With the Xcode 27 test stack the runner no longer backgrounds
            // itself and XCTest aborts after 30s ("Failed to background test
            // runner"). Foregrounding any other app satisfies that wait.
            await delay(3_000);
            const dvt = await remoteXpc.Services.startDVTService(udid);
            try {
                await dvt.processControl.launch({ bundleId: BACKGROUNDING_APP, environment: {}, killExisting: false });
            } finally {
                await dvt.dvtService.close();
            }
        } catch (error) {
            await runner.close().catch(() => undefined);
            throw error;
        }
        return { close: () => runner.close() };
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
    private session?: RemoteXpcRunnerSession;
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
            this.session = await runtime.launchRunner(
                this.options.udid,
                this.options.runnerBundleId,
                this.options.launchEnvironment,
            ) ?? undefined;
            this.started = true;
        } catch (error) {
            await this.stopForwarders();
            throw error;
        }
    }

    async stop(): Promise<void> {
        const runtime = this.options.runtime ?? defaultRemoteXpcWdaRuntime;
        const session = this.session;
        this.session = undefined;
        if (session) {
            await session.close().catch(() => undefined);
        } else if (this.started) {
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
