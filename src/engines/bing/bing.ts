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

function parsePageResults(html: string): SearchResult[] {
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
    return results;
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    try {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();

        try {
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, 500));
            let allResults = parsePageResults(await page.content());

            while (allResults.length < limit) {
                const nextLink = await page.$('.sb_pagN');
                if (!nextLink) break;
                // Bing 翻页可能用完整导航或 AJAX，两种方式都要兼容
                const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                await nextLink.click();
                await navPromise;
                await new Promise(r => setTimeout(r, 1000));
                const pageResults = parsePageResults(await page.content());
                if (pageResults.length === 0) break;
                allResults = allResults.concat(pageResults);
            }

            return allResults.slice(0, limit);
        } finally {
            await page.close();
        }
    } catch (err) {
        destroySharedBrowser();
        throw err;
    }
}
