import puppeteer, { type Browser } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';
import { SearchResult } from '../../types.js';

/**
 * 解码 Bing 重定向 URL，提取实际目标地址。
 * Bing URL 格式: https://www.bing.com/ck/a?...&u=a1<Base64编码的URL>
 * 参数 'u' 的值以 'a1' 开头，后接 Base64 编码的原始 URL。
 */
function decodeBingUrl(bingUrl: string): string {
    try {
        const url = new URL(bingUrl);
        const encodedUrl = url.searchParams.get('u');
        if (!encodedUrl) {
            return bingUrl;
        }
        const base64Part = encodedUrl.substring(2);
        const decodedUrl = Buffer.from(base64Part, 'base64').toString('utf-8');
        if (decodedUrl.startsWith('http')) {
            return decodedUrl;
        }
        return bingUrl;
    } catch {
        return bingUrl;
    }
}

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

    // 去重
    const unique = [...new Set(candidates)];
    for (const p of unique) {
        if (existsSync(p)) {
            console.error(`[bing] Found browser: ${p}`);
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

/** 缓存的浏览器会话，跨搜索复用 */
let cachedSession: { browser: Browser; tempDir: string; browserPid?: number; warmedUp: boolean } | null = null;

async function launchBrowser(): Promise<{ browser: Browser; tempDir: string; browserPid?: number }> {
    const browserPath = getBrowserPath();
    const tempDir = mkdtempSync(join(tmpdir(), 'bing-search-'));
    const port = await findFreePort();

    const args = [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
    ];

    console.error(`[bing] Spawning browser on port ${port}, profile: ${tempDir}`);

    let browserPid: number | undefined;

    if (process.platform === 'win32') {
        // Windows: 通过 WMI (Win32_Process.Create) 创建浏览器进程。
        // VS Code 的 MCP 服务器环境使用 Job Object 管控子进程，
        // 导致 spawn/exec 创建的浏览器被立即终止（退出码 0）。
        // WMI 创建的进程完全独立于父进程的 Job Object，不受此限制。
        const cmdLine = `"${browserPath}" ${args.join(' ')}`;
        const psScript = [
            `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create`,
            `-Arguments @{CommandLine='${cmdLine.replace(/'/g, "''")}'}`,
            `; if($r.ReturnValue -eq 0){$r.ProcessId}else{throw "WMI error: $($r.ReturnValue)"}`,
        ].join(' ');
        try {
            const output = execFileSync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command', psScript,
            ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            browserPid = parseInt(output.trim());
            console.error(`[bing] Browser started via WMI, PID: ${browserPid}`);
        } catch (err: any) {
            try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
            throw new Error(`通过 WMI 启动浏览器失败: ${err.message}`);
        }
    } else {
        // Linux/macOS: 直接启动浏览器
        const child = spawn(browserPath, args, {
            stdio: 'ignore',
            detached: true,
        });
        // [Copilot review #6] 监听 error 事件，避免 spawn 失败（如 ENOENT）时
        // 未处理的 error 事件导致进程崩溃
        child.on('error', () => {});
        child.unref();
        browserPid = child.pid;
    }

    // [Copilot review #2] Copilot 建议用 --remote-debugging-port=0 + stderr 解析取代端口轮询，
    // 但当前架构（Windows WMI / Linux detached spawn）均无法获取 stderr，只能轮询。
    const debugUrl = `http://127.0.0.1:${port}/json/version`;
    let wsUrl: string | null = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        // [Copilot review #3] 为每次 fetch 添加超时，避免端口被劫持或连接卡住时
        // 单次请求无限挂起，使 30 次重试上限失效。
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

    console.error(`[bing] Browser ready, connecting via ${wsUrl}`);
    // [Copilot review #7] puppeteer.connect 失败时清理子进程和临时目录，
    // 避免 launchBrowser 抛出后调用方无法清理的资源泄漏
    try {
        const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        return { browser, tempDir, browserPid };
    } catch (err) {
        if (browserPid) try { process.kill(browserPid); } catch {}
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        throw err;
    }
}

/** 获取或复用浏览器会话 */
async function getBrowser(): Promise<{ browser: Browser; tempDir: string; browserPid?: number }> {
    // 检查已缓存的浏览器是否仍然可用
    if (cachedSession) {
        try {
            // 尝试获取版本信息来验证连接是否正常
            await cachedSession.browser.version();
            return cachedSession;
        } catch {
            console.error('[bing] Cached browser session is dead, relaunching...');
            cleanupSession(cachedSession);
            cachedSession = null;
        }
    }

    const session = await launchBrowser();
    cachedSession = { ...session, warmedUp: false };

    // 进程退出时清理浏览器
    const cleanup = () => {
        if (cachedSession) {
            cleanupSession(cachedSession);
            cachedSession = null;
        }
    };
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    return cachedSession;
}

function cleanupSession(session: { browser: Browser; tempDir: string; browserPid?: number }) {
    try { session.browser.close(); } catch {}
    if (session.browserPid) try { process.kill(session.browserPid); } catch {}
    try { rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
}

/**
 * 预热请求：先访问 cn.bing.com 建立有效的搜索会话。
 * cn.bing.com 对多词中文查询需要有效的会话 cookie，
 * 否则会返回随机的无关内容。
 */
async function warmUpSession(browser: Browser): Promise<void> {
    const page = await browser.newPage();
    try {
        await page.goto('https://cn.bing.com/search?q=test', { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 500));
    } finally {
        await page.close();
    }
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    const { browser } = await getBrowser();

    try {
        // 首次使用时预热会话，从 cn.bing.com 获取有效 cookie
        if (cachedSession && !cachedSession.warmedUp) {
            await warmUpSession(browser);
            cachedSession.warmedUp = true;
        }

        let allResults: SearchResult[] = [];
        let pn = 0;

        // [Copilot review #1] Copilot 建议为每个 page 添加 try/finally，
        // 但异常会直接传播到外层 finally 的 browser.close()，所有页面随之销毁，无需单独处理。
        // [Copilot review #4] Copilot 建议按环境变量条件化 --no-sandbox，
        // 但 --no-sandbox 是 headless 自动化的标准做法，且 Docker 容器内通常需要，条件化会增加复杂度。
        // [Copilot review #5] Copilot 建议 kill() 添加 try/catch，
        // 当前代码已使用 try { process.kill(browserPid); } catch {} 容错处理。
        while (allResults.length < limit) {
            const page = await browser.newPage();

            const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&first=${1 + pn * 10}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, 1000));

            const html = await page.content();
            await page.close();

            const $ = cheerio.load(html);
            const results: SearchResult[] = [];

            $('#b_results h2').each((i, element) => {
                const linkElement = $(element).find('a').first();
                if (linkElement.length) {
                    const rawUrl = linkElement.attr('href');
                    if (rawUrl && rawUrl.startsWith('http')) {
                        const url = decodeBingUrl(rawUrl);
                        const parentLi = $(element).closest('li');
                        const snippetElement = parentLi.find('p').first();
                        const sourceElement = parentLi.find('.b_tpcn');

                        results.push({
                            title: linkElement.text().trim(),
                            url: url,
                            description: snippetElement.text().trim() || '',
                            source: sourceElement.text().trim() || '',
                            engine: 'bing'
                        });
                    }
                }
            });

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.error('⚠️ No more results, ending early....');
                break;
            }

            pn += 1;
        }

        return allResults.slice(0, limit);
    } catch (err) {
        // 搜索出错时销毁缓存的浏览器会话，下次重新启动
        if (cachedSession) {
            cleanupSession(cachedSession);
            cachedSession = null;
        }
        throw err;
    }
}
