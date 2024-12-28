(async () => {
    const fetch = (await import('node-fetch')).default;
    const fs = require('fs').promises;
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const path = require('path'); 
    const readline = require('readline');
    const crypto = require('crypto'); 
  
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
  
    const RETRY_DELAY = 30000; // 30 seconds
    const MAX_DEVICES = 5;
    const browserIdMap = new Map(); // Map to track assigned browser IDs per proxy
  
    function askQuestion(query) {
        return new Promise((resolve) => rl.question(query, (answer) => resolve(answer)));
    }
  
    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
  
    function createProxyAgent(proxyString) {
      try {
        const proxyRegex = /^(?:(socks5|http|https):\/\/)?(?:(.+):(.+)@)?([^:]+)(?::(\d+))?$/;
        const match = proxyString.match(proxyRegex);
        
        if (!match) {
          throw new Error('Invalid proxy format');
        }
  
        const [, protocol = 'http', username, password, host, port = '1080'] = match;
        const authPart = username && password ? `${username}:${password}@` : '';
        const proxyUrl = `${protocol}://${authPart}${host}:${port}`;
  
        return protocol === 'socks5' ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
      } catch (error) {
        console.error(`Error creating proxy agent: ${error.message}`);
        return null;
      }
    }
  
    // Extract IP from proxy string
    function getProxyIP(proxyString) {
      const match = proxyString.match(/@([^:]+):/);
      return match ? match[1] : proxyString;
    }
  
    async function main() {
        const accessToken = await askQuestion("Enter your accessToken :");
        const id8 = await askQuestion("Enter your first 8 browserID :");
  
        let headers = {
            'Accept': 'application/json, text/plain, */*',
            'origin': 'chrome-extension://cpjicfogbgognnifjgmenmaldnmeeeib',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
        };
  
        function generateUniqueBrowserId(proxyString) {
            const newBrowserId = `${id8}${crypto.randomUUID().slice(8)}`;
            browserIdMap.set(proxyString, newBrowserId);
            return newBrowserId;
        }
  
        async function coday(url, method, payloadData = null, proxyString, retryCount = 0) {
            try {
                const agent = createProxyAgent(proxyString);
                if (!agent) {
                  throw new Error('Failed to create proxy agent');
                }
  
                let response;
                const options = {
                    method: method,
                    headers: headers,
                    agent: agent
                };
  
                if (method === 'POST') {
                    options.body = JSON.stringify(payloadData);
                    response = await fetch(url, options);
                } else {
                    response = await fetch(url, options);
                }
  
                const result = await response.json();
                
                if (result.code === 410) {
                    if (retryCount < 3) {
                        console.log(`Device limit reached for ${getProxyIP(proxyString)}, generating new browser ID and retrying in ${RETRY_DELAY/1000} seconds...`);
                        await sleep(RETRY_DELAY);
                        
                        // Generate new browser ID for retry
                        if (payloadData && payloadData.browser_id) {
                            payloadData.browser_id = generateUniqueBrowserId(proxyString);
                            console.log(`New browser ID generated for retry: ${payloadData.browser_id}`);
                        }
                        
                        return await coday(url, method, payloadData, proxyString, retryCount + 1);
                    } else {
                        throw new Error(`Max retries reached for proxy ${getProxyIP(proxyString)}`);
                    }
                }
                
                return result;
            } catch (error) {
                console.error(`Error with proxy ${getProxyIP(proxyString)}: ${error.message}`);
                throw error;
            }
        }
  
        function getCurrentTimestamp() {
            return Math.floor(Date.now() / 1000);
        }
  
        async function pingProxy(proxy, browser_id, uid) {
            const timestamp = getCurrentTimestamp();
            const pingPayload = { 
                "uid": uid, 
                "browser_id": browser_id, 
                "timestamp": timestamp, 
                "version": "1.0.1" 
            };
  
            while (true) {
                try {
                    const pingResponse = await coday('https://api.aigaea.net/api/network/ping', 'POST', pingPayload, proxy);
                    await coday('https://api.aigaea.net/api/network/ip', 'GET', {}, proxy);
                    console.log(`Ping successful for proxy ${getProxyIP(proxy)}:`, pingResponse);
  
                    if (pingResponse.data && pingResponse.data.score < 50) {
                        console.log(`Score below 50 for proxy ${getProxyIP(proxy)}, re-authenticating...`);
                        await sleep(RETRY_DELAY);
                        await handleAuthAndPing(proxy);
                        break;
                    }
                } catch (error) {
                    console.error(`Ping failed for proxy ${getProxyIP(proxy)}:`, error);
                    await sleep(RETRY_DELAY);
                }
                await sleep(600000); // 10 minute delay between pings
            }
        }
  
        async function handleAuthAndPing(proxy) {
            try {
                const browser_id = generateUniqueBrowserId(proxy);
                console.log(`Generated unique browser_id for proxy ${getProxyIP(proxy)}: ${browser_id}`);
                
                const payload = {};
                const authResponse = await coday("https://api.aigaea.net/api/auth/session", 'POST', payload, proxy);
                
                if (authResponse && authResponse.data) {
                    const uid = authResponse.data.uid;
                    console.log(`Authenticated for proxy ${getProxyIP(proxy)} with uid ${uid} and browser_id ${browser_id}`);
                    await pingProxy(proxy, browser_id, uid);
                } else {
                    console.error(`Authentication failed for proxy ${getProxyIP(proxy)}`);
                    await sleep(RETRY_DELAY);
                }
            } catch (error) {
                console.error(`Error in handleAuthAndPing for proxy ${getProxyIP(proxy)}:`, error);
                await sleep(RETRY_DELAY);
            }
        }
  
        try {
            const proxyList = await fs.readFile('proxy.txt', 'utf-8');
            const proxies = proxyList.split('\n')
                .map(proxy => proxy.trim())
                .filter(proxy => proxy);
  
            if (proxies.length === 0) {
                console.error("No proxies found in proxy.txt");
                return;
            }
  
            // Process proxies in smaller batches
            const BATCH_SIZE = Math.min(MAX_DEVICES, proxies.length);
            for (let i = 0; i < proxies.length; i += BATCH_SIZE) {
                const batch = proxies.slice(i, i + BATCH_SIZE);
                console.log(`Processing batch of ${batch.length} proxies...`);
                const tasks = batch.map(proxy => handleAuthAndPing(proxy));
                await Promise.all(tasks);
                
                if (i + BATCH_SIZE < proxies.length) {
                    console.log(`Waiting ${RETRY_DELAY/1000} seconds before next batch...`);
                    await sleep(RETRY_DELAY);
                }
            }
  
        } catch (error) {
            console.error('An error occurred:', error);
        }
    }
  
    main();
  })();