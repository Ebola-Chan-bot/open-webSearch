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
                "authority": "www.bing.com",
                "ect": "3g",
                "pragma": "no-cache",
                "sec-ch-ua-arch": "\"x86\"",
                "sec-ch-ua-bitness": "\"64\"",
                "sec-ch-ua-full-version": "\"112.0.5615.50\"",
                "sec-ch-ua-full-version-list": "\"Chromium\";v=\"112.0.5615.50\", \"Google Chrome\";v=\"112.0.5615.50\", \"Not:A-Brand\";v=\"99.0.0.0\"",
                "sec-ch-ua-model": "\"\"",
                "sec-ch-ua-platform-version": "\"15.0.0\"",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                "Cookie": "_EDGE_V=1; MUID=3727DBB14FD763511D80CDBD4ED262EF; MSPTC=5UlNf4UsLqV53oFqqdHiR26FwDDL8zSW3kC74kIJQfM; _EDGE_S=SID=132F08F578E06F832D931EE779E16E2D; MUIDB=3727DBB14FD763511D80CDBD4ED262EF; SRCHD=AF=NOFORM; SRCHUID=V=2&GUID=B3AFD0E41DB649E39803C690946C3B65&dmnchg=1; ak_bmsc=578AE2B7DA55FA9F332ADCDFBA0B9B64~000000000000000000000000000000~YAAQZCg0F9XLkYGXAQAAjywwkhxcD6Pm2nguBmpB14hnmCR3kz9Mfau5cZ7pwHxdU2Uog9+6hOkBmzpOV3UoTOhi52nB725xM7zN90mRDv0zQtJdO/llaKlt2zqTmB4F5kd+GzPjXLAN4Zmj4KwpAjLK1T4TexH/9WlQTkRamdJTKuR47IZWHHebqsbNqHoYncHhxICO9Rnu51vhlps/rrhPBtgPgbrQnDfr6YzAQWmSqc5g9hk03sM9nnWUyVbRV0ZVsgke7BCYX5V1JD5L0Zf8/FWdntBpjpd2IcmehBz38ChGThPrBEWNCZQbCS6lE4OaQanrrdmBHf/r5YEf2LeIqZy0bJGIiSQaSh6d7KFO2haTQk/JscZAs+V5kNsAOxIGreRve+E=; _UR=QS=0&TQS=0&Pn=0; BFBUSR=BFBHP=0; SRCHUSR=DOB=20250621&DS=1; _Rwho=u=d&ts=2025-06-21; ipv6=hit=1750507922628&t=4; BFPRResults=FirstPageUrls=C5E678E900F98310F0D3DB1F3EB96D99%2CB5A20FAE72B0C3019A56409EAC7AF3FB%2C7A44A77FF42EDF11CC9BF5CFE08B179A%2C6ED615E5E634BD5AFC7BB2A0A77F8FF8%2CA993E7AAF4890BEC06882621CA376D00%2C49CF0FC3C203D5E918A76258506B0CF4%2C7F03D5026C1D046F66B11D525095BF8B%2C058BB67A6B7F15E58D3A19B897BC57F8%2C1B886024FDE703428D24A41AFA1E62AF%2C5A8B56DC0AE03A8B94643DEA2A22DBAC&FPIG=05F126AA95514CF5AD5E33E4AEBA474D; _HPVN=CS=eyJQbiI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiUCJ9LCJTYyI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiSCJ9LCJReiI6eyJDbiI6MSwiU3QiOjAsIlFzIjowLCJQcm9kIjoiVCJ9LCJBcCI6dHJ1ZSwiTXV0ZSI6dHJ1ZSwiTGFkIjoiMjAyNS0wNi0yMVQwMDowMDowMFoiLCJJb3RkIjowLCJHd2IiOjAsIlRucyI6MCwiRGZ0IjpudWxsLCJNdnMiOjAsIkZsdCI6MCwiSW1wIjoxNSwiVG9ibiI6MH0=; _C_ETH=1; _RwBf=r=0&ilt=15&ihpd=1&ispd=14&rc=36&rb=0&rg=200&pc=36&mtu=0&rbb=0&clo=0&v=15&l=2025-06-21T07:00:00.0000000Z&lft=0001-01-01T00:00:00.0000000&aof=0&ard=0001-01-01T00:00:00.0000000&rwdbt=0&rwflt=0&rwaul2=0&g=&o=2&p=&c=&t=0&s=0001-01-01T00:00:00.0000000+00:00&ts=2025-06-21T11:36:08.7064260+00:00&rwred=0&wls=&wlb=&wle=&ccp=&cpt=&lka=0&lkt=0&aad=0&TH=&cid=0&gb=; _SS=SID=132F08F578E06F832D931EE779E16E2D&R=36&RB=0&GB=0&RG=200&RP=36; SRCHHPGUSR=SRCHLANG=zh-Hans&IG=63A0A44F5D2F4499AD165A366D073C03&DM=0&BRW=N&BRH=T&CW=1202&CH=1289&SCW=1185&SCH=2279&DPR=1.0&UTC=480&HV=1750505768&HVE=notFound&WTS=63886101120&PV=15.0.0&PRVCW=1202&PRVCH=1289&EXLTT=13; SRCHHPGUSR=SRCHLANG=en&IG=9A53F826E9C9432497327CA995144E14&DM=0&BRW=N&BRH=T&CW=1202&CH=1289&SCW=1185&SCH=2279&DPR=1.0&UTC=480&HV=1750505768&HVE=notFound&WTS=63886101120&PV=15.0.0&PRVCW=1202&PRVCH=1289&EXLTT=13",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Host": "cn.bing.com",
                "Connection": "keep-alive"
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
