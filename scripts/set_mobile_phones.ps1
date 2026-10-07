<#
  会社貸与の携帯番号を Entra の「携帯電話」(mobilePhone) に入れる
  ------------------------------------------------------------
  組織図・連絡先ページは Entra の mobilePhone を読んで表示する。
  番号はここ(Entra)にだけ置き、HTML やリポジトリには書かない。

  必要なもの
    PowerShell 7 (pwsh) と Microsoft Graph PowerShell
      Install-Module Microsoft.Graph.Users -Scope CurrentUser

  手順
    1) 対応表を作る（Entra を読むだけ。何も書き換えない）
         pwsh scripts/set_mobile_phones.ps1 -Prepare -Source "C:\...\一括登録用フォーマット.csv"
       → data/携帯_対応表.csv ができる（data/ は .gitignore 済み。PUKコードは写さない）
         ・一覧の氏名で Entra の表示名を前方一致で探し、1人に決まれば UPN を入れる
         ・決まらないものは UPN を空のまま、候補 列に候補を並べる
         ・ポケットWiFi は 区分=載せない、「共有」を含むものは 区分=共用
    2) data/携帯_対応表.csv を Excel で開き、UPN 列を確認・記入する
         ・共用の番号は、その番号を持たせるアカウント(共有メールボックスなど)の UPN を入れる
         ・載せない行、UPN が空の行は何もしない
    3) 確認（書き換えない。今の値 → 新しい値 を表示するだけ）
         pwsh scripts/set_mobile_phones.ps1
    4) 書き込む
         pwsh scripts/set_mobile_phones.ps1 -Apply
#>
param(
  [switch]$Prepare,
  [string]$Source,
  [switch]$Apply,
  [string]$Map = (Join-Path $PSScriptRoot '..\data\携帯_対応表.csv')
)
$ErrorActionPreference = 'Stop'
$TenantId = '3933e8a0-c945-4e97-ae67-c82131087cad'
# Users を先に読み込む。Connect-MgGraph が先だと新しい版の Authentication が読み込まれ、
# 版の違う Users が「同じ名前のアセンブリが読み込み済み」で読めなくなるため
Import-Module Microsoft.Graph.Users

# 携帯会社の一覧は先頭の0が落ちた10桁(7014240967)。070-1424-0967 の形にそろえる
function Format-Phone([string]$s) {
  $d = ($s -replace '\D', '')
  if ($d.Length -eq 10 -and $d[0] -ne '0') { $d = '0' + $d }
  if ($d.Length -eq 11) { return '{0}-{1}-{2}' -f $d.Substring(0, 3), $d.Substring(3, 4), $d.Substring(7, 4) }
  return $s.Trim()
}

if ($Prepare) {
  if (-not $Source) { throw '-Source に携帯会社の一括登録用CSVを指定してください' }
  Connect-MgGraph -TenantId $TenantId -Scopes 'User.Read.All' -NoWelcome

  # 元のCSVは Shift_JIS。列は 電話番号,SIM種別,氏名,氏名（カナ）,部署名(1),…,機種名(23列目)
  $text = [System.IO.File]::ReadAllText($Source, [System.Text.Encoding]::GetEncoding(932))
  $rows = $text | ConvertFrom-Csv
  $cols = $rows[0].PSObject.Properties.Name   # 見出し名に頼らず位置で読む
  $users = Get-MgUser -All -Property 'displayName,userPrincipalName,department,accountEnabled,userType' |
    Where-Object { $_.UserType -eq 'Member' }

  $out = foreach ($r in $rows) {
    $phone = "$($r.($cols[0]))"
    if (-not $phone.Trim()) { continue }
    $name = "$($r.($cols[2]))".Trim()
    $kind = if ($name -match 'WIFI|ワイファイ') { '載せない' } elseif ($name -match '共有') { '共用' } else { '個人' }
    $upn = ''; $cand = ''
    if ($kind -eq '個人') {
      $key = $name -replace '\s', ''
      $hits = @($users | Where-Object { $_.AccountEnabled -and (($_.DisplayName -replace '\s', '') -like "$key*") })
      if ($hits.Count -eq 1) { $upn = $hits[0].UserPrincipalName }
      else { $cand = ($hits | ForEach-Object { "$($_.DisplayName) <$($_.UserPrincipalName)> $($_.Department)" }) -join ' | ' }
      if ($hits.Count -eq 0) { $cand = '（見つからない）' }
    }
    [pscustomobject]@{
      電話番号   = Format-Phone $phone
      一覧の氏名 = $name
      一覧の部署 = "$($r.($cols[4]))".Trim()
      機種       = "$($r.($cols[22]))".Trim()
      区分       = $kind
      UPN        = $upn
      候補       = $cand
    }
  }
  New-Item -ItemType Directory -Force (Split-Path $Map) | Out-Null
  $out | Export-Csv $Map -Encoding utf8BOM -NoTypeInformation
  $n = @($out).Count; $ok = @($out | Where-Object UPN).Count
  Write-Host "対応表を作りました: $Map  ($n 行、UPN 決定 $ok 行)。Excel で UPN 列を確認してください。"
  return
}

# ---- 確認 / 書き込み ----
if (-not (Test-Path $Map)) { throw "対応表がありません: $Map （先に -Prepare を実行）" }
$scope = if ($Apply) { 'User.ReadWrite.All' } else { 'User.Read.All' }
Connect-MgGraph -TenantId $TenantId -Scopes $scope -NoWelcome

$rows = Import-Csv $Map -Encoding utf8 | Where-Object { $_.区分 -ne '載せない' -and $_.UPN.Trim() }
$dup = $rows | Group-Object { $_.UPN.Trim().ToLower() } | Where-Object Count -gt 1
if ($dup) { throw "同じ UPN が複数行にあります: $($dup.Name -join ', ')" }

foreach ($r in $rows) {
  $upn = $r.UPN.Trim(); $new = Format-Phone $r.電話番号
  $u = Get-MgUser -UserId $upn -Property 'displayName,mobilePhone'
  $cur = "$($u.MobilePhone)"
  if ($cur -eq $new) { Write-Host "  そのまま  $($u.DisplayName)  $new"; continue }
  if ($Apply) {
    Update-MgUser -UserId $upn -MobilePhone $new
    Write-Host "  更新      $($u.DisplayName)  '$cur' → '$new'"
  } else {
    Write-Host "  変更予定  $($u.DisplayName)  '$cur' → '$new'"
  }
}
if (-not $Apply) { Write-Host "`n確認のみです。書き込むときは -Apply を付けて実行してください。" }
