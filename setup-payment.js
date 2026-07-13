/**
 * 支払指図リスト AP_PaymentInstruction を hanaoka-ap サイトに作成（Ph3/Ph4の器）。
 * 1行＝「1支払先×決済回×手段」の1回の支払。確定済みの経費・突合済みの仕入・定期支払から集約生成し、
 * 承認（安部→碓井→福田／将来 室長→社長）を経て、Ph4でEB(全銀120B)・でんさいCSVを出力する。
 *   node setup-payment.js          … ドライラン（存在確認）
 *   node setup-payment.js create   … 作成（既にあればスキップ・列は追記）
 * ※既存リストには触りません。
 */
const { PublicClientApplication } = require('@azure/msal-node');
const CONFIG={tenantId:'3933e8a0-c945-4e97-ae67-c82131087cad',clientId:'d338d61b-01dc-4c7c-ac6b-aecf7f30d716',
  host:'hanaokacorp.sharepoint.com',site:'hanaoka-ap',ep:'https://graph.microsoft.com/v1.0',scopes:['https://graph.microsoft.com/Sites.Manage.All']};
async function getToken(){const p=new PublicClientApplication({auth:{clientId:CONFIG.clientId,authority:`https://login.microsoftonline.com/${CONFIG.tenantId}`}});
  const r=await p.acquireTokenByDeviceCode({scopes:CONFIG.scopes,deviceCodeCallback:x=>{console.log('\n開く:',x.verificationUri,'\nコード:',x.userCode,'\n');}});return r.accessToken;}
async function g(t,m,p,b=null){const r=await fetch(CONFIG.ep+p,{method:m,headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:b?JSON.stringify(b):null});const x=await r.text();if(!r.ok)throw new Error(`[${r.status}] ${p}\n${x}`);return x?JSON.parse(x):{};}
async function addCol(t,sid,lid,c){try{await g(t,'POST',`/sites/${sid}/lists/${lid}/columns`,c);process.stdout.write('.');}catch(e){if(/nameAlreadyExists|already exists/.test(e.message))process.stdout.write('_');else throw e;}}
const col={
  text:(name,displayName,indexed=false)=>({name,displayName,indexed,text:{}}),
  textMulti:(name,displayName)=>({name,displayName,text:{allowMultipleLines:true,linesForEditing:4}}),
  number:(name,displayName)=>({name,displayName,number:{decimalPlaces:'none',displayAs:'number'}}),
  choice:(name,displayName,choices,indexed=false)=>({name,displayName,indexed,choice:{choices,displayAs:'dropDownMenu'}}),
  bool:(name,displayName)=>({name,displayName,boolean:{}}),
};
const COLS=[
  col.text('TargetYM','決済月',true),
  col.choice('PayDateType','支払日区分',['10日','20日','月末'],true),
  col.text('PayDate','実支払日'),                 // 営業日調整後 YYYY-MM-DD
  col.text('PayeeName','支払先名'),
  col.text('PayeeCode','支払先コード',true),
  col.choice('PayMethod','支払手段',['総合振込','でんさい','口座振替','海外送金','現金'],true),
  col.number('Amount','支払額'),
  col.number('OffsetDeduct','相殺控除'),
  col.textMulti('SourceInvoiceIDs','元請求書ID'),   // 合算元（複数）
  col.choice('Location','拠点',['本社','工場']),
  // 振込先スナップショット（AP_VendorBankから生成時に固定＝承認後の改ざん検知にも）
  col.text('BankCode','銀行コード'),
  col.text('BranchCode','支店コード'),
  col.text('AcctType','預金種目'),
  col.text('AcctNo','口座番号'),
  col.text('AcctHolder','受取人カナ'),
  // 承認（安部→碓井→福田／将来 室長→社長）
  col.choice('ApprovalStatus','承認状態',['起票','安部確認済','碓井確認済','福田承認済','室長確認済','社長承認済','差戻し'],true),
  col.text('ApprovedBy','最終承認者'),
  col.text('ApprovedAt','最終承認日時'),
  col.textMulti('ApprovalLog','承認履歴'),
  col.textMulti('RejectReason','差戻し理由'),
  col.choice('PayStatus','支払状態',['未','EB出力済','支払済'],true),
  col.text('EbOutAt','EB出力日時'),
  col.textMulti('Note','メモ'),
];
async function main(){
  const CREATE=(process.argv[2]||'').toLowerCase()==='create';
  console.log(CREATE?'【作成実行】':'【ドライラン】');
  const t=await getToken();
  const s=await g(t,'GET',`/sites/${CONFIG.host}:/sites/${CONFIG.site}`);console.log('サイト:',s.displayName);
  const lists=await g(t,'GET',`/sites/${s.id}/lists?$select=id,displayName`);
  let l=lists.value.find(x=>x.displayName==='AP_PaymentInstruction');
  console.log('AP_PaymentInstruction:', l?'既存':'新規作成', ` 列${COLS.length}`);
  if(!CREATE){console.log('\nℹ️ 実行: node setup-payment.js create\n');return;}
  if(!l){const d=await g(t,'POST',`/sites/${s.id}/lists`,{displayName:'AP_PaymentInstruction',description:'支払指図（決済回ごと・承認・EB/でんさい出力）Ph3/Ph4',list:{template:'genericList'}});l={id:d.id};console.log('✅ リスト作成');}
  process.stdout.write(`  列追加 (${COLS.length}) `);
  for(const c of COLS) await addCol(t,s.id,l.id,c);
  console.log(' 完了\n✅ AP_PaymentInstruction 準備OK。次に支払一覧＋承認(Ph3)を作ります。');
}
main().catch(e=>{console.error('❌',e.message);process.exit(1);});
