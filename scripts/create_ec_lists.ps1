<#
  EC売上アプリの履歴用 SharePoint リスト（EC_Order・EC_Log）を作る
  ------------------------------------------------------------
  EC売上アプリは、注文の状態・確認OK・受注№・変更の記録を、各自のブラウザではなく
  SharePoint のリストに持つ。このスクリプトは、そのリストと列を作る（Microsoft Graph）。
  お客様の名前・住所・電話はリストに入れない（注文番号と状態・日時・人だけ）。

  リストを置くサイトと名前は ec_sales_config.json の sharepoint.lists から読む（このファイルには書かない）。
  何度実行しても安全（あるリストは作り直さず、足りない列だけを足す。消すことはしない）。

  必要なもの
    PowerShell 7 (pwsh) と Microsoft Graph PowerShell (Microsoft.Graph.Authentication)
    サイトのリストを作る権限（SharePoint のサイト管理者、または Sites.Manage.All に同意できる人）。
    サインインのときに同意を求められたら、管理者として同意する。

  手順
    1) 何を作るかを見る（サインインも書き込みもしない）
         pwsh -File scripts/create_ec_lists.ps1 -Offline
    2) 今あるものと突き合わせて、足りないものを見る（サインインする。書き込まない）
         pwsh -File scripts/create_ec_lists.ps1
    3) 作る
         pwsh -File scripts/create_ec_lists.ps1 -Apply
    4) 作ったあと（手作業）：リストの権限を、EC担当と管理者だけに絞る
         リスト右上の「設定」→「リストの設定」→「このリストに対するアクセス許可」→「アクセス許可の継承を停止」。
         （注文番号と状態が入る。サイト全員には見せない）
#>
param(
  [switch]$Offline,
  [switch]$Apply,
  [string]$Config = (Join-Path $PSScriptRoot '..\ec_sales_config.json'),
  [string]$TenantId
)
$ErrorActionPreference = 'Stop'

# ---------- 設定（ec_sales_config.json の sharepoint.lists） ----------
$conf = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$lists = $conf.sharepoint.lists
if (-not $lists -or -not $lists.sitePath -or -not $lists.order -or -not $lists.log) {
  throw "ec_sales_config.json に sharepoint.lists（sitePath・order・log）がありません: $Config"
}

# ---------- 列の定義 ----------
function Col-Text($name, $disp, [bool]$multi = $false, [bool]$indexed = $false) {
  $t = @{}
  if ($multi) { $t = @{ allowMultipleLines = $true; textType = 'plain' } }
  $c = @{ name = $name; displayName = $disp; text = $t }
  if ($indexed) { $c.indexed = $true }
  $c
}
function Col-Date($name, $disp, [bool]$withTime = $true) {
  @{ name = $name; displayName = $disp; dateTime = @{ format = $(if ($withTime) { 'dateTime' } else { 'dateOnly' }) } }
}
function Col-Choice($name, $disp, [string[]]$choices, [bool]$indexed = $false) {
  $c = @{ name = $name; displayName = $disp; choice = @{ allowTextEntry = $false; choices = $choices; displayAs = 'dropDown' } }
  if ($indexed) { $c.indexed = $true }
  $c
}
function Col-Bool($name, $disp) { @{ name = $name; displayName = $disp; boolean = @{} } }
function Col-Number($name, $disp) { @{ name = $name; displayName = $disp; number = @{ decimalPlaces = 'none' } } }

# 状態・操作の選択肢は、アプリ（ec_sales.html）と同じ言葉にする
$StatusChoices = @('未確認', 'OK済', '取込中', '突合待ち', '確認待ち', '起票済み', '要確認', '対象外')
$ActionChoices = @('OK', 'OK取消', '出荷予定日変更', '社内メモ追記', '取込依頼', '取込結果', '突合結果', '確認OK', '報告送信', '報告失敗', 'テスト送信', 'その他')

$Definitions = @(
  @{
    name    = $lists.order
    comment = '1注文＝1行。タイトル列に注文番号（Shopify の注文番号。# なし）を入れる'
    columns = @(
      (Col-Date 'OrderDate' '受注日' $false),
      (Col-Text 'CustomerCode' '得意先コード'),
      (Col-Choice 'Status' '状態' $StatusChoices $true),
      (Col-Text 'BatchId' '取込バッチ' $false $true),
      (Col-Text 'SmileOrderNo' 'SMILE受注№'),
      (Col-Date 'ShipDate' '出荷予定日' $false),
      (Col-Bool 'ShipDateManual' '出荷予定日を手動で変更'),
      (Col-Text 'MemoNote' '社内メモ追記'),
      (Col-Number 'NetTotal' '税抜合計'),
      (Col-Text 'OkBy' 'OKした人'),
      (Col-Date 'OkAt' 'OK日時'),
      (Col-Text 'ImportBy' '取込を依頼した人'),
      (Col-Date 'ImportAt' '取込依頼日時'),
      (Col-Text 'ConfirmBy' '確認OKした人'),
      (Col-Date 'ConfirmAt' '確認OK日時'),
      (Col-Date 'ReportedAt' 'Teams報告日時'),
      (Col-Text 'Note' '備考' $true)
    )
  },
  @{
    name    = $lists.log
    comment = '操作の記録。1操作＝1行（追記のみ。消さない）'
    columns = @(
      (Col-Date 'LogTime' '日時'),
      (Col-Text 'Actor' '操作した人'),
      (Col-Text 'OrderNo' '注文番号' $false $true),
      (Col-Choice 'Action' '操作' $ActionChoices $true),
      (Col-Text 'BatchId' '取込バッチ'),
      (Col-Text 'Detail' '内容' $true)
    )
  }
)

# ---------- 確認だけ（サインインしない） ----------
if ($Offline) {
  foreach ($d in $Definitions) {
    Write-Host ("リスト {0}（{1}）" -f $d.name, $d.comment)
    foreach ($c in $d.columns) {
      $kind = ($c.Keys | Where-Object { $_ -in 'text', 'dateTime', 'choice', 'boolean', 'number' }) -join ''
      Write-Host ("  {0,-16} {1,-12} {2}" -f $c.name, $c.displayName, $kind)
    }
  }
  Write-Host ("サイト: {0}" -f $lists.sitePath)
  return
}

# ---------- Graph ----------
Import-Module Microsoft.Graph.Authentication
$connect = @{ Scopes = @('Sites.Manage.All'); NoWelcome = $true }
if ($TenantId) { $connect.TenantId = $TenantId }
Connect-MgGraph @connect

function Graph($method, $uri, $body = $null) {
  $p = @{ Method = $method; Uri = "https://graph.microsoft.com/v1.0$uri"; OutputType = 'PSObject' }
  if ($null -ne $body) { $p.Body = ($body | ConvertTo-Json -Depth 12); $p.ContentType = 'application/json; charset=utf-8' }
  Invoke-MgGraphRequest @p
}

$site = Graph GET "/sites/$($lists.sitePath)"
Write-Host ("サイト: {0}（{1}）" -f $site.displayName, $site.webUrl)
if (-not $Apply) { Write-Host '（確認のみ。作るときは -Apply を付ける）' }

foreach ($d in $Definitions) {
  $found = @((Graph GET "/sites/$($site.id)/lists?`$filter=displayName eq '$($d.name)'&`$select=id,displayName").value)
  if ($found.Count -eq 0) {
    Write-Host ("[作る]   リスト {0}（列 {1} 個）" -f $d.name, $d.columns.Count)
    if ($Apply) {
      $body = @{ displayName = $d.name; list = @{ template = 'genericList' }; columns = $d.columns }
      $made = Graph POST "/sites/$($site.id)/lists" $body
      Write-Host ("         作りました: {0}" -f $made.webUrl)
    }
    continue
  }
  $listId = $found[0].id
  $have = @((Graph GET "/sites/$($site.id)/lists/$listId/columns?`$select=name").value | ForEach-Object { $_.name })
  Write-Host ("[ある]   リスト {0}" -f $d.name)
  foreach ($c in $d.columns) {
    if ($have -contains $c.name) { Write-Host ("         列 {0}: あり" -f $c.name); continue }
    Write-Host ("[足す]   列 {0}（{1}）" -f $c.name, $c.displayName)
    if ($Apply) { [void](Graph POST "/sites/$($site.id)/lists/$listId/columns" $c) }
  }
}

if ($Apply) {
  # 注文番号（タイトル列）は重複させない。うまくいかなくても致命的ではないので、失敗したら知らせるだけ
  $order = @((Graph GET "/sites/$($site.id)/lists?`$filter=displayName eq '$($lists.order)'&`$select=id").value)[0]
  try {
    $title = @((Graph GET "/sites/$($site.id)/lists/$($order.id)/columns?`$filter=name eq 'Title'").value)[0]
    [void](Graph PATCH "/sites/$($site.id)/lists/$($order.id)/columns/$($title.id)" @{ indexed = $true; enforceUniqueValues = $true })
    Write-Host 'タイトル列（注文番号）を、重複不可・インデックスありにしました'
  } catch {
    Write-Warning ("タイトル列を重複不可にできませんでした。リストの設定から手で行ってください: {0}" -f $_.Exception.Message)
  }
  Write-Host ''
  Write-Host '次に手作業：リストの権限を、EC担当と管理者だけに絞ってください（手順はこのファイルの先頭）。'
}
