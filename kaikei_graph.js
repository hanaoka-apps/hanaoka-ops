/* 会計ダッシュボード 共通：MSAL認証 + Microsoft Graph API アクセス
   花岡車輌 業務アプリ（既存SPA登録）をそのまま使う。新規Azure AD登録・新規API権限は不要。
   給与アプリ(payroll_graph.js)と同じ executive-workspace サイトを使い、フォルダだけ「会計データ」に分ける。 */
const KAIKEI_MSAL_CONFIG = {
  auth: {
    clientId: 'd338d61b-01dc-4c7c-ac6b-aecf7f30d716',
    authority: 'https://login.microsoftonline.com/3933e8a0-c945-4e97-ae67-c82131087cad',
    redirectUri: 'https://hanaoka-apps.github.io/hanaoka-ops/auth.html',
  },
  cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: false },
};
const KAIKEI_SCOPES = ['User.Read', 'Sites.ReadWrite.All'];
const KAIKEI_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const KAIKEI_SITE_PATH = 'hanaokacorp.sharepoint.com:/sites/executive-workspace';
const KAIKEI_ROOT_FOLDER = '会計データ';

let _kaikeiMsal, _kaikeiAccount, _kaikeiDriveId;

async function kaikeiInitAuth() {
  _kaikeiMsal = new msal.PublicClientApplication(KAIKEI_MSAL_CONFIG);
  await _kaikeiMsal.initialize();
  await _kaikeiMsal.handleRedirectPromise();
  const accounts = _kaikeiMsal.getAllAccounts();
  if (accounts.length > 0) {
    _kaikeiAccount = accounts[0];
    _kaikeiMsal.setActiveAccount(_kaikeiAccount);
    return true;
  }
  return false;
}

async function kaikeiSignIn() {
  const result = await _kaikeiMsal.loginPopup({ scopes: KAIKEI_SCOPES });
  _kaikeiAccount = result.account;
  _kaikeiMsal.setActiveAccount(_kaikeiAccount);
}

function kaikeiSignOut() {
  sessionStorage.removeItem('kaikeiDriveId');
  _kaikeiMsal.logoutRedirect();
}

async function kaikeiGetToken() {
  try {
    const r = await _kaikeiMsal.acquireTokenSilent({ scopes: KAIKEI_SCOPES, account: _kaikeiAccount });
    return r.accessToken;
  } catch (e) {
    const r = await _kaikeiMsal.acquireTokenPopup({ scopes: KAIKEI_SCOPES });
    _kaikeiAccount = r.account;
    return r.accessToken;
  }
}

async function kaikeiGraphGet(path, opts) {
  opts = opts || {};
  const token = await kaikeiGetToken();
  const res = await fetch(KAIKEI_GRAPH_BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404 && opts.allow404) return null;
  if (res.status === 403) throw new Error('このSharePointサイトへのアクセス権がありません（役員限定のサイトです）。');
  if (!res.ok) throw new Error('[' + res.status + '] GET ' + path);
  return res.json();
}

async function kaikeiGraphPutJSON(path, obj) {
  const token = await kaikeiGetToken();
  const res = await fetch(KAIKEI_GRAPH_BASE + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (res.status === 403) throw new Error('このSharePointサイトへの書き込み権がありません。');
  if (!res.ok) throw new Error('[' + res.status + '] PUT ' + path + ': ' + await res.text());
  return res.json();
}

async function kaikeiDriveId() {
  if (_kaikeiDriveId) return _kaikeiDriveId;
  const cached = sessionStorage.getItem('kaikeiDriveId');
  if (cached) { _kaikeiDriveId = cached; return cached; }
  const site = await kaikeiGraphGet('/sites/' + KAIKEI_SITE_PATH);
  const drive = await kaikeiGraphGet('/sites/' + site.id + '/drive');
  _kaikeiDriveId = drive.id;
  sessionStorage.setItem('kaikeiDriveId', drive.id);
  return drive.id;
}

/** SharePointの「会計データ」フォルダ配下のJSONファイルを読む。無ければnull（allow404時）。 */
async function kaikeiGetFile(relPath, opts) {
  const driveId = await kaikeiDriveId();
  return kaikeiGraphGet('/drives/' + driveId + '/root:/' + KAIKEI_ROOT_FOLDER + '/' + encodeURI(relPath) + ':/content', opts);
}

/** SharePointの「会計データ」フォルダ配下にJSONを書き込む（新規作成 or 上書き）。 */
async function kaikeiPutFile(relPath, obj) {
  const driveId = await kaikeiDriveId();
  return kaikeiGraphPutJSON('/drives/' + driveId + '/root:/' + KAIKEI_ROOT_FOLDER + '/' + encodeURI(relPath) + ':/content', obj);
}
