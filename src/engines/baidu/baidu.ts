import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';
import { getSharedBrowser, destroySharedBrowser } from '../shared/browser.js';

export async function searchBaidu(query: string, limit: number): Promise<SearchResult[]> {
    try {
        const browser = await getSharedBrowser();
        let allResults: SearchResult[] = [];
        let pn = 0;

        while (allResults.length < limit) {
            const page = await browser.newPage();

            // 通过 CDP 隐藏 webdriver/自动化特征，绕过百度反爬检测
            const client = await page.createCDPSession();
            await client.send('Page.addScriptToEvaluateOnNewDocument', {
                source: `
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    delete navigator.__proto__.webdriver;
                `
            });

            const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&pn=${pn}&ie=utf-8`;

            await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
            await new Promise(r => setTimeout(r, 1000));

            const html = await page.content();
            await page.close();

            const $ = cheerio.load(html);

            // 检测百度安全验证页面
            const title = $('title').text();
            if (title.includes('安全验证')) {
                console.error('⚠️ Baidu security verification detected, no results for this page.');
                break;
            }

            const results: SearchResult[] = [];

            $('#content_left').children().each((i, element) => {
                const titleElement = $(element).find('h3');
                const linkElement = $(element).find('a');
                const snippetElement = $(element).find('.cos-row').first();

                if (titleElement.length && linkElement.length) {
                    const url = linkElement.attr('href');
                    if (url && url.startsWith('http')) {
                        const snippetElementBaidu = $(element).find('.c-font-normal.c-color-text').first();
                        const sourceElement = $(element).find('.cosc-source');
                        results.push({
                            title: titleElement.text(),
                            url: url,
                            description: snippetElementBaidu.attr('aria-label') || snippetElement.text().trim() || '',
                            source: sourceElement.text().trim() || '',
                            engine: 'baidu'
                        });
                    }
                }
            });

            allResults = allResults.concat(results);

            if (results.length === 0) {
                console.error('⚠️ No more results, ending early....');
                break;
            }

            pn += 10;
        }

        return allResults.slice(0, limit);
    } catch (err) {
        destroySharedBrowser();
        throw err;
    }
}
