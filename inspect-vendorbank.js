/**
 * AP_VendorBank（振込先口座マスタ）の列と先頭サンプルを確認する（全銀120B出力の項目マッピング用）。
 *   node inspect-vendorbank.js
 * ※読むだけ。何も変更しません。
 */
const { PublicClientApplication } = require('@azure/msal-node');
const C={tenantId:'3933e8a0-c945-4e97-ae67-c82131087cad',clientId:'d338d61b-01dc-4c7c-ac6b-aecf7f30d716',
  host:'hanaokacorp.sharepoint.com',site:'hanaoka-ap',ep:'https://graph.microsoft.com/v1.0',scopes:['https://graph.microsoft.com/Sites.Manage.All']};
async function tok(){const p=new PublicClientApplication({auth:{clientId:C.clientId,authority:`https://login.microsoftonline.com/${C.tenantId}`}});
  const r=await p.acquireTokenByDeviceCode({scopes:C.scopes,deviceCodeCallback:x=>{console.log('\n開く:',x.verificationUri,'\nコード:',x.userCode,'\n');}});return r.accessToken;}
async function g(t,p){const r=await fetch(C.ep+p,{headers:{Authorization:'Bearer '+t}});const x=await r.text();if(!r.ok)throw new Error(`[${r.status}] ${p}\n${x}`);return x?JSON.parse(x):{};}
async function main(){
  const t=await tok();
  const s=await g(t,`/sites/${C.host}:/sites/${C.site}`);
  const lists=await g(t,`/sites/${s.id}/lists?$select=id,displayName`);
  const L=lists.value.find(x=>x.displayName==='AP_VendorBank');
  if(!L){console.log('❌ AP_VendorBank が見つかりません。リスト一覧：',lists.value.map(x=>x.displayName).join(' / '));return;}
  const cols=await g(t,`/sites/${s.id}/lists/${L.id}/columns?$select=name,displayName`);
  console.log('=== AP_VendorBank 列（内部名 / 表示名）===');
  cols.value.filter(c=>!c.readOnly).forEach(c=>console.log(`  ${c.name}  /  ${c.displayName}`));
  const items=await g(t,`/sites/${s.id}/lists/${L.id}/items?$expand=fields&$top=3`);
  console.log('\n=== 先頭サンプル最大3件 ===');
  (items.value||[]).forEach((it,i)=>{console.log(`--- ${i+1} ---`);Object.entries(it.fields).forEach(([k,v])=>{if(/^(id|@|ContentType|_|Attachments|Edit|LinkTitle|odata)/i.test(k))return;console.log(`  ${k}: ${v}`);});});
  console.log('\n件数確認のためもう一度 top=1 で total は取得しませんが、上のサンプルで列名を確認できます。');
}
main().catch(e=>{console.error('❌',e.message);process.exit(1);});
