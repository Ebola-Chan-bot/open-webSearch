import puppeteer, { type Browser } from 'puppeteer-core';
import * as cheerio from 'cheerio';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
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

async function launchBrowser(): Promise<{ browser: Browser; tempDir: string; childProc: ChildProcess }> {
    const browserPath = getBrowserPath();
    const tempDir = mkdtempSync(join(tmpdir(), 'bing-search-'));
    const port = await findFreePort();

    console.error(`[bing] Spawning browser on port ${port}, profile: ${tempDir}`);

    // 手动启动浏览器进程，完全隔离 stdio，
    // 避免与 MCP 服务器的管道化 stdin/stdout 冲突。
    const childProc = spawn(browserPath, [
        `--remote-debugging-port=${port}`,
        '--headless=new',
        `--user-data-dir=${tempDir}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
    ], {
        stdio: ['ignore', 'ignore', 'pipe'],  // 仅保留 stderr
        detached: false,
        windowsHide: true,
    });

    // 轮询调试端点，等待浏览器就绪
    const debugUrl = `http://127.0.0.1:${port}/json/version`;
    let wsUrl: string | null = null;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        try {
            const resp = await fetch(debugUrl);
            const data = await resp.json() as { webSocketDebuggerUrl?: string };
            if (data.webSocketDebuggerUrl) {
                wsUrl = data.webSocketDebuggerUrl;
                break;
            }
        } catch {
            // 浏览器尚未就绪
        }
    }

    if (!wsUrl) {
        childProc.kill();
        throw new Error('浏览器启动失败：无法获取 WebSocket URL');
    }

    console.error(`[bing] Browser ready, connecting via ${wsUrl}`);
    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
    return { browser, tempDir, childProc };
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
    const { browser, tempDir, childProc } = await launchBrowser();

    try {
        // 预热会话，从 cn.bing.com 获取有效 cookie
        await warmUpSession(browser);

        let allResults: SearchResult[] = [];
        let pn = 0;

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
    } finally {
        await browser.close().catch(() => {});
        childProc.kill();
        // 清理临时配置文件目录
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
}
