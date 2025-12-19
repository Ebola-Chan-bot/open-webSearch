import axios from 'axios';
import * as cheerio from 'cheerio';
import { SearchResult } from '../../types.js';

export async function searchBing(query: string, limit: number): Promise<SearchResult[]> {
    let allResults: SearchResult[] = [];
    let pn = 0;

    while (allResults.length < limit) {
        const response = await axios.get('https://www.bing.com/search', {
            params: {
                q: query,
                first: 1 + pn * 10
            },
            headers: {
                // 仅保留必要的头，避免使用硬编码 Cookie/Host 等触发不可控的个性化/实验流量
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
        });

        const $ = cheerio.load(response.data);
        const results: SearchResult[] = [];

        $('#b_content').children()
            .find('#b_results').children()
            .each((i, element) => {
                const titleElement = $(element).find('h2');
                const linkElement = $(element).find('a');
                const snippetElement = $(element).find('p').first();

                if (titleElement.length && linkElement.length) {
                    const url = linkElement.attr('href');
                    if (url && url.startsWith('http')) {

                        const sourceElement = $(element).find('.b_tpcn');
                        results.push({
                            title: titleElement.text(),
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

    return allResults.slice(0, limit); // 截取最多 limit 个
}
