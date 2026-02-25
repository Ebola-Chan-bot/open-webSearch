import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { getSharedBrowser, destroySharedBrowser } from '../shared/browser.js';

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

let bingWarmedUp = false;

/**
 * 预热请求：先访问 cn.bing.com 建立有效的搜索会话。
 * cn.bing.com 对多词中文查询需要有效的会话 cookie，
 * 否则会返回随机的无关内容。
 */
async function warmUpBingSession(): Promise<void> {
    if (bingWarmedUp) return;
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    try {
        await page.goto('https://cn.bing.com/search?q=test', { waitUntil: 'networkidle2', timeout: 15000 });
        await new Promise(r => setTimeout(r, 500));
        bingWarmedUp = true;
    } finally {
        await page.close();
    }
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    try {
        await warmUpBingSession();
        const browser = await getSharedBrowser();

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
    } catch (err) {
        bingWarmedUp = false;
        destroySharedBrowser();
        throw err;
    }
}
