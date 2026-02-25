/**
 * 全局共享的 Puppeteer 浏览器管理模块。
 * 所有需要真实浏览器环境的搜索引擎（Bing、Baidu 等）共用同一个浏览器实例。
 */
import puppeteer, { type Browser } from 'puppeteer-core';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';

let cachedBrowserPath: string | null = null;

function getBrowserPath(): string {
    if (cachedBrowserPath) return cachedBrowserPath;

    const candidates: string[] = [];

    // Windows 硬编码常见路径（MCP 环境下环境变量可能缺失时的后备方案）
    candidates.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
    candidates.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

    // 基于环境变量的路径
    const pf86 = process.env['PROGRAMFILES(X86)'];
    const pf = process.env['PROGRAMFILES'];
    const localAppData = process.env['LOCALAPPDATA'];
    if (pf86) {
        candidates.push(pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe');
        candidates.push(pf86 + '\\Google\\Chrome\\Application\\chrome.exe');
    }
    if (pf) {
        candidates.push(pf + '\\Microsoft\\Edge\\Application\\msedge.exe');
        candidates.push(pf + '\\Google\\Chrome\\Application\\chrome.exe');
    }
    if (localAppData) {
        candidates.push(localAppData + '\\Google\\Chrome\\Application\\chrome.exe');
    }

    // Linux/macOS 路径
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');

    const unique = [...new Set(candidates)];
    for (const p of unique) {
        if (existsSync(p)) {
            console.error(`[browser] Found browser: ${p}`);
            cachedBrowserPath = p;
            return p;
        }
    }
    throw new Error('未找到 Chromium 内核浏览器，请安装 Chrome 或 Edge。');
}

/** 查找可用的 TCP 端口 */
function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') {
                const port = addr.port;
                srv.close(() => resolve(port));
            } else {
                srv.close(() => reject(new Error('Could not determine port')));
            }
        });
        srv.on('error', reject);
    });
}

interface BrowserSession {
    browser: Browser;
    tempDir: string;
    browserPid?: number;
}

let cachedSession: BrowserSession | null = null;
let cleanupRegistered = false;

async function launchBrowser(): Promise<BrowserSession> {
    const browserPath = getBrowserPath();
    const tempDir = mkdtempSync(join(tmpdir(), 'mcp-search-'));
    const port = await findFreePort();

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        // 使用 GUI 模式（非 headless）以避免 Bing 等搜索引擎的反自动化检测，
        // 通过将窗口移到屏幕外来隐藏
        '--window-position=-32000,-32000',
        '--window-size=1,1',
    ];

    console.error(`[browser] Spawning browser on port ${port}, profile: ${tempDir}`);

    let browserPid: number | undefined;

    if (process.platform === 'win32') {
        // 通过 WMI 启动浏览器，使用 Win32_ProcessStartup 的 ShowWindow=0 (SW_HIDE)
        // 使窗口完全不可见，用户不会看到弹出的浏览器窗口
        const cmdLine = `"${browserPath}" ${args.join(' ')}`;
        const psScript = [
            `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}`,
            `; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create`,
            `-Arguments @{CommandLine='${cmdLine.replace(/'/g, "''")}'; ProcessStartupInformation=$si}`,
            `; if($r.ReturnValue -eq 0){$r.ProcessId}else{throw "WMI error: $($r.ReturnValue)"}`,
        ].join(' ');
        try {
            const output = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', psScript,
            ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            browserPid = parseInt(output.trim());
            console.error(`[browser] Browser started via WMI, PID: ${browserPid}`);
        } catch (err: any) {
            try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
            throw new Error(`通过 WMI 启动浏览器失败: ${err.message}`);
        }
    } else {
        const child = spawn(browserPath, args, {
            stdio: 'ignore',
            detached: true,
        });
        child.on('error', () => {});
        child.unref();
        browserPid = child.pid;
    }

    const debugUrl = `http://127.0.0.1:${port}/json/version`;
    let wsUrl: string | null = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const resp = await fetch(debugUrl, { signal: controller.signal });
            const data = await resp.json() as { webSocketDebuggerUrl?: string };
            if (data.webSocketDebuggerUrl) {
                wsUrl = data.webSocketDebuggerUrl;
                break;
            }
        } catch {
            // 浏览器尚未就绪或请求超时
        } finally {
            clearTimeout(timeoutId);
        }
    }

    if (!wsUrl) {
        if (browserPid) try { process.kill(browserPid); } catch {}
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        throw new Error('浏览器启动失败：无法获取 WebSocket URL');
    }

    console.error(`[browser] Browser ready, connecting via ${wsUrl}`);
    try {
        const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        return { browser, tempDir, browserPid };
    } catch (err) {
        if (browserPid) try { process.kill(browserPid); } catch {}
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        throw err;
    }
}

function cleanupSession(session: BrowserSession) {
    try { session.browser.disconnect(); } catch {}
    if (session.browserPid) try { process.kill(session.browserPid); } catch {}
    try { rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
}

/** 获取或复用全局共享的浏览器实例 */
export async function getSharedBrowser(): Promise<Browser> {
    if (cachedSession) {
        try {
            await cachedSession.browser.version();
            return cachedSession.browser;
        } catch {
            console.error('[browser] Cached browser session is dead, relaunching...');
            cleanupSession(cachedSession);
            cachedSession = null;
        }
    }

    const session = await launchBrowser();
    cachedSession = session;

    if (!cleanupRegistered) {
        cleanupRegistered = true;
        const cleanup = () => {
            if (cachedSession) {
                cleanupSession(cachedSession);
                cachedSession = null;
            }
        };
        process.once('exit', cleanup);
        process.once('SIGINT', cleanup);
        process.once('SIGTERM', cleanup);
    }

    return cachedSession.browser;
}

/** 销毁全局浏览器会话（搜索出错时调用，下次会重新启动） */
export function destroySharedBrowser(): void {
    if (cachedSession) {
        cleanupSession(cachedSession);
        cachedSession = null;
    }
}
