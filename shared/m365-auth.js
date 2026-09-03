/* 花岡車輌 社内アプリ共通 M365 認証モジュール
 * 実値はビルド時または git 管理外の config.local.* から渡すこと。
 */
(function (global) {
  'use strict';

  const DEFAULT_CDNS = [
    'https://alcdn.msftauth.net/browser/2.38.3/js/msal-browser.min.js',
    'https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js',
    'https://unpkg.com/@azure/msal-browser@2.38.3/lib/msal-browser.min.js',
    'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js'
  ];

  let client = null;
  let activeAccount = null;

  function requireValue(value, label) {
    if (!value || String(value).includes('__')) {
      throw new Error(`M365設定が不足しています: ${label}`);
    }
    return String(value);
  }

  async function loadMsal(cdns) {
    if (global.msal) return global.msal;
    const sources = Array.isArray(cdns) && cdns.length ? cdns : DEFAULT_CDNS;
    for (const src of sources) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
        if (global.msal) return global.msal;
      } catch (_) {
        // 次の許可済みCDNへフォールバックする。
      }
    }
    throw new Error('MSAL.jsを読み込めませんでした');
  }

  function buildClient(config, msal) {
    const tenantId = requireValue(config && config.tenantId, 'tenantId');
    const clientId = requireValue(config && config.clientId, 'clientId');
    client = new msal.PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: (config && config.redirectUri) || (location.origin + location.pathname),
        navigateToLoginRequestUrl: false
      },
      cache: {
        cacheLocation: (config && config.cacheLocation) || 'sessionStorage',
        storeAuthStateInCookie: false
      }
    });
    return client;
  }

  function createClientSync(config) {
    if (!global.msal) throw new Error('MSAL.jsがまだ読み込まれていません');
    return buildClient(config, global.msal);
  }

  async function createClient(config) {
    const msal = await loadMsal(config && config.cdns);
    buildClient(config, msal);
    if (typeof client.initialize === 'function') await client.initialize();
    return client;
  }

  async function handleRedirect() {
    if (!client) throw new Error('M365認証が初期化されていません');
    const response = await client.handleRedirectPromise();
    activeAccount = response && response.account
      ? response.account
      : client.getActiveAccount() || client.getAllAccounts()[0] || null;
    if (activeAccount) client.setActiveAccount(activeAccount);
    return activeAccount;
  }

  async function login(scopes) {
    if (!client) throw new Error('M365認証が初期化されていません');
    return client.loginRedirect({scopes: scopes || ['User.Read'], prompt: 'select_account'});
  }

  async function acquireToken(scopes, account) {
    if (!client) throw new Error('M365認証が初期化されていません');
    const target = account || activeAccount || client.getActiveAccount();
    if (!target) throw new Error('M365アカウントが選択されていません');
    const result = await client.acquireTokenSilent({scopes, account: target});
    return result.accessToken;
  }

  function graphDriveItemUrl(driveId, itemPath, content) {
    requireValue(driveId, 'driveId');
    const clean = String(itemPath || '').replace(/^\/+|\/+$/g, '');
    if (!clean) throw new Error('Graph取得パスが空です');
    const encoded = clean.split('/').map(encodeURIComponent).join('/');
    return `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encoded}${content ? ':/content' : ''}`;
  }

  async function fetchDriveJson(options) {
    const token = await acquireToken(options.scopes || ['Files.Read.All'], options.account);
    const response = await fetch(graphDriveItemUrl(options.driveId, options.path, true), {
      headers: {Authorization: `Bearer ${token}`},
      cache: options.cache || 'no-store'
    });
    if (!response.ok) throw new Error(`Graphデータ取得に失敗しました (HTTP ${response.status})`);
    return response.json();
  }

  function logout() {
    if (!client) return Promise.resolve();
    return client.logoutRedirect();
  }

  global.HanaokaM365Auth = Object.freeze({
    loadMsal,
    createClientSync,
    createClient,
    handleRedirect,
    login,
    acquireToken,
    fetchDriveJson,
    graphDriveItemUrl,
    logout
  });
})(window);
