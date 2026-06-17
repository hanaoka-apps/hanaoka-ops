#!/usr/bin/env python3
"""
FUJIN HTML群にMSAL.js認証ゲートを挿入する後処理スクリプト
- 既存のFUJIN.html / results_production_*.html / 今日やること.html / 受注追跡.html を読み込み
- <head>に MSAL.js + 認証ゲートJSを挿入
- 出力先: ./auth_dist/  （GitHubにアップロードするのはこのフォルダの中身）

使い方:
    python3 auth_wrapper.py
    → ./auth_dist/ に認証付きHTMLが生成される
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if ROOT.name == "scripts":
    ROOT = ROOT.parent
OUT = ROOT / "auth_dist"
OUT.mkdir(exist_ok=True)

# Azure AD 設定（雅さん提供 2026-04-27）
TENANT_ID = "3933e8a0-c945-4e97-ae67-c82131087cad"
CLIENT_ID = "d338d61b-01dc-4c7c-ac6b-aecf7f30d716"

AUTH_GATE_SCRIPT = """
<!-- ============ MSAL.js 認証ゲート (Microsoft Entra ID) ============ -->
<!-- HTMLパース時点から本体を非表示 (認証完了まで一瞬たりとも見せない) -->
<style id="_fujin_preauth_style">
  html.fujin-pre-auth body { visibility: hidden !important; }
  /* 認証バッジ用の余白を header に確保 (バッジと「データ基準日」表示が重ならないように) */
  header { padding-right: 250px !important; }  /* 右上のユーザーバー(👤 + サインアウト)と「最終更新」表示の重なり回避(2026-06-13 余白拡大) */
  /* スマホ/タブレット: ユーザーバーをコンパクト化してタブが隠れないように(2026-06-13) */
  @media (max-width: 900px) {
    header { padding-right: 8px !important; }
    #_fujinUserBar { top:6px !important; right:8px !important; padding:3px 8px !important; font-size:10px !important; gap:5px !important; max-width:42vw; }
    #_fujinUserBar .ub-name { max-width:80px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #_fujinUserBar #_fujinLogoutBtn { font-size:10px !important; }
    /* タブはヘッダー幅に収まらない分を横スクロール(タブ自体は隠れず指で送れる) */
    header .tabbar { padding-right: 44vw; }
  }
</style>
<script>document.documentElement.classList.add("fujin-pre-auth");</script>
<!-- MSAL.js を複数CDNフォールバックで読み込む (社内ネットワークでブロックされても通るように) -->
<script>
(function() {
  const cdns = [
    "https://alcdn.msftauth.net/browser/2.38.3/js/msal-browser.min.js",
    "https://alcdn.msauth.net/browser/2.38.3/js/msal-browser.min.js",
    "https://unpkg.com/@azure/msal-browser@2.38.3/lib/msal-browser.min.js",
    "https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.3/lib/msal-browser.min.js"
  ];
  window._fujinMsalLoading = true;
  let idx = 0;
  function tryNext() {
    if (idx >= cdns.length) {
      window._fujinMsalLoadFailed = true;
      window._fujinMsalLoading = false;
      console.error("[FUJIN] 全てのMSAL CDNが失敗しました");
      // ロード失敗イベントを発火
      try { document.dispatchEvent(new Event("_fujinMsalReady")); } catch(_){}
      return;
    }
    const url = cdns[idx++];
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    s.onload = function() {
      console.log("[FUJIN] MSAL loaded from:", url);
      window._fujinMsalCdn = url;
      window._fujinMsalLoading = false;
      try { document.dispatchEvent(new Event("_fujinMsalReady")); } catch(_){}
    };
    s.onerror = function() {
      console.warn("[FUJIN] MSAL CDN失敗:", url);
      s.remove();
      tryNext();
    };
    document.head.appendChild(s);
  }
  tryNext();
})();
</script>
<style id="_fujin_auth_style">
  html._fujin_pending body { visibility: hidden; }
  /* 認証確認中オーバーレイ (全画面、目視確認用) */
  ._fujin_overlay {
    position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;
    background:linear-gradient(135deg,#1e3a8a 0%,#3b82f6 100%);color:#fff;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Meiryo',sans-serif;
  }
  ._fujin_overlay .logo { font-size:48px; animation: _fujin_pulse 1.5s infinite ease-in-out; }
  ._fujin_overlay .msg { font-size:18px;font-weight:700;letter-spacing:.04em; }
  ._fujin_overlay .sub { font-size:12px;opacity:.85;margin-top:-6px; }
  ._fujin_overlay .spinner {
    width:32px;height:32px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;
    border-radius:50%;animation:_fujin_spin 0.8s linear infinite;
  }
  @keyframes _fujin_spin { to { transform: rotate(360deg); } }
  @keyframes _fujin_pulse { 0%,100% { opacity:1; } 50% { opacity:.6; } }
  /* 認証成功トースト */
  ._fujin_toast {
    position:fixed;top:60px;right:14px;z-index:2147483646;
    background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;
    font-size:13px;font-weight:700;box-shadow:0 4px 16px rgba(22,163,74,.4);
    font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;
    animation: _fujin_toast_in .3s ease-out, _fujin_toast_out .3s ease-in 4.5s forwards;
  }
  @keyframes _fujin_toast_in { from { transform: translateX(20px); opacity: 0; } }
  @keyframes _fujin_toast_out { to { transform: translateX(20px); opacity: 0; } }
  ._fujin_login_box {
    display:flex;justify-content:center;align-items:center;min-height:100vh;
    font-family:"Hiragino Sans","Meiryo",sans-serif;background:#f4f5f7;margin:0;
  }
  ._fujin_login_box .card {
    background:#fff;border-radius:12px;padding:40px 48px;
    box-shadow:0 8px 32px rgba(0,0,0,0.08);text-align:center;max-width:420px;
    border:1px solid #e5e7eb;
  }
  ._fujin_login_box h1 { font-size:26px;margin:0 0 8px;color:#1e293b;letter-spacing:.04em }
  ._fujin_login_box .sub { color:#64748b;font-size:13px;margin:0 0 28px }
  ._fujin_login_box button {
    background:linear-gradient(135deg,#0078d4 0%,#005a9e 100%);color:#fff;border:none;
    padding:14px 32px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;
    box-shadow:0 4px 12px rgba(0,120,212,.3);transition:all .15s;
  }
  ._fujin_login_box button:hover { transform:translateY(-1px);box-shadow:0 6px 16px rgba(0,120,212,.4) }
  ._fujin_login_box .note { font-size:11px;color:#94a3b8;margin-top:20px;line-height:1.6 }
  ._fujin_login_box .err { background:#fef2f2;color:#991b1b;padding:10px 14px;border-radius:6px;font-size:12px;margin-top:14px;border:1px solid #fecaca }
</style>
<script>
// MSALロード完了を待ってから認証ゲートを起動 (CDN フォールバック対応)
function _fujinStartAuth() {
  // iframe内なら親のサインイン状態を共有 → 認証チェックスキップ
  if (window.parent !== window) {
    return;
  }
  // ★ file:// で開かれた場合は認証をスキップ (ローカル閲覧モード)
  //   Azure AD は file:// スキームを redirect_uri として受け付けないので物理的に認証不可
  //   ローカルファイルにアクセスできる時点で本人前提
  if (window.location.protocol === "file:") {
    console.log("[FUJIN] file:// 検出 → 認証スキップ (ローカルモード)");
    document.documentElement.classList.remove("fujin-pre-auth");
    window._fujinAuthReady = true;
    try { window.dispatchEvent(new CustomEvent("_fujin_auth_ready", { detail: { username: "local-user", localMode: true } })); } catch(_) {}
    function _insertLocalBar() {
      if (document.getElementById("_fujinUserBar")) return;
      const bar = document.createElement("div");
      bar.id = "_fujinUserBar";
      bar.style.cssText = "position:fixed;top:8px;right:14px;z-index:2147483647;background:rgba(255,251,235,.98);border:1px solid #fcd34d;border-radius:18px;padding:5px 14px;font-size:11px;color:#92400e;font-weight:600;box-shadow:0 2px 10px rgba(146,64,14,.18);font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif";
      bar.textContent = "🏠 ローカルモード (認証なし)";
      document.body.appendChild(bar);
    }
    if (document.body) _insertLocalBar();
    else document.addEventListener("DOMContentLoaded", _insertLocalBar, { once: true });
    return;
  }
  // ページを一旦非表示にしてサインイン確認
  document.documentElement.classList.add("_fujin_pending");

  // 認証確認中オーバーレイを即座に表示 (目視で「ゲートが動いている」と分かるように)
  function _showCheckingOverlay() {
    if (document.getElementById("_fujinCheckOverlay")) return;
    const ov = document.createElement("div");
    ov.id = "_fujinCheckOverlay";
    ov.className = "_fujin_overlay";
    ov.innerHTML = '<div class="logo">🔐</div><div class="msg">FUJIN サインイン確認中</div><div class="sub">花岡車輌 Microsoft 365 アカウントを照合しています</div><div class="spinner"></div>';
    (document.body || document.documentElement).appendChild(ov);
  }
  function _hideCheckingOverlay() {
    const ov = document.getElementById("_fujinCheckOverlay");
    if (ov) ov.remove();
  }
  function _showSuccessToast(username) {
    const t = document.createElement("div");
    t.className = "_fujin_toast";
    t.textContent = "✅ 認証OK: " + (username || "認証済");
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  if (document.body) _showCheckingOverlay();
  else document.addEventListener("DOMContentLoaded", _showCheckingOverlay, { once: true });

  // 安全網: 8秒経っても初期化が完了しなければ強制的にサインイン画面 or エラー表示
  setTimeout(function(){
    if (document.getElementById("_fujinCheckOverlay")) {
      _hideCheckingOverlay();
      if (typeof msal === "undefined" || window._fujinMsalLoadFailed) {
        showLogin("認証ライブラリ (MSAL.js) を読み込めませんでした。ネットワーク接続を確認のうえ、ページを再読み込みしてください。");
      } else {
        showLogin("認証初期化がタイムアウトしました。再度サインインしてください。");
      }
    }
  }, 8000);

  // MSAL がロードできていない場合は即座にエラー表示
  if (typeof msal === "undefined" || window._fujinMsalLoadFailed) {
    _hideCheckingOverlay();
    if (document.body) {
      showLogin("認証ライブラリ (MSAL.js) を読み込めませんでした。ネットワーク接続を確認のうえ、ページを再読み込みしてください。");
    } else {
      document.addEventListener("DOMContentLoaded", function(){
        showLogin("認証ライブラリ (MSAL.js) を読み込めませんでした。ネットワーク接続を確認のうえ、ページを再読み込みしてください。");
      }, { once: true });
    }
    return;
  }

  const FUJIN_AUTH_CONFIG = {
    auth: {
      clientId: "__CLIENT_ID__",
      authority: "https://login.microsoftonline.com/__TENANT_ID__",
      redirectUri: window.location.origin + window.location.pathname,
      navigateToLoginRequestUrl: false
    },
    cache: { cacheLocation: "sessionStorage", storeAuthStateInCookie: false }
  };

  function showLogin(errorMsg){
    document.documentElement.classList.remove("_fujin_pending");
    document.documentElement.classList.remove("fujin-pre-auth");  // ログイン画面を表示するため一旦解除
    _hideCheckingOverlay();
    document.body.className = "_fujin_login_box";
    document.body.innerHTML = `
      <div class="card">
        <h1>FUJIN</h1>
        <div class="sub">花岡車輌株式会社 生産管理ダッシュボード</div>
        <button id="_fujinLoginBtn">🔐 Microsoft アカウントでサインイン</button>
        ${errorMsg ? '<div class="err">'+errorMsg+'</div>' : ''}
        <div class="note">
          M365アカウントでのサインインが必要です。<br>
          組織管理者から付与されたアカウントを使用してください。
        </div>
      </div>`;
    document.getElementById("_fujinLoginBtn").onclick = async () => {
      if (!window._fujinMsal || typeof window._fujinMsal.loginRedirect !== "function") {
        showLogin("認証ライブラリが正しく読み込めていません。ページを再読み込みしてください (Cmd+Shift+R)。");
        return;
      }
      try {
        // loginRedirect: ページ全体を Microsoft 認証ページに遷移させる方式
        // ポップアップを使わないので Safari/Chrome のサードパーティクッキー問題を回避できる
        // 認証完了後、redirectUri に戻ってきて handleRedirectPromise() で結果を取得
        await window._fujinMsal.loginRedirect({
          scopes: ["User.Read", "Files.Read.All"],
          prompt: "select_account"
        });
        // loginRedirect 実行後はページ遷移するため、この行に到達しない
      } catch(e) {
        const ec = e && (e.errorCode || e.name) || "";
        const em = e && (e.errorMessage || e.message) || String(e);
        let hint = "";
        if (ec === "AADSTS50011" || em.indexOf("redirect_uri") >= 0 || em.indexOf("AADSTS50011") >= 0) {
          hint = '<br><br><b>★リダイレクトURI未登録です★</b><br>Azure ADの「花岡車輌 業務アプリ」SPAリダイレクトURIに下記を追加してください:<br><code style="font-size:11px;background:#fef3c7;padding:2px 6px;border-radius:3px;display:inline-block;margin-top:4px">' + window.location.origin + window.location.pathname + '</code>';
        }
        showLogin("サインインエラー [" + ec + "]: " + em + hint);
      }
    };
  }

  function showApp(account){
    document.documentElement.classList.remove("_fujin_pending");
    document.documentElement.classList.remove("fujin-pre-auth");  // 本体表示を解除
    window._fujinUser = account;
    window._fujinAuthReady = true;
    _hideCheckingOverlay();
    _showSuccessToast(account.username || account.name);

    // ★ 2026-06-10 セキュリティ移行: item_history を SharePoint から認証取得
    //   仕入先名・金額を含む item_history を公開Pagesに置かず、ログインユーザーの
    //   トークンで SharedMasters ドライブから取得し window._fujinItemHistory に保存する。
    //   各画面(構成ツリー/山リスト/手配確定)は親のこの値を採用する。
    //   ※ _fujin_auth_ready の dispatch より前に Promise を生成すること。
    //     シェルの init() はこの Promise 完了(または最大6秒)を待ってからタブを開くため、
    //     先に window._fujinItemHistoryPromise が存在している必要がある。
    try {
      var _SP_DRIVE = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
      window._fujinItemHistoryPromise = window._fujinMsal
        .acquireTokenSilent({ scopes: ["Files.Read.All"], account: account })
        .then(function(r){
          return fetch("https://graph.microsoft.com/v1.0/drives/" + _SP_DRIVE + "/root:/item_history.json:/content",
                       { headers: { Authorization: "Bearer " + r.accessToken } });
        })
        .then(function(res){ if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function(d){
          window._fujinItemHistory = d;
          var n = (d && d.items) ? Object.keys(d.items).length : 0;
          console.log("[item_history] ✅ SharePointから認証取得 成功 (品目数=" + n + ")");
          return d;
        })
        .catch(function(e){
          console.warn("[item_history] SharePoint取得 失敗:", (e && (e.errorCode || e.message)) || e);
          return null;
        });
    } catch(e) { console.error("[item_history] 例外:", e); window._fujinItemHistoryPromise = Promise.resolve(null); }

    // ★ 2026-06-11 セキュリティ移行: yama_data(山積み台数) も SharePoint から認証取得
    //   item_history と同方式。山リスト画面は window.top._fujinYamaData を採用する。
    try {
      var _SP_DRIVE2 = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
      window._fujinYamaDataPromise = window._fujinMsal
        .acquireTokenSilent({ scopes: ["Files.Read.All"], account: account })
        .then(function(r){
          return fetch("https://graph.microsoft.com/v1.0/drives/" + _SP_DRIVE2 + "/root:/yama_data.json:/content",
                       { headers: { Authorization: "Bearer " + r.accessToken } });
        })
        .then(function(res){ if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function(d){
          window._fujinYamaData = d;
          console.log("[yama_data] ✅ SharePointから認証取得 成功");
          return d;
        })
        .catch(function(e){
          console.warn("[yama_data] SharePoint取得 失敗:", (e && (e.errorCode || e.message)) || e);
          return null;
        });
    } catch(e) { console.error("[yama_data] 例外:", e); window._fujinYamaDataPromise = Promise.resolve(null); }

    // ★ 2026-06-13 セキュリティ移行: results_production の本体データ(手配/在庫/受注/BOM)も
    //   SharePoint から認証取得。構成ツリー/手配確定の results_production.html は
    //   window.top._fujinResultsData を読む(HTML自体は描画コードのみで機微データ非含有)。
    try {
      var _SP_DRIVE3 = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
      window._fujinResultsDataPromise = window._fujinMsal
        .acquireTokenSilent({ scopes: ["Files.Read.All"], account: account })
        .then(function(r){
          return fetch("https://graph.microsoft.com/v1.0/drives/" + _SP_DRIVE3 + "/root:/results_production_data.json:/content",
                       { headers: { Authorization: "Bearer " + r.accessToken } });
        })
        .then(function(res){ if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function(d){
          window._fujinResultsData = d;
          var n = (d && d.DATA) ? d.DATA.length : 0;
          console.log("[results_production] ✅ SharePointから認証取得 成功 (手配" + n + "件)");
          return d;
        })
        .catch(function(e){
          console.warn("[results_production] SharePoint取得 失敗:", (e && (e.errorCode || e.message)) || e);
          return null;
        });
    } catch(e) { console.error("[results_production] 例外:", e); window._fujinResultsDataPromise = Promise.resolve(null); }

    // ★ 2026-06-13 製番進捗(seiban_progress)も SharePoint から認証取得。
    //   画面(seiban_progress.html)は window.top._fujinSeibanData を読む。
    try {
      var _SP_DRIVE4 = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
      window._fujinSeibanDataPromise = window._fujinMsal
        .acquireTokenSilent({ scopes: ["Files.Read.All"], account: account })
        .then(function(r){
          return fetch("https://graph.microsoft.com/v1.0/drives/" + _SP_DRIVE4 + "/root:/seiban_progress.json:/content",
                       { headers: { Authorization: "Bearer " + r.accessToken } });
        })
        .then(function(res){ if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function(d){
          window._fujinSeibanData = d;
          var n = (d && d.seibans) ? d.seibans.length : 0;
          console.log("[seiban_progress] ✅ SharePointから認証取得 成功 (製番" + n + ")");
          return d;
        })
        .catch(function(e){
          console.warn("[seiban_progress] SharePoint取得 失敗:", (e && (e.errorCode || e.message)) || e);
          return null;
        });
    } catch(e) { console.error("[seiban_progress] 例外:", e); window._fujinSeibanDataPromise = Promise.resolve(null); }

    // ★ 2026-06-17 製番製造スケジュール(BOM×L/T逆算ガント)も SharePoint から認証取得。
    //   画面(seiban_gantt.html)は window.top._fujinSeibanGantt を読む。
    try {
      var _SP_DRIVE5 = "b!JT-BVyiLrECv-h59BtVoApKOQutjbKlGoUT2oig6LyO5ej8pUQ4QQIYH904CzeZ8";
      window._fujinSeibanGanttPromise = window._fujinMsal
        .acquireTokenSilent({ scopes: ["Files.Read.All"], account: account })
        .then(function(r){
          return fetch("https://graph.microsoft.com/v1.0/drives/" + _SP_DRIVE5 + "/root:/seiban_gantt.json:/content",
                       { headers: { Authorization: "Bearer " + r.accessToken } });
        })
        .then(function(res){ if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then(function(d){
          window._fujinSeibanGantt = d;
          var n = (d && d.sb) ? d.sb.length : 0;
          console.log("[seiban_gantt] ✅ SharePointから認証取得 成功 (製番" + n + ")");
          return d;
        })
        .catch(function(e){
          console.warn("[seiban_gantt] SharePoint取得 失敗:", (e && (e.errorCode || e.message)) || e);
          return null;
        });
    } catch(e) { console.error("[seiban_gantt] 例外:", e); window._fujinSeibanGanttPromise = Promise.resolve(null); }

    // FUJIN本体の init() に「認証完了」を通知 (init()は遅延実行で待機している)
    try { window.dispatchEvent(new CustomEvent("_fujin_auth_ready", { detail: account })); } catch(_) {}
    // ページ右上にユーザー名・サインアウトボタンを表示
    // body準備を待ってから挿入 (重いiframe読み込み中でも確実に出るように)
    function _insertUserBar() {
      if (document.getElementById("_fujinUserBar")) return;  // 二重挿入防止
      const bar = document.createElement("div");
      bar.id = "_fujinUserBar";
      bar.style.cssText = "position:fixed;top:8px;right:14px;z-index:2147483647;background:rgba(255,255,255,.98);border:1px solid #c7d2fe;border-radius:18px;padding:5px 14px;font-size:11px;color:#1e3a8a;display:flex;align-items:center;gap:8px;box-shadow:0 2px 10px rgba(30,58,138,.18);font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;font-weight:600";
      // ユーザー名は @ より前だけ表示 (UI幅節約)。フルアドレスは title属性でhover時表示
      const fullName = account.username || account.name || '認証済';
      const shortName = fullName.indexOf('@') > 0 ? fullName.split('@')[0] : fullName;
      bar.innerHTML = '<span class="ub-name" title="' + fullName + '">👤 ' + shortName + '</span><button id="_fujinLogoutBtn" style="background:none;border:none;color:#1e40af;cursor:pointer;font-size:11px;text-decoration:underline;padding:0;font-weight:600;flex-shrink:0">サインアウト</button>';
      document.body.appendChild(bar);
      document.getElementById("_fujinLogoutBtn").onclick = () => window._fujinMsal.logoutRedirect();
    }
    if (document.body) {
      _insertUserBar();
    } else {
      document.addEventListener("DOMContentLoaded", _insertUserBar, { once: true });
    }
    // 念のため重いiframe読み込み後にも再挿入チャンス (5秒以内に必ず出す)
    setTimeout(_insertUserBar, 500);
    setTimeout(_insertUserBar, 2000);
    setTimeout(_insertUserBar, 5000);
  }

  // MSAL インスタンス作成 (例外時はエラー表示)
  let msalInstance = null;
  try {
    msalInstance = new msal.PublicClientApplication(FUJIN_AUTH_CONFIG);
    window._fujinMsal = msalInstance;
  } catch(constructErr) {
    console.error("MSAL constructor failed:", constructErr);
    _hideCheckingOverlay();
    if (document.body) {
      showLogin("MSAL初期化失敗: " + (constructErr && constructErr.message ? constructErr.message : constructErr));
    }
    return;
  }

  // 初期化フロー
  // 1. initialize()
  // 2. handleRedirectPromise() で リダイレクト戻り時の認証情報を受け取る
  //    - 戻り直後なら response.account あり → showApp
  //    - 通常アクセスなら null → showLogin (サインインボタン表示)
  msalInstance.initialize()
    .then(() => msalInstance.handleRedirectPromise())
    .then((response) => {
      _hideCheckingOverlay();
      if (response && response.account) {
        // Microsoft認証から戻ってきた直後: 認証成功 → アプリ表示
        msalInstance.setActiveAccount(response.account);
        // ★ 重要: 認証情報(コード/トークン)を含むURLハッシュをクリアする
        // これをしないと、認証戻りハッシュ「#code=1.AWsAo... 」が iframe (在庫探偵等) に
        // 「品目コード検索クエリ」として渡されて誤動作する
        try {
          if (window.history && window.history.replaceState) {
            const cleanUrl = window.location.origin + window.location.pathname + window.location.search;
            window.history.replaceState({}, document.title, cleanUrl);
          }
        } catch(_){}
        showApp(response.account);
      } else {
        // 通常アクセス: 必ずサインイン画面を表示 (loginRedirect の prompt: "select_account" で
        // 毎回アカウント選択画面を出すので、ここでキャッシュ削除する必要なし。
        // むしろ MSAL の state検証用キーを消してしまうと認証戻り時に失敗するので注意)
        showLogin();
      }
    })
    .catch((err) => {
      console.error("MSAL init/redirect error:", err);
      _hideCheckingOverlay();
      const ec = err && (err.errorCode || err.name) || "";
      const em = err && (err.errorMessage || err.message) || String(err);
      let hint = "";
      if (ec === "AADSTS50011" || em.indexOf("redirect_uri") >= 0 || em.indexOf("AADSTS50011") >= 0) {
        hint = '<br><br><b>★リダイレクトURI未登録です★</b><br>Azure ADの「花岡車輌 業務アプリ」SPAリダイレクトURIに下記を追加してください:<br><code style="font-size:11px;background:#fef3c7;padding:2px 6px;border-radius:3px;display:inline-block;margin-top:4px">' + window.location.origin + window.location.pathname + '</code>';
      }
      showLogin("認証初期化エラー [" + ec + "]: " + em + hint);
    });
}

// MSAL CDN フォールバックロードの完了を待ってから _fujinStartAuth を呼ぶ
(function() {
  function _waitAndStart() {
    // すでにロード済みなら即起動
    if (typeof msal !== "undefined") {
      _fujinStartAuth();
      return;
    }
    // ロード失敗フラグが立っていればエラー表示
    if (window._fujinMsalLoadFailed) {
      if (window.parent !== window) return;  // iframe内はスキップ
      document.addEventListener("DOMContentLoaded", function() {
        // showLogin相当の表示
        document.body.className = "_fujin_login_box";
        document.body.innerHTML = '<div class="card"><h1>FUJIN</h1><div class="sub">花岡車輌株式会社 生産管理ダッシュボード</div><div class="err">認証ライブラリ (MSAL.js) をどのCDNからも読み込めませんでした。<br>社内ネットワークでブロックされている可能性があります。<br>システム管理者に下記URLが社外通信可能か確認を依頼してください:<br><br>・alcdn.msftauth.net<br>・alcdn.msauth.net<br>・unpkg.com<br>・cdn.jsdelivr.net</div></div>';
      }, { once: true });
      return;
    }
    // ロード中: イベント or タイムアウト
    document.addEventListener("_fujinMsalReady", function() {
      if (typeof msal !== "undefined") _fujinStartAuth();
      else if (window.parent === window) {
        document.body.className = "_fujin_login_box";
        document.body.innerHTML = '<div class="card"><h1>FUJIN</h1><div class="sub">花岡車輌株式会社 生産管理ダッシュボード</div><div class="err">認証ライブラリを読み込めませんでした。社内ネットワーク管理者に CDN へのアクセス可否を確認してください。</div></div>';
      }
    }, { once: true });
    // 10秒タイムアウト
    setTimeout(function() {
      if (typeof msal === "undefined" && window.parent === window) {
        if (document.body) {
          document.body.className = "_fujin_login_box";
          document.body.innerHTML = '<div class="card"><h1>FUJIN</h1><div class="sub">花岡車輌株式会社 生産管理ダッシュボード</div><div class="err">認証ライブラリ読み込みがタイムアウトしました (10秒)。ネットワーク接続を確認してください。</div></div>';
        }
      }
    }, 10000);
  }
  // DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _waitAndStart, { once: true });
  } else {
    _waitAndStart();
  }
})();
</script>
<!-- ============ 認証ゲート ここまで ============ -->
"""

def inject_auth(html, client_id, tenant_id):
    """既存HTMLの<head>に認証ゲートスクリプトを挿入"""
    gate = AUTH_GATE_SCRIPT.replace("__CLIENT_ID__", client_id).replace("__TENANT_ID__", tenant_id)
    if "</head>" in html:
        return html.replace("</head>", gate + "\n</head>", 1)
    # <head>がない場合は冒頭に挿入
    return gate + "\n" + html

# 対象ファイル: FUJIN.html のみ認証ゲート挿入（雅さん指示 2026-04-27 案A）
# iframe先(results_production / today / order_tracking)は認証なし。
# Azure ADのリダイレクトURI登録もFUJIN.htmlの1本だけで済む。
TARGETS_AUTH = ["FUJIN.html"]
# 認証なしでそのままコピーするファイル
# 固定エイリアスを採用(build_enhanced_summary.pyが results_production.html を出力する)
import glob as _glob
_rp_xlsx = sorted(_glob.glob(str(ROOT / "results_production_*.xlsx")), key=lambda p: Path(p).stat().st_mtime, reverse=True)
RESULTS_HTML = "results_production.html"
RESULTS_XLSX = Path(_rp_xlsx[0]).name if _rp_xlsx else None
TARGETS_PLAIN = [
    RESULTS_HTML,
    "today.html",
    "order_tracking.html",
    "stock_detective.html",  # 在庫探偵タブ(検索バー+iframe呼出のみ)
    "usage.html",            # 使い方ガイドタブ
    "orphan_items.js",        # 構成なし品目データ(在庫探偵モーダル用)
    "work_instruction.html",  # 作業指示タブ
    "work_instructions.js",   # 作業指示データ(手配+BOM+作業区)
    "stock_diff.html",        # 在庫前日比アラート (その他メニューから)
    "phase2_diff.html",       # Phase 2 ビフォーアフター差分 (検証用)
    "phase2_diff.json",       # Phase 2 差分データ
    "seiban_progress.html",   # 製番進捗タブ
    "seiban_progress.js",     # 製番進捗データ (HTMLが直接読込、file://でも動作)
    # 2026-05-18 アップロードサイズ削減のため除外:
    # ・seiban_progress.json (.jsと同内容、HTML側は.jsを読む)
    # ・seiban_graph.html / .js (大塚商会回答待ち、UIロジック未確定。雅さん環境ローカル検証用は別途)
]
# ディレクトリごとコピーする対象
TARGETS_DIRS = [
    "stock_snapshots",  # 在庫日次スナップショット + _last_diff.json
]

print(f"=== FUJIN 認証ゲート挿入処理 ===")
print(f"Tenant ID: {TENANT_ID}")
print(f"Client ID: {CLIENT_ID}")
print(f"出力先: {OUT}")
print()

import shutil
count_auth = 0
count_plain = 0

# 認証ゲート挿入対象（FUJIN.html のみ）
print("[認証ゲート挿入]")
for fname in TARGETS_AUTH:
    src = ROOT / fname
    if not src.exists():
        print(f"  ⚠ {fname}: 存在せずスキップ")
        continue
    html = src.read_text(encoding="utf-8")
    new_html = inject_auth(html, CLIENT_ID, TENANT_ID)
    out_path = OUT / fname
    out_path.write_text(new_html, encoding="utf-8")
    print(f"  🔐 {fname} ({len(html):,} → {len(new_html):,} chars)")
    count_auth += 1

# 認証なしでそのままコピー（iframe先のHTML群）
# ROOT直下になければ static/ フォルダをフォールバックとして使用
# （GitHub Actions では ROOT に静的ファイルがないため static/ から取得）
STATIC_DIR = ROOT / "static"
print("\n[そのままコピー(iframe先・親FUJIN.htmlの認証で保護)]")
for fname in TARGETS_PLAIN:
    src = ROOT / fname
    if not src.exists() and STATIC_DIR.exists():
        src = STATIC_DIR / fname
    if not src.exists():
        print(f"  ⚠ {fname}: 存在せずスキップ")
        continue
    shutil.copy2(src, OUT / fname)
    print(f"  📄 {fname} ({src.stat().st_size:,} bytes)")
    count_plain += 1

# XLSX (動的)
if RESULTS_XLSX:
    xlsx_src = ROOT / RESULTS_XLSX
    if xlsx_src.exists():
        shutil.copy2(xlsx_src, OUT / RESULTS_XLSX)
        print(f"  📋 {RESULTS_XLSX} ({xlsx_src.stat().st_size:,} bytes)")

# ディレクトリコピー
count_dirs = 0
print("\n[ディレクトリコピー]")
for dname in TARGETS_DIRS:
    src_dir = ROOT / dname
    if not src_dir.exists():
        print(f"  ⚠ {dname}/: 存在せずスキップ")
        continue
    dst_dir = OUT / dname
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)
    files = list(dst_dir.glob("*"))
    print(f"  📂 {dname}/ ({len(files)}ファイル)")
    count_dirs += 1

print()
print(f"=== 完了: 認証付き{count_auth}本 / プレーン{count_plain}本 / ディレクトリ{count_dirs}個 ===")
print(f"次のステップ: {OUT} の中身を GitHub の hanaoka-apps/hanaoka-ops にアップロード")
print(f"")
print(f"📌 Azure AD リダイレクトURI登録（1本だけ）:")
print(f"    https://hanaoka-apps.github.io/hanaoka-ops/FUJIN.html")
print(f"")
print(f"📌 アクセスURL:")
print(f"    https://hanaoka-apps.github.io/hanaoka-ops/FUJIN.html")
