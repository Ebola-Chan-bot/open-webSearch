import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { __setBingHttpGetForTests, searchBing } from '../engines/bing/index.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function makeResponse(status: number, headers: Record<string, string>, data: string): AxiosResponse {
    return {
        status,
        statusText: String(status),
        headers,
        data,
        config: {} as AxiosResponse['config']
    };
}

const resultHtml = `
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://example.com/result">Regional result</a></h2>
    <div class="b_caption"><p>Result returned after regional routing.</p></div>
  </li>
</ol>`;

async function testDirectRegionalEndpoint(): Promise<void> {
    const requestedUrls: string[] = [];
    __setBingHttpGetForTests(async (url: string, options: AxiosRequestConfig) => {
        requestedUrls.push(url);
        assert(options.maxRedirects === 0, 'Bing must keep automatic redirects disabled');
        return makeResponse(200, {}, resultHtml);
    });

    try {
        const results = await searchBing('test', 1, { searchMode: 'request' });
        assert(results.length === 1, 'direct regional endpoint should return one result');
        assert(requestedUrls.length === 1, 'direct regional endpoint should require one request');
        assert(new URL(requestedUrls[0]).hostname === 'cn.bing.com', 'Bing should retain the China endpoint as its initial regional route');
    } finally {
        __setBingHttpGetForTests();
    }

    console.log('✅ Bing keeps the direct regional endpoint when it returns 200');
}

async function testAllowedRegionalRedirect(): Promise<void> {
    const requestedUrls: string[] = [];
    __setBingHttpGetForTests(async (url: string, options: AxiosRequestConfig) => {
        requestedUrls.push(url);
        assert(options.maxRedirects === 0, 'Bing regional routing must be handled explicitly');
        if (requestedUrls.length === 1) {
            assert(options.validateStatus?.(301) === true, 'Bing request should expose regional redirects to the caller');
            return makeResponse(301, {
                location: 'https://www.bing.com/?q=test&setlang=zh-CN&ensearch=0&first=1&mkt=zh-CN'
            }, '');
        }
        return makeResponse(200, {}, resultHtml);
    });

    try {
        const results = await searchBing('test', 1, { searchMode: 'request' });
        assert(results.length === 1, 'allowed regional redirect should return one result');
        assert(requestedUrls.length === 2, 'allowed regional redirect should make exactly two requests');
        assert(new URL(requestedUrls[1]).hostname === 'www.bing.com', 'Bing should follow a redirect to the alternate regional host');
    } finally {
        __setBingHttpGetForTests();
    }

    console.log('✅ Bing follows one allowlisted regional redirect');
}

async function testUnsupportedRedirectRejected(): Promise<void> {
    let requestCount = 0;
    __setBingHttpGetForTests(async () => {
        requestCount += 1;
        return makeResponse(302, { location: 'https://example.com/search?q=test' }, '');
    });

    try {
        await searchBing('test', 1, { searchMode: 'request' });
        throw new Error('Bing should reject a redirect outside its regional host allowlist');
    } catch (error) {
        assert(error instanceof Error && error.message.includes('unsupported target'), 'unsupported redirect should report a clear error');
        assert(requestCount === 1, 'unsupported redirect target must not receive a request');
    } finally {
        __setBingHttpGetForTests();
    }

    console.log('✅ Bing rejects redirects outside the regional host allowlist');
}

async function testRegionalRedirectLoopRejected(): Promise<void> {
    let requestCount = 0;
    __setBingHttpGetForTests(async (url: string) => {
        requestCount += 1;
        const hostname = new URL(url).hostname;
        const location = hostname === 'cn.bing.com'
            ? 'https://www.bing.com/search?q=test'
            : 'https://cn.bing.com/search?q=test';
        return makeResponse(302, { location }, '');
    });

    try {
        await searchBing('test', 1, { searchMode: 'request' });
        throw new Error('Bing should reject a regional redirect loop');
    } catch (error) {
        assert(error instanceof Error && error.message.includes('redirect limit'), 'regional redirect loop should report the redirect limit');
        assert(requestCount === 2, 'regional redirect loop should stop after one followed redirect');
    } finally {
        __setBingHttpGetForTests();
    }

    console.log('✅ Bing bounds regional redirects to one hop');
}

async function main(): Promise<void> {
    await testDirectRegionalEndpoint();
    await testAllowedRegionalRedirect();
    await testUnsupportedRedirectRejected();
    await testRegionalRedirectLoopRejected();
    console.log('\nBing HTTP tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
