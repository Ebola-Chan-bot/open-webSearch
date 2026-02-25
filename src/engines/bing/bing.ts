import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { getSharedBrowser, destroySharedBrowser } from '../shared/browser.js';
import type { Page } from 'puppeteer-core';

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

/**
 * 通过 Bing 搜索框提交查询。
 * Bing 会对直接 URL 导航返回降级的搜索结果（尤其对 "MCP" 等缩写词），
 * 但通过搜索框表单提交（带 form=QBLH 参数）则能得到正确结果。
 */
async function submitSearchViaSearchBox(page: Page, query: string): Promise<void> {
    await page.goto('https://www.bing.com', { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 500));
    // 清空搜索框（可能有残留内容）并输入查询
    const searchBox = await page.$('#sb_form_q');
    if (searchBox) {
        await searchBox.click({ clickCount: 3 }); // 选中全部
        await page.keyboard.press('Backspace');    // 删除
    }
    await page.type('#sb_form_q', query, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 500));
}

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    try {
        const browser = await getSharedBrowser();
        const page = await browser.newPage();

        try {
            // 第一页：通过搜索框提交
            await submitSearchViaSearchBox(page, query);
            let allResults = parsePageResults(await page.content());

            // 后续页：在已有 session 中直接翻页
            while (allResults.length < limit) {
                const nextLink = await page.$('.sb_pagN');
                if (!nextLink) break;
                await nextLink.click();
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
                await new Promise(r => setTimeout(r, 500));
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
