/* 給与前月対比アプリ群 共通：MSAL認証 + Microsoft Graph API アクセス
   花岡車輌 業務アプリ（既存SPA登録）をそのまま使う。新規Azure AD登録・新規API権限は不要。
   redirectUriは全AP系アプリ共通の auth.html（リポジトリ直下、既に登録済み）を指す。
   auth.htmlは呼び出し元の場所に依存しない汎用ページなので、payroll/配下に置いても
   Azure側の追加登録は不要（ポップアップ認証：親ウィンドウが応答を回収する）。 */
const PAYROLL_MSAL_CONFIG = {
  auth: {
    clientId: 'd338d61b-01dc-4c7c-ac6b-aecf7f30d716',
    authority: 'https://login.microsoftonline.com/3933e8a0-c945-4e97-ae67-c82131087cad',
    redirectUri: 'https://hanaoka-apps.github.io/hanaoka-ops/auth.html',
  },
  cache: { cacheLocation: 'sessionStorage', storeAuthStateInCookie: false },
};
const PAYROLL_SCOPES = ['User.Read', 'Sites.ReadWrite.All'];
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const PAYROLL_SITE_PATH = 'hanaokacorp.sharepoint.com:/sites/executive-workspace';

let _msal, _account, _driveId;

async function payrollInitAuth() {
  _msal = new msal.PublicClientApplication(PAYROLL_MSAL_CONFIG);
  await _msal.initialize();
  await _msal.handleRedirectPromise();
  const accounts = _msal.getAllAccounts();
  if (accounts.length > 0) {
    _account = accounts[0];
    _msal.setActiveAccount(_account);
    return true;
  }
  return false;
}

async function payrollSignIn() {
  const result = await _msal.loginPopup({ scopes: PAYROLL_SCOPES });
  _account = result.account;
  _msal.setActiveAccount(_account);
}

function payrollSignOut() {
  sessionStorage.removeItem('payrollDriveId');
  _msal.logoutRedirect();
}

async function payrollGetToken() {
  try {
    const r = await _msal.acquireTokenSilent({ scopes: PAYROLL_SCOPES, account: _account });
    return r.accessToken;
  } catch (e) {
    const r = await _msal.acquireTokenPopup({ scopes: PAYROLL_SCOPES });
    _account = r.account;
    return r.accessToken;
  }
}

async function graphGet(path, opts) {
  opts = opts || {};
  const token = await payrollGetToken();
  const res = await fetch(GRAPH_BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404 && opts.allow404) return null;
  if (res.status === 403) throw new Error('このSharePointサイトへのアクセス権がありません（役員・総務幹部限定のサイトです）。');
  if (!res.ok) throw new Error('[' + res.status + '] GET ' + path);
  return res.json();
}

async function graphPutJSON(path, obj) {
  const token = await payrollGetToken();
  const res = await fetch(GRAPH_BASE + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (res.status === 403) throw new Error('このSharePointサイトへの書き込み権がありません。');
  if (!res.ok) throw new Error('[' + res.status + '] PUT ' + path + ': ' + await res.text());
  return res.json();
}

async function payrollDriveId() {
  if (_driveId) return _driveId;
  const cached = sessionStorage.getItem('payrollDriveId');
  if (cached) { _driveId = cached; return cached; }
  const site = await graphGet('/sites/' + PAYROLL_SITE_PATH);
  const drive = await graphGet('/sites/' + site.id + '/drive');
  _driveId = drive.id;
  sessionStorage.setItem('payrollDriveId', drive.id);
  return drive.id;
}

/** SharePointの「給与データ」フォルダ配下のJSONファイルを読む。無ければnull（allow404時）。 */
async function payrollGetFile(relPath, opts) {
  const driveId = await payrollDriveId();
  return graphGet('/drives/' + driveId + '/root:/給与データ/' + encodeURI(relPath) + ':/content', opts);
}

/** SharePointの「給与データ」フォルダ配下にJSONを書き込む（新規作成 or 上書き）。 */
async function payrollPutFile(relPath, obj) {
  const driveId = await payrollDriveId();
  return graphPutJSON('/drives/' + driveId + '/root:/給与データ/' + encodeURI(relPath) + ':/content', obj);
}

/** 「給与データ」配下にCSV等の元ファイルをそのまま書き込む（勤怠CSVのログ保存用）。 */
async function payrollPutRaw(relPath, body, contentType) {
  const driveId = await payrollDriveId();
  const token = await payrollGetToken();
  const path = '/drives/' + driveId + '/root:/給与データ/' + encodeURI(relPath) + ':/content';
  const res = await fetch(GRAPH_BASE + path, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType || 'application/octet-stream' },
    body,
  });
  if (res.status === 403) throw new Error('このSharePointサイトへの書き込み権がありません。');
  if (!res.ok) throw new Error('[' + res.status + '] PUT ' + relPath + ': ' + await res.text());
  return res.json();
}

// ---------------- 時間外確認用：総務のサイト ----------------
// 時間外確認（36協定）のデータは、給与データとは別の総務のサイトに置く。
// 総務の担当者（給与データは見られない人）も作業できるようにするため。個人データはここには書かない。
const OT_SITE_PATH = 'hanaokacorp.sharepoint.com:/sites/msteams_20513c';  // 総務のTeamsのサイト（既定のドキュメントライブラリ）
const OT_ROOT = '時間外確認/';
let _otDriveId;

async function otDriveId() {
  if (_otDriveId) return _otDriveId;
  const cached = sessionStorage.getItem('otDriveId');
  if (cached) { _otDriveId = cached; return cached; }
  let drive;
  try {
    const site = await graphGet('/sites/' + OT_SITE_PATH);
    drive = await graphGet('/sites/' + site.id + '/drive');
  } catch (e) {
    throw new Error('総務のサイト（時間外確認）へのアクセス権がありません。総務のサイトの「時間外確認」フォルダの共有を依頼してください。');
  }
  _otDriveId = drive.id;
  sessionStorage.setItem('otDriveId', drive.id);
  return drive.id;
}
const otPath = async rel => '/drives/' + (await otDriveId()) + '/root:/' + encodeURI(OT_ROOT + rel) + ':/content';
async function otGetFile(rel, opts) { return graphGet(await otPath(rel), opts); }
async function otPutFile(rel, obj) { return graphPutJSON(await otPath(rel), obj); }
async function otPutRaw(rel, body, contentType) {
  const token = await payrollGetToken();
  const res = await fetch(GRAPH_BASE + await otPath(rel), {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': contentType || 'application/octet-stream' }, body,
  });
  if (res.status === 403) throw new Error('総務のサイトへの書き込み権がありません。');
  if (!res.ok) throw new Error('[' + res.status + '] PUT ' + rel + ': ' + await res.text());
  return res.json();
}
async function otGetRaw(rel) {
  const token = await payrollGetToken();
  const res = await fetch(GRAPH_BASE + await otPath(rel), { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('[' + res.status + '] GET ' + rel);
  return res.arrayBuffer();
}
/** 給与データ（Executive Workspace）を見られる人か。見られない人には給与系のメニューを出さない */
async function payrollHasAccess() {
  try { await payrollDriveId(); return true; } catch (e) { return false; }
}

/** 「給与データ」配下のファイルをバイナリ（ArrayBuffer）で読む。 */
async function payrollGetRaw(relPath) {
  const driveId = await payrollDriveId();
  const token = await payrollGetToken();
  const res = await fetch(GRAPH_BASE + '/drives/' + driveId + '/root:/給与データ/' + encodeURI(relPath) + ':/content',
    { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('[' + res.status + '] GET ' + relPath);
  return res.arrayBuffer();
}
